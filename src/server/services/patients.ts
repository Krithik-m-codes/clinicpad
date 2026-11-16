import { and, asc, desc, eq, ilike, isNull, like, or } from "drizzle-orm";
import { fail, invalidFrom, ok, type Ok, type Result, type ServiceError } from "@/lib/result";
import { can } from "@/lib/domain/permissions";
import { normalizePhone } from "@/lib/domain/phone";
import { sameName } from "@/lib/domain/names";
import { isUuid } from "@/lib/domain/ids";
import { patients } from "@/server/db/schema";
import { withTenant } from "@/server/db/tenant";
import { patientInputSchema, type PatientInput } from "@/server/validation/patient";
import type { ServiceContext } from "./context";
import { allocateNumber } from "./numbering";
import { recordAudit } from "./audit";

export type DuplicateCandidate = {
  id: string;
  patientNo: number | null;
  name: string;
  phone: string | null;
  sameName: boolean;
};

export type CreatePatientResult =
  | Ok<{ id: string; patientNo: number }>
  | ServiceError
  | { ok: false; code: "duplicate_candidates"; message: string; candidates: DuplicateCandidate[] };

export type PatientListItem = {
  id: string;
  patientNo: number | null;
  name: string;
  phone: string | null;
  gender: string | null;
  dob: string | null;
  createdAt: Date;
};

export type PatientRecord = typeof patients.$inferSelect;

const LIST_COLUMNS = {
  id: patients.id,
  patientNo: patients.patientNo,
  name: patients.name,
  phone: patients.phone,
  gender: patients.gender,
  dob: patients.dob,
  createdAt: patients.createdAt,
};

const notFound = () => fail("not_found", "Patient not found.");

const MAX_QUERY_LENGTH = 100;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const MAX_OFFSET = 10_000;

/** Whole number clamped into [min, max]; NaN falls back to `fallback`; +/-Infinity clamp to the bounds. */
function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function toColumns(input: PatientInput) {
  return {
    name: input.name,
    phone: input.phone ?? null,
    phoneNormalized: input.phone ? normalizePhone(input.phone) : null,
    gender: input.gender,
    dob: input.dob ?? null,
    address: input.address ?? null,
    allergies: input.allergies,
    notes: input.notes ?? null,
  };
}

export async function createPatient(
  ctx: ServiceContext,
  raw: unknown,
  opts: { allowDuplicate?: boolean } = {},
): Promise<CreatePatientResult> {
  if (!can(ctx.role, "patient.write")) return fail("forbidden", "You cannot register patients.");
  const parsed = patientInputSchema.safeParse(raw);
  if (!parsed.success) return invalidFrom(parsed.error);
  const input = parsed.data;
  const columns = toColumns(input);

  return withTenant(ctx.tenantId, async (tx): Promise<CreatePatientResult> => {
    if (columns.phoneNormalized && !opts.allowDuplicate) {
      const matches = await tx
        .select({ id: patients.id, patientNo: patients.patientNo, name: patients.name, phone: patients.phone })
        .from(patients)
        .where(and(eq(patients.phoneNormalized, columns.phoneNormalized), isNull(patients.deletedAt)))
        // Every match shares the exact normalized phone; newest first, id as the tiebreaker, so the
        // five shown are always the same five.
        .orderBy(desc(patients.createdAt), desc(patients.id))
        .limit(5);
      if (matches.length > 0) {
        return {
          ok: false,
          code: "duplicate_candidates",
          message: "A patient with this phone number already exists.",
          candidates: matches.map((m) => ({ ...m, sameName: sameName(m.name, input.name) })),
        };
      }
    }

    const patientNo = await allocateNumber(tx, ctx.tenantId, "patient");
    const [row] = await tx
      .insert(patients)
      .values({ ...columns, tenantId: ctx.tenantId, patientNo, createdBy: ctx.userId })
      .returning({ id: patients.id });
    await recordAudit(tx, ctx, {
      action: "patient.created",
      entityType: "patient",
      entityId: row.id,
      after: { patientNo },
    });
    return ok({ id: row.id, patientNo });
  });
}

/**
 * Search active patients in the caller's clinic by name, phone digits or patient number.
 *
 * - `q` is trimmed and truncated to 100 characters. A `q` containing a NUL byte matches nothing
 *   (empty list), because Postgres cannot compare against it.
 * - `limit` is clamped to 1..100 (default 25); `offset` to 0..10000. Non-finite values never throw.
 * - Ordering is total, so offset pages never skip or repeat rows: a query sorts by name then id;
 *   an empty query lists newest first (created_at desc, id desc).
 */
export async function searchPatients(
  ctx: ServiceContext,
  opts: { q?: string; limit?: number; offset?: number } = {},
): Promise<Result<PatientListItem[]>> {
  if (!can(ctx.role, "patient.read")) return fail("forbidden", "You cannot view patients.");

  const term = (opts.q ?? "").trim().slice(0, MAX_QUERY_LENGTH);
  if (term.includes("\u0000")) return ok([]);
  const limit = clampInt(opts.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const offset = clampInt(opts.offset, 0, MAX_OFFSET, 0);
  const conditions = [isNull(patients.deletedAt)];
  if (term) {
    const matchers = [ilike(patients.name, `%${escapeLike(term)}%`)];
    if (/^[\d\s+()-]+$/.test(term)) {
      const digits = term.replace(/\D/g, "");
      if (digits.length >= 3) {
        matchers.push(like(patients.phoneNormalized, `%${normalizePhone(term) ?? digits}%`));
      }
      if (digits.length >= 1 && digits.length <= 7) {
        matchers.push(eq(patients.patientNo, Number(digits)));
      }
    }
    conditions.push(or(...matchers)!);
  }

  const rows = await withTenant(ctx.tenantId, (tx) =>
    tx
      .select(LIST_COLUMNS)
      .from(patients)
      .where(and(...conditions))
      .orderBy(...(term ? [asc(patients.name), asc(patients.id)] : [desc(patients.createdAt), desc(patients.id)]))
      .limit(limit)
      .offset(offset),
  );
  return ok(rows);
}

export async function getPatient(ctx: ServiceContext, id: string): Promise<Result<PatientRecord>> {
  if (!can(ctx.role, "patient.read")) return fail("forbidden", "You cannot view patients.");
  if (!isUuid(id)) return notFound();
  const [row] = await withTenant(ctx.tenantId, (tx) =>
    tx
      .select()
      .from(patients)
      .where(and(eq(patients.id, id), isNull(patients.deletedAt)))
      .limit(1),
  );
  return row ? ok(row) : notFound();
}

/**
 * FULL REPLACE. `raw` is the whole patient form, not a patch: any optional field that is omitted
 * or blank is cleared (phone, dob, address, notes become null; allergies becomes []; gender
 * resets to "unknown"). Callers must submit the complete record, or they will erase data such as
 * allergies. The audit event records field names only, so cleared values are not recoverable
 * from it. Returns the names of the fields whose stored value actually changed.
 */
export async function updatePatient(
  ctx: ServiceContext,
  id: string,
  raw: unknown,
): Promise<Result<{ changedFields: string[] }>> {
  if (!can(ctx.role, "patient.write")) return fail("forbidden", "You cannot edit patients.");
  if (!isUuid(id)) return notFound();
  const parsed = patientInputSchema.safeParse(raw);
  if (!parsed.success) return invalidFrom(parsed.error);
  const next = toColumns(parsed.data);

  return withTenant(ctx.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(patients)
      .where(and(eq(patients.id, id), isNull(patients.deletedAt)))
      .limit(1);
    if (!existing) return notFound();

    const current = {
      name: existing.name,
      phone: existing.phone ?? null,
      gender: existing.gender ?? "unknown",
      dob: existing.dob ?? null,
      address: existing.address ?? null,
      allergies: existing.allergies ?? [],
      notes: existing.notes ?? null,
    };
    const proposed = {
      name: next.name,
      phone: next.phone,
      gender: next.gender,
      dob: next.dob,
      address: next.address,
      allergies: next.allergies,
      notes: next.notes,
    };
    const changedFields = (Object.keys(proposed) as (keyof typeof proposed)[]).filter(
      (key) => JSON.stringify(proposed[key]) !== JSON.stringify(current[key]),
    );
    if (changedFields.length === 0) return ok({ changedFields });

    await tx.update(patients).set(next).where(eq(patients.id, id));
    await recordAudit(tx, ctx, {
      action: "patient.updated",
      entityType: "patient",
      entityId: id,
      after: { changedFields },
    });
    return ok({ changedFields });
  });
}

export async function archivePatient(ctx: ServiceContext, id: string): Promise<Result<null>> {
  if (!can(ctx.role, "patient.archive")) return fail("forbidden", "Only the clinic owner can archive patients.");
  if (!isUuid(id)) return notFound();
  return withTenant(ctx.tenantId, async (tx) => {
    const archived = await tx
      .update(patients)
      .set({ deletedAt: new Date() })
      .where(and(eq(patients.id, id), isNull(patients.deletedAt)))
      .returning({ id: patients.id });
    if (archived.length === 0) return notFound();
    await recordAudit(tx, ctx, { action: "patient.archived", entityType: "patient", entityId: id });
    return ok(null);
  });
}

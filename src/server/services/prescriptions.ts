import { and, asc, count, desc, eq, isNull } from "drizzle-orm";
import { fail, invalidFrom, ok, type Ok, type Result, type ServiceError } from "@/lib/result";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { doctors, patients, prescriptionItems, prescriptions, visits } from "@/server/db/schema";
import { pgErrorInfo } from "@/server/db/errors";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { amendReasonSchema, draftInputSchema } from "@/server/validation/prescription";
import type { ServiceContext } from "./context";
import { allocateNumber } from "./numbering";
import { recordAudit } from "./audit";
import {
  amendVisitValues,
  clinicalSummary,
  copyItems,
  itemValues,
  repeatVisitValues,
  toItemView,
  toVisitView,
  visitColumns,
  type ClinicalVisitView,
  type ItemView,
} from "./rx-mapping";

export type { ClinicalVisitView, ItemView } from "./rx-mapping";

export type PrescriptionView = {
  id: string;
  status: string;
  version: number;
  /** Draft save counter; send it back as `baseRevision`. */
  revision: number;
  rxNo: number | null;
  amendmentReason: string | null;
  parentPrescriptionId: string | null;
  finalizedAt: Date | null;
  /** Read live from the patient row (Plan 1C snapshots it at finalize); allergies are [] when none. */
  patient: { id: string; name: string; patientNo: number | null; allergies: string[] };
  visit: ClinicalVisitView;
  items: ItemView[];
};

/** A save based on an older revision than the one stored. */
export type DraftConflict = ServiceError & { code: "conflict"; currentRevision: number };
export type SaveDraftResult = Ok<{ savedAt: Date; revision: number }> | ServiceError | DraftConflict;

export type PrescriptionSummary = {
  id: string;
  rxNo: number | null;
  version: number;
  status: string;
  chiefComplaint: string | null;
  createdAt: Date;
  finalizedAt: Date | null;
};

const prescriptionNotFound = () => fail("not_found", "Prescription not found.");
const patientNotFound = () => fail("not_found", "Patient not found.");

async function doctorIdFor(tx: TenantTx, userId: string): Promise<string | null> {
  const [doctor] = await tx.select({ id: doctors.id }).from(doctors).where(eq(doctors.userId, userId)).limit(1);
  return doctor?.id ?? null;
}

const BAD_TEXT_MESSAGE = "Some text contains a character that cannot be saved.";
const BAD_DATE_MESSAGE = "Enter a real follow-up date.";

/**
 * Defence in depth behind the validation layer: Postgres refusing a value (SQLSTATE 22021 invalid byte
 * sequence, 22P02/22P05 untranslatable jsonb text, 22007/22008 bad or out-of-range date) is bad input, not a server fault. Returns null for
 * any other error so the caller keeps its own handling.
 */
function invalidFromDatabase(error: unknown, fields: { text?: string; date?: string }): ServiceError | null {
  const { code } = pgErrorInfo(error);
  // 22021 invalid byte sequence (NUL); 22P02 / 22P05 jsonb text it cannot represent (a lone surrogate).
  if (code === "22021" || code === "22P02" || code === "22P05") return fail("invalid", BAD_TEXT_MESSAGE, fields.text);
  if (code === "22007" || code === "22008") return fail("invalid", BAD_DATE_MESSAGE, fields.date);
  return null;
}

export async function startPrescription(
  ctx: ServiceContext,
  input: { patientId: string },
): Promise<Result<{ prescriptionId: string }>> {
  if (!can(ctx.role, "rx.draft")) return fail("forbidden", "Only doctors can write prescriptions.");
  if (!isUuid(input.patientId)) return patientNotFound();

  return withTenant(ctx.tenantId, async (tx) => {
    const [patient] = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.id, input.patientId), isNull(patients.deletedAt)))
      .limit(1);
    if (!patient) return patientNotFound();

    const [visit] = await tx
      .insert(visits)
      .values({
        tenantId: ctx.tenantId,
        patientId: patient.id,
        doctorId: await doctorIdFor(tx, ctx.userId),
        status: "draft",
        visitType: "new",
      })
      .returning({ id: visits.id });
    const [rx] = await tx
      .insert(prescriptions)
      .values({ tenantId: ctx.tenantId, visitId: visit.id, status: "draft", version: 1 })
      .returning({ id: prescriptions.id });
    await recordAudit(tx, ctx, {
      action: "prescription.drafted",
      entityType: "prescription",
      entityId: rx.id,
      after: { version: 1 },
    });
    return ok({ prescriptionId: rx.id });
  });
}

export async function getPrescription(ctx: ServiceContext, id: string): Promise<Result<PrescriptionView>> {
  if (!can(ctx.role, "rx.read")) return fail("forbidden", "You cannot view prescriptions.");
  if (!isUuid(id)) return prescriptionNotFound();

  return withTenant(ctx.tenantId, async (tx) => {
    // READ COMMITTED gives every statement its own snapshot, so a draft save that commits between
    // the row read and the item read could leave a view with the new items under the old visit.
    // Saves bump draft_revision in the same transaction, so a revision that is unchanged after the
    // items were read proves both reads saw one state; otherwise read again.
    for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
      const view = await readSnapshot(tx, id);
      if (view !== "changed") return view;
    }
    return fail("conflict", "This prescription is being saved. Try again in a moment.");
  });
}

const SNAPSHOT_ATTEMPTS = 3;

/** One read of a prescription, or "changed" when a save committed while it was being read. */
async function readSnapshot(tx: TenantTx, id: string): Promise<Result<PrescriptionView> | "changed"> {
  const [row] = await tx
    .select({
      rx: prescriptions,
      visit: visits,
      patient: { id: patients.id, name: patients.name, patientNo: patients.patientNo, allergies: patients.allergies },
    })
    .from(prescriptions)
    .innerJoin(visits, eq(visits.id, prescriptions.visitId))
    .innerJoin(patients, eq(patients.id, visits.patientId))
    .where(eq(prescriptions.id, id))
    .limit(1);
  if (!row) return prescriptionNotFound();

  const items = await tx
    .select()
    .from(prescriptionItems)
    .where(eq(prescriptionItems.prescriptionId, id))
    .orderBy(asc(prescriptionItems.sortOrder));
  const [after] = await tx
    .select({ revision: prescriptions.draftRevision })
    .from(prescriptions)
    .where(eq(prescriptions.id, id))
    .limit(1);
  if (!after || after.revision !== row.rx.draftRevision) return "changed";

  return ok<PrescriptionView>({
    id: row.rx.id,
    status: row.rx.status,
    version: row.rx.version,
    revision: row.rx.draftRevision,
    rxNo: row.rx.rxNo,
    amendmentReason: row.rx.amendmentReason,
    parentPrescriptionId: row.rx.parentPrescriptionId,
    finalizedAt: row.rx.finalizedAt,
    patient: { ...row.patient, allergies: row.patient.allergies ?? [] },
    visit: toVisitView(row.visit),
    items: items.map(toItemView),
  });
}

/**
 * Saves a full draft snapshot. With `baseRevision` the save succeeds only if the stored
 * draft is still at that revision; otherwise it returns `conflict` with the current
 * revision and changes nothing. The row lock serializes concurrent saves, so of two saves
 * from the same revision exactly one wins and items are never mixed.
 */
export async function saveDraft(
  ctx: ServiceContext,
  id: string,
  raw: unknown,
  opts: { baseRevision?: number } = {},
): Promise<SaveDraftResult> {
  if (!can(ctx.role, "rx.draft")) return fail("forbidden", "Only doctors can edit prescriptions.");
  if (!isUuid(id)) return prescriptionNotFound();
  const { baseRevision } = opts;
  if (baseRevision !== undefined && (!Number.isInteger(baseRevision) || baseRevision < 0)) {
    return fail("invalid", "The draft revision is not valid. Reload the page.", "baseRevision");
  }
  const parsed = draftInputSchema.safeParse(raw);
  if (!parsed.success) return invalidFrom(parsed.error);
  const input = parsed.data;

  try {
    return await withTenant(ctx.tenantId, async (tx): Promise<SaveDraftResult> => {
      const [rx] = await tx
        .select({
          id: prescriptions.id,
          status: prescriptions.status,
          visitId: prescriptions.visitId,
          draftRevision: prescriptions.draftRevision,
        })
        .from(prescriptions)
        .where(eq(prescriptions.id, id))
        .limit(1)
        .for("update");
      if (!rx) return prescriptionNotFound();
      if (rx.status !== "draft") {
        return fail("immutable", "This prescription is finalized. Amend it to make changes.");
      }
      if (baseRevision !== undefined && baseRevision !== rx.draftRevision) {
        return {
          ok: false,
          code: "conflict",
          message: "This draft was changed in another window or device.",
          currentRevision: rx.draftRevision,
        };
      }

      // Lock order: the prescription row above, then its visit and items (ADR-0023).
      await tx.update(visits).set(visitColumns(input)).where(eq(visits.id, rx.visitId));
      await tx.delete(prescriptionItems).where(eq(prescriptionItems.prescriptionId, id));
      const items = input.items ?? [];
      if (items.length > 0) {
        await tx.insert(prescriptionItems).values(itemValues(ctx, id, items));
      }
      const [saved] = await tx
        .update(prescriptions)
        .set({ draftRevision: rx.draftRevision + 1, updatedAt: new Date() })
        .where(eq(prescriptions.id, id))
        .returning({ updatedAt: prescriptions.updatedAt, revision: prescriptions.draftRevision });
      return ok({ savedAt: saved.updatedAt, revision: saved.revision });
    });
  } catch (error) {
    // The database refuses changes to finalized records (SQLSTATE 23000); report it as immutable.
    if (pgErrorInfo(error).code === "23000") {
      return fail("immutable", "This prescription is finalized. Amend it to make changes.");
    }
    // The transaction has rolled back, so nothing was written.
    const invalid = invalidFromDatabase(error, { date: "followUpDate" });
    if (invalid) return invalid;
    throw error;
  }
}

export async function listPrescriptionsForPatient(
  ctx: ServiceContext,
  patientId: string,
): Promise<Result<PrescriptionSummary[]>> {
  if (!can(ctx.role, "rx.read")) return fail("forbidden", "You cannot view prescriptions.");
  if (!isUuid(patientId)) return patientNotFound();

  return withTenant(ctx.tenantId, async (tx) => {
    const [patient] = await tx.select({ id: patients.id }).from(patients).where(eq(patients.id, patientId)).limit(1);
    if (!patient) return patientNotFound();

    const rows = await tx
      .select({
        id: prescriptions.id,
        rxNo: prescriptions.rxNo,
        version: prescriptions.version,
        status: prescriptions.status,
        chiefComplaint: visits.chiefComplaint,
        createdAt: prescriptions.createdAt,
        finalizedAt: prescriptions.finalizedAt,
      })
      .from(prescriptions)
      .innerJoin(visits, eq(visits.id, prescriptions.visitId))
      .where(eq(visits.patientId, patientId))
      .orderBy(desc(prescriptions.createdAt), desc(prescriptions.id));
    return ok(rows);
  });
}

const IMMUTABLE_MESSAGE = "This prescription is finalized and cannot be changed.";
const AMENDMENT_IN_PROGRESS = "An amendment is already in progress.";
const OPEN_AMENDMENT_INDEX = "prescriptions_one_open_amendment";

export async function finalizePrescription(
  ctx: ServiceContext,
  id: string,
  opts: { expectedRevision?: number } = {},
): Promise<Result<{ rxNo: number; version: number }>> {
  if (!can(ctx.role, "rx.finalize")) return fail("forbidden", "Only doctors can finalize prescriptions.");
  if (!isUuid(id)) return prescriptionNotFound();

  try {
    return await withTenant(ctx.tenantId, async (tx): Promise<Result<{ rxNo: number; version: number }>> => {
      // The row lock comes first: it serializes double-clicks and racing autosaves (the second request waits,
      // then sees "finalized"), and it must precede any visit or item write. Two lock orders exist (ADR-0023,
      // AGENTS.md section 10): writers lock prescription -> items/visit, and finalizing an amendment locks the
      // child and then the parent. The second is safe because amendPrescription never writes while a child is open.
      const [rx] = await tx.select().from(prescriptions).where(eq(prescriptions.id, id)).limit(1).for("update");
      if (!rx) return prescriptionNotFound();
      if (rx.status !== "draft") return fail("conflict", "This prescription is already finalized.");
      // Finalize exactly the revision the doctor saw: a save from another window in between wins.
      if (opts.expectedRevision !== undefined && rx.draftRevision !== opts.expectedRevision) {
        return fail("conflict", "This draft changed after you last saw it. Review it, then finalize again.");
      }

      const [{ value: itemCount }] = await tx
        .select({ value: count() })
        .from(prescriptionItems)
        .where(eq(prescriptionItems.prescriptionId, id));
      if (itemCount === 0) return fail("invalid", "Add at least one medicine before finalizing.", "items");
      const [visit] = await tx.select().from(visits).where(eq(visits.id, rx.visitId)).limit(1);

      // First versions (no parent) get the next number; amendments must already carry their parent's.
      // An amendment without a number means a corrupt chain: refuse rather than allocate a second number
      // for the same prescription. Allocating only after every check passes, inside this transaction,
      // means a failed finalize never burns a number.
      let rxNo: number;
      if (rx.parentPrescriptionId === null) {
        rxNo = await allocateNumber(tx, ctx.tenantId, "rx");
      } else if (rx.rxNo === null) {
        return fail("conflict", "The original prescription has no Rx number, so this amendment cannot be finalized.");
      } else {
        rxNo = rx.rxNo;
      }
      const now = new Date();

      await tx
        .update(prescriptions)
        .set({ status: "finalized", rxNo, finalizedAt: now, finalizedBy: ctx.userId })
        .where(eq(prescriptions.id, id));
      // Only status and finalized_at may change on a visit whose prescription is already finalized.
      await tx.update(visits).set({ status: "finalized", finalizedAt: now }).where(eq(visits.id, rx.visitId));
      if (rx.parentPrescriptionId) {
        // The parent flip may change nothing but status. This locks the parent after the child (ADR-0023's
        // second lock order), which is safe because amendPrescription never writes while a child is open.
        await tx
          .update(prescriptions)
          .set({ status: "amended" })
          .where(eq(prescriptions.id, rx.parentPrescriptionId));
      }
      const summary = clinicalSummary(visit, itemCount);
      await recordAudit(tx, ctx, {
        action: rx.parentPrescriptionId ? "prescription.amended" : "prescription.finalized",
        entityType: "prescription",
        entityId: id,
        after: rx.parentPrescriptionId
          ? { rxNo, version: rx.version, parentPrescriptionId: rx.parentPrescriptionId, ...summary }
          : { rxNo, version: rx.version, ...summary },
      });
      return ok({ rxNo, version: rx.version });
    });
  } catch (error) {
    if (pgErrorInfo(error).code === "23000") return fail("immutable", IMMUTABLE_MESSAGE);
    throw error;
  }
}

export async function amendPrescription(
  ctx: ServiceContext,
  input: { prescriptionId: string; reason: string },
): Promise<Result<{ prescriptionId: string; version: number }>> {
  if (!can(ctx.role, "rx.amend")) return fail("forbidden", "Only doctors can amend prescriptions.");
  if (!isUuid(input.prescriptionId)) return prescriptionNotFound();
  const reason = amendReasonSchema.safeParse(input.reason);
  if (!reason.success) return fail("invalid", reason.error.issues[0].message, "reason");

  try {
    return await withTenant(ctx.tenantId, async (tx): Promise<Result<{ prescriptionId: string; version: number }>> => {
      // Lock the parent first. Every check below returns before any write: finalizing an amendment locks the
      // child and then the parent, so writing here while a child is open could deadlock (ADR-0023).
      const [source] = await tx
        .select()
        .from(prescriptions)
        .where(eq(prescriptions.id, input.prescriptionId))
        .limit(1)
        .for("update");
      if (!source) return prescriptionNotFound();
      if (source.status === "draft") return fail("conflict", "A draft cannot be amended; edit it directly.");
      if (source.status !== "finalized") {
        return fail("conflict", "A newer version of this prescription already exists.");
      }

      const [open] = await tx
        .select({ id: prescriptions.id })
        .from(prescriptions)
        .where(and(eq(prescriptions.parentPrescriptionId, source.id), eq(prescriptions.status, "draft")))
        .limit(1);
      if (open) return fail("conflict", AMENDMENT_IN_PROGRESS);

      // Writes start here. amendVisitValues copies every visit column (the new clinical ones included).
      const [oldVisit] = await tx.select().from(visits).where(eq(visits.id, source.visitId)).limit(1);
      const [newVisit] = await tx.insert(visits).values(amendVisitValues(oldVisit)).returning({ id: visits.id });
      const [rx] = await tx
        .insert(prescriptions)
        .values({
          tenantId: ctx.tenantId,
          visitId: newVisit.id,
          rxNo: source.rxNo,
          version: source.version + 1,
          status: "draft",
          parentPrescriptionId: source.id,
          amendmentReason: reason.data,
          templateVersionId: source.templateVersionId,
        })
        .returning({ id: prescriptions.id, version: prescriptions.version });
      await copyItems(tx, ctx, source.id, rx.id);
      // The reason is free text and lives on the prescription row; the audit log keeps only its length.
      await recordAudit(tx, ctx, {
        action: "prescription.amendment_drafted",
        entityType: "prescription",
        entityId: rx.id,
        before: { version: source.version },
        after: { version: rx.version, parentPrescriptionId: source.id, reasonLength: reason.data.length },
      });
      return ok({ prescriptionId: rx.id, version: rx.version });
    });
  } catch (error) {
    // The partial unique index is the backstop for a race the row lock did not catch. Any other
    // unique violation is a different bug and must surface, not be reported as "in progress".
    const info = pgErrorInfo(error);
    if (info.code === "23505" && info.constraint === OPEN_AMENDMENT_INDEX) {
      return fail("conflict", AMENDMENT_IN_PROGRESS);
    }
    // Only the reason is new free text here (the rest is copied from rows that already passed the database).
    const invalid = invalidFromDatabase(error, { text: "reason" });
    if (invalid) return invalid;
    throw error;
  }
}

export async function repeatPrescription(
  ctx: ServiceContext,
  id: string,
): Promise<Result<{ prescriptionId: string }>> {
  if (!can(ctx.role, "rx.draft")) return fail("forbidden", "Only doctors can write prescriptions.");
  if (!isUuid(id)) return prescriptionNotFound();

  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ prescriptionId: string }>> => {
    const [source] = await tx.select().from(prescriptions).where(eq(prescriptions.id, id)).limit(1);
    if (!source) return prescriptionNotFound();
    if (source.status === "draft") return fail("conflict", "Finalize this draft before repeating it.");
    // A superseded version holds exactly the content an amendment corrected; never copy it forward.
    if (source.status !== "finalized") {
      return fail("conflict", "This prescription was superseded by a later version; repeat the latest version.");
    }

    const [oldVisit] = await tx.select().from(visits).where(eq(visits.id, source.visitId)).limit(1);
    const [patient] = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.id, oldVisit.patientId), isNull(patients.deletedAt)))
      .limit(1);
    if (!patient) return patientNotFound();

    const [newVisit] = await tx
      .insert(visits)
      .values(repeatVisitValues(oldVisit, await doctorIdFor(tx, ctx.userId)))
      .returning({ id: visits.id });
    const [rx] = await tx
      .insert(prescriptions)
      .values({ tenantId: ctx.tenantId, visitId: newVisit.id, status: "draft", version: 1 })
      .returning({ id: prescriptions.id });
    await copyItems(tx, ctx, source.id, rx.id);
    await recordAudit(tx, ctx, {
      action: "prescription.drafted",
      entityType: "prescription",
      entityId: rx.id,
      after: { version: 1, repeatedFrom: source.id },
    });
    return ok({ prescriptionId: rx.id });
  });
}

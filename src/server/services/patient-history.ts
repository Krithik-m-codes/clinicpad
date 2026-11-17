import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { escapeLike } from "@/lib/domain/search";
import { cleanText } from "@/lib/domain/text";
import { fail, ok, type Result } from "@/lib/result";
import { doctors, patients, prescriptions, visits } from "@/server/db/schema";
import { withTenant } from "@/server/db/tenant";
import { clinicTimeZoneIn } from "./clinic";
import type { ServiceContext } from "./context";

export const HISTORY_PAGE_SIZE = 20;
export const HISTORY_STATUSES = ["draft", "finalized", "amended"] as const;
export type HistoryStatus = (typeof HISTORY_STATUSES)[number];
export type HistoryFilters = { from?: string; to?: string; doctor?: string; status?: HistoryStatus; q?: string; offset: number };
export type HistoryRow = {
  id: string;
  rxNo: number | null;
  version: number;
  status: string;
  chiefComplaint: string | null;
  diagnosis: string[];
  doctorName: string | null;
  createdAt: Date;
  finalizedAt: Date | null;
};
export type HistoryDoctor = { id: string; name: string };
export type HistoryPage = { rows: HistoryRow[]; hasMore: boolean; filters: HistoryFilters; doctors: HistoryDoctor[]; timeZone: string };

const MAX_OFFSET = 10_000;
const MAX_QUERY = 60;
/** A repeated query parameter arrives as an array: use the first value. */
const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);
const realDay = (v: string) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && v >= "1900-01-01" && v <= "2100-12-31";
};
const day = z.preprocess(first, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(realDay).optional()).catch(undefined);

/** URL filters. A malformed value is ignored (treated as absent), never an error: these come from the address bar. */
const historyFiltersSchema = z.object({
  from: day,
  to: day,
  doctor: z.preprocess(first, z.string().refine(isUuid).optional()).catch(undefined),
  status: z.preprocess(first, z.enum(HISTORY_STATUSES).optional()).catch(undefined),
  // cleanText is the search-term cleaner (it removes NUL and controls; a search term is not stored).
  q: z.preprocess(first, z.string().transform((v) => cleanText(v).trim().slice(0, MAX_QUERY)).optional()).catch(undefined),
  offset: z.preprocess(first, z.coerce.number().int().min(0).max(MAX_OFFSET).optional()).catch(undefined),
});

export function parseHistoryFilters(raw: unknown): HistoryFilters {
  const parsed = historyFiltersSchema.safeParse(raw !== null && typeof raw === "object" ? raw : {});
  const f = parsed.success ? parsed.data : {};
  let from = f.from;
  let to = f.to;
  if (from && to && from > to) [from, to] = [to, from];
  return { from, to, doctor: f.doctor, status: f.status, q: f.q ? f.q : undefined, offset: f.offset ?? 0 };
}

/**
 * One patient's prescriptions, every version, newest first by finalize time (drafts by creation time), filtered and
 * paginated. Date filters are calendar days in the clinic's timezone. An archived patient is visible only to roles
 * that may archive (the owner), like getPatient.
 */
export async function listPatientPrescriptions(ctx: ServiceContext, patientId: string, raw: unknown): Promise<Result<HistoryPage>> {
  if (!can(ctx.role, "rx.read")) return fail("forbidden", "You cannot view prescriptions.");
  if (!isUuid(patientId)) return fail("not_found", "Patient not found.");
  const filters = parseHistoryFilters(raw);

  return withTenant(ctx.tenantId, async (tx): Promise<Result<HistoryPage>> => {
    const [patient] = await tx
      .select({ id: patients.id, deletedAt: patients.deletedAt })
      .from(patients)
      .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, patientId)))
      .limit(1);
    if (!patient || (patient.deletedAt !== null && !can(ctx.role, "patient.archive"))) return fail("not_found", "Patient not found.");

    const timeZone = await clinicTimeZoneIn(tx, ctx.tenantId);
    const when = sql`coalesce(${prescriptions.finalizedAt}, ${prescriptions.createdAt})`;
    const conditions: SQL[] = [eq(prescriptions.tenantId, ctx.tenantId), eq(visits.patientId, patientId)];
    // Local midnight of the day, as an instant: (date)::timestamp AT TIME ZONE zone.
    if (filters.from) conditions.push(sql`${when} >= (${filters.from}::date)::timestamp at time zone ${timeZone}`);
    if (filters.to) conditions.push(sql`${when} < ((${filters.to}::date) + 1)::timestamp at time zone ${timeZone}`);
    if (filters.doctor) conditions.push(eq(visits.doctorId, filters.doctor));
    if (filters.status) conditions.push(eq(prescriptions.status, filters.status));
    if (filters.q) {
      const pattern = `%${escapeLike(filters.q)}%`;
      conditions.push(or(ilike(visits.chiefComplaint, pattern), sql`array_to_string(${visits.diagnosis}, ' ') ilike ${pattern}`) as SQL);
    }

    const rows = await tx
      .select({
        id: prescriptions.id,
        rxNo: prescriptions.rxNo,
        version: prescriptions.version,
        status: prescriptions.status,
        chiefComplaint: visits.chiefComplaint,
        diagnosis: visits.diagnosis,
        doctorName: doctors.displayName,
        createdAt: prescriptions.createdAt,
        finalizedAt: prescriptions.finalizedAt,
      })
      .from(prescriptions)
      .innerJoin(visits, eq(visits.id, prescriptions.visitId))
      .leftJoin(doctors, eq(doctors.id, visits.doctorId))
      .where(and(...conditions))
      // Total order, so offset pages never repeat or skip a row.
      .orderBy(desc(when), desc(prescriptions.id))
      .limit(HISTORY_PAGE_SIZE + 1)
      .offset(filters.offset);

    const doctorRows = await tx
      .selectDistinct({ id: doctors.id, name: doctors.displayName })
      .from(visits)
      .innerJoin(doctors, eq(doctors.id, visits.doctorId))
      .where(and(eq(visits.tenantId, ctx.tenantId), eq(visits.patientId, patientId)));

    return ok({
      rows: rows.slice(0, HISTORY_PAGE_SIZE).map((r) => ({ ...r, diagnosis: r.diagnosis ?? [] })),
      hasMore: rows.length > HISTORY_PAGE_SIZE,
      filters,
      doctors: doctorRows
        .map((d) => ({ id: d.id, name: d.name?.trim() ? d.name.trim() : "Doctor without a printed name" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      timeZone,
    });
  });
}

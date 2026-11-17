import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { can } from "@/lib/domain/permissions";
import { clinicLocalDate } from "@/lib/domain/clinic-date";
import { fail, ok, type Result } from "@/lib/result";
import { decodeCsvBytes } from "@/lib/import/decode";
import { checkMapping, suggestMapping, type ColumnMapping } from "@/lib/import/patient-columns";
import { IMPORT_LIMITS, IMPORT_MESSAGES, parseImportTable, type ImportTable } from "@/lib/import/patient-rows";
import { patientImports, patients } from "@/server/db/schema";
import { pgErrorInfo } from "@/server/db/errors";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import type { PatientInput } from "@/server/validation/patient";
import { recordAudit, recordAuditMany } from "./audit";
import { clinicTimeZoneIn } from "./clinic";
import type { ServiceContext } from "./context";
import { allocateNumbers } from "./numbering";
import {
  analyse,
  buildReport,
  canFill,
  chunks,
  emptyTotals,
  type Analysed,
  type CommitSummary,
  type ImportDecision,
  type ImportReport,
} from "./patient-import-analysis";
import { toPatientColumns } from "./patients";

export type { CommitSummary, DuplicateMatch, ImportDecision, ImportReport, ImportRowReport, ImportTotals } from "./patient-import-analysis";
export { importRowKey, NEW_ROW_PREVIEW } from "./patient-import-analysis";

const FORBIDDEN = "Only the clinic owner can import patients.";
const NO_FILE = "Choose a CSV file first.";
const FILE_CHANGED = "The file changed since it was checked. Check it again before importing.";
const CONCURRENT = "Patients changed while importing. Check the file again.";
const BAD_DECISIONS = "The duplicate choices are not valid. Check the file again.";

const decisionsSchema = z
  .record(z.string().regex(/^\d{1,6}$/), z.enum(["skip", "create", "fill"]))
  .refine((d) => Object.keys(d).length <= IMPORT_LIMITS.maxRows);

function loadTable(bytes: Uint8Array): Result<{ table: ImportTable; sha256: string }> {
  if (bytes.byteLength === 0) return fail("invalid", NO_FILE, "file");
  if (bytes.byteLength > IMPORT_LIMITS.maxBytes) return fail("invalid", IMPORT_MESSAGES.tooLarge, "file");
  const decoded = decodeCsvBytes(bytes);
  if (!decoded.ok) return fail("invalid", decoded.message, "file");
  const parsed = parseImportTable(decoded.text);
  if (!parsed.ok) return fail("invalid", parsed.message, "file");
  return ok({ table: parsed.table, sha256: createHash("sha256").update(bytes).digest("hex") });
}

/** No mapping sent (first check): the suggestion. Otherwise the owner's mapping, checked against the file. */
function mappingFor(raw: unknown, table: ImportTable): Result<ColumnMapping> {
  if (raw === undefined || raw === null) return ok(suggestMapping(table.headers));
  const checked = checkMapping(raw, table.headers.length);
  return checked.ok ? ok(checked.mapping) : fail("invalid", checked.message, "mapping");
}


/** Checks a file without writing anything: mapping (suggested on the first call), problems, duplicates, new rows. */
export async function dryRunPatientImport(ctx: ServiceContext, file: { bytes: Uint8Array }, rawMapping?: unknown): Promise<Result<ImportReport>> {
  if (!can(ctx.role, "patient.import")) return fail("forbidden", FORBIDDEN);
  const loaded = loadTable(file.bytes);
  if (!loaded.ok) return loaded;
  const { table, sha256 } = loaded.value;
  const mapping = mappingFor(rawMapping, table);
  if (!mapping.ok) return mapping;
  if (mapping.value.name === null) {
    return ok({ fileSha256: sha256, headers: table.headers, mapping: mapping.value, ageColumns: [], needsName: true, totals: emptyTotals(), rows: [] });
  }
  return withTenant(ctx.tenantId, async (tx) => {
    const today = clinicLocalDate(new Date(), await clinicTimeZoneIn(tx, ctx.tenantId));
    return ok(buildReport(sha256, table, mapping.value, await analyse(tx, ctx.tenantId, table, mapping.value, today)));
  });
}

type FillPlan = { patientId: string; set: Partial<typeof patients.$inferInsert>; changedFields: string[] };

/** Only empty details of the matched patient are filled; nothing that is already recorded is ever overwritten. */
async function planFill(tx: TenantTx, tenantId: string, patientId: string, input: PatientInput): Promise<FillPlan> {
  const plan: FillPlan = { patientId, set: {}, changedFields: [] };
  const [current] = await tx
    .select()
    .from(patients)
    .where(and(eq(patients.tenantId, tenantId), eq(patients.id, patientId), isNull(patients.deletedAt)))
    .limit(1)
    .for("update");
  if (!current) return plan;
  const next = toPatientColumns(input);
  if (!current.dob && next.dob) {
    plan.set.dob = next.dob;
    plan.changedFields.push("dob");
  }
  if ((current.gender ?? "unknown") === "unknown" && next.gender !== "unknown") {
    plan.set.gender = next.gender;
    plan.changedFields.push("gender");
  }
  if (!current.address && next.address) {
    plan.set.address = next.address;
    plan.changedFields.push("address");
  }
  if ((current.allergies ?? []).length === 0 && next.allergies.length > 0) {
    plan.set.allergies = next.allergies;
    plan.changedFields.push("allergies");
  }
  if (!current.notes && next.notes) {
    plan.set.notes = next.notes;
    plan.changedFields.push("notes");
  }
  return plan;
}

/**
 * Imports the checked file in ONE transaction, under a per-clinic advisory lock (a double-click or a second tab
 * waits, then finds the rows as already imported). Rows are re-classified now; a duplicate is created or filled only
 * when the owner chose so and the choice is still allowed; everything else is skipped. Patient numbers come as one
 * block; every patient gets a `patient.created` event carrying the import id, every fill a `patient.updated` event
 * with field names, and the job a `patient_import.committed` event with counts.
 */
export async function commitPatientImport(
  ctx: ServiceContext,
  file: { bytes: Uint8Array },
  input: { mapping: unknown; decisions: unknown; expectedSha256: unknown },
): Promise<Result<CommitSummary>> {
  if (!can(ctx.role, "patient.import")) return fail("forbidden", FORBIDDEN);
  const loaded = loadTable(file.bytes);
  if (!loaded.ok) return loaded;
  const { table, sha256 } = loaded.value;
  if (input.expectedSha256 !== sha256) return fail("conflict", FILE_CHANGED, "file");
  const mapping = mappingFor(input.mapping ?? {}, table);
  if (!mapping.ok) return mapping;
  const decisions = decisionsSchema.safeParse(input.decisions ?? {});
  if (!decisions.success) return fail("invalid", BAD_DECISIONS, "decisions");
  const choice = (row: number): ImportDecision => decisions.data[String(row)] ?? "skip";

  try {
    return await withTenant(ctx.tenantId, async (tx): Promise<Result<CommitSummary>> => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`clinicpad:patient-import:${ctx.tenantId}`}, 0))`);
      const today = clinicLocalDate(new Date(), await clinicTimeZoneIn(tx, ctx.tenantId));
      const rows = await analyse(tx, ctx.tenantId, table, mapping.value, today);

      const toCreate = rows.filter(
        (r): r is Extract<Analysed, { status: "new" | "duplicate" }> =>
          r.status === "new" || (r.status === "duplicate" && !r.exactRepeat && choice(r.row) === "create"),
      );
      const plans: FillPlan[] = [];
      for (const r of rows) {
        if (r.status === "duplicate" && canFill(r) && choice(r.row) === "fill") plans.push(await planFill(tx, ctx.tenantId, r.matches[0].id, r.input));
      }
      const fills = plans.filter((p) => p.changedFields.length > 0);
      const alreadyImported = rows.filter((r) => r.status === "already_imported").length;
      const invalid = rows.filter((r) => r.status === "invalid").length;
      const skipped = rows.length - toCreate.length - fills.length - alreadyImported - invalid;

      const [job] = await tx
        .insert(patientImports)
        .values({
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          fileSha256: sha256,
          rowCount: rows.length,
          createdCount: toCreate.length,
          filledCount: fills.length,
          skippedCount: skipped,
          alreadyImportedCount: alreadyImported,
          invalidCount: invalid,
        })
        .returning({ id: patientImports.id });

      let first: number | null = null;
      if (toCreate.length > 0) {
        const start = await allocateNumbers(tx, ctx.tenantId, "patient", toCreate.length);
        first = start;
        const values = toCreate.map((r, i) => ({
          ...toPatientColumns(r.input),
          tenantId: ctx.tenantId,
          patientNo: start + i,
          createdBy: ctx.userId,
          importId: job.id,
          importRowKey: r.key,
        }));
        for (const chunk of chunks(values)) {
          const inserted = await tx.insert(patients).values(chunk).returning({ id: patients.id, patientNo: patients.patientNo });
          await recordAuditMany(
            tx,
            ctx,
            inserted.map((p) => ({ action: "patient.created", entityType: "patient", entityId: p.id, after: { patientNo: p.patientNo, importId: job.id } })),
          );
        }
      }
      for (const plan of fills) {
        await tx.update(patients).set(plan.set).where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, plan.patientId)));
        await recordAudit(tx, ctx, { action: "patient.updated", entityType: "patient", entityId: plan.patientId, after: { changedFields: plan.changedFields, importId: job.id } });
      }
      const summary = { created: toCreate.length, filled: fills.length, skipped, alreadyImported, invalid };
      await recordAudit(tx, ctx, { action: "patient_import.committed", entityType: "patient_import", entityId: job.id, after: { rowCount: rows.length, ...summary } });
      return ok({
        importId: job.id,
        ...summary,
        firstPatientNo: first,
        lastPatientNo: first === null ? null : first + toCreate.length - 1,
      });
    });
  } catch (error) {
    // The advisory lock serializes imports; a unique violation means someone else wrote the same rows anyway.
    if (pgErrorInfo(error).code === "23505") return fail("conflict", CONCURRENT);
    throw error;
  }
}


import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { nameKey, sameName } from "@/lib/domain/names";
import { normalizePhone } from "@/lib/domain/phone";
import { invalidFrom } from "@/lib/result";
import { ageColumns, IMPORT_FIELDS, type ColumnMapping, type ImportField } from "@/lib/import/patient-columns";
import { rowValues, type ImportTable } from "@/lib/import/patient-rows";
import { patients } from "@/server/db/schema";
import type { TenantTx } from "@/server/db/tenant";
import { DOB_FUTURE_MESSAGE, patientInputSchema, type PatientInput } from "@/server/validation/patient";

// Classification of an import file against the clinic's patients (reads only). Used by the dry-run and the commit.

export type ImportDecision = "skip" | "create" | "fill";
export type DuplicateMatch = { patientNo: number | null; name: string; sameName: boolean };
export type ImportRowReport =
  | { row: number; status: "new"; name: string; dob: string | null }
  | { row: number; status: "already_imported"; name: string }
  | { row: number; status: "duplicate"; name: string; matches: DuplicateMatch[]; duplicateOfRow: number | null; canFill: boolean; canCreate: boolean }
  | { row: number; status: "invalid"; field: ImportField | "row"; message: string; cells: string[] };
export type ImportTotals = { rows: number; new: number; duplicate: number; alreadyImported: number; invalid: number };
export type ImportReport = {
  fileSha256: string;
  headers: string[];
  mapping: ColumnMapping;
  /** Unmapped age columns: shown as "not imported" (a birth date is never invented from an age). */
  ageColumns: string[];
  /** No name column recognised: the owner must choose one; nothing was analysed. */
  needsName: boolean;
  totals: ImportTotals;
  /** Every problem, every duplicate, every already-imported row, and the first NEW_ROW_PREVIEW new rows. */
  rows: ImportRowReport[];
};
export type CommitSummary = {
  importId: string;
  created: number;
  filled: number;
  skipped: number;
  alreadyImported: number;
  invalid: number;
  firstPatientNo: number | null;
  lastPatientNo: number | null;
};

export const NEW_ROW_PREVIEW = 20;
const MAX_MATCHES = 3;
const CHUNK = 500;

type Prepared = { row: number; input: PatientInput; phone: string | null; key: string };
type Match = DuplicateMatch & { id: string };
type Invalid = { row: number; status: "invalid"; field: ImportField | "row"; message: string; cells: string[] };
export type Analysed =
  | (Prepared & { status: "new" })
  | (Prepared & { status: "already_imported" })
  | (Prepared & { status: "duplicate"; matches: Match[]; duplicateOfRow: number | null; exactRepeat: boolean })
  | Invalid;
type Duplicate = Extract<Analysed, { status: "duplicate" }>;

const FIELD_NAMES = new Set<string>(IMPORT_FIELDS);
const asField = (field: string | undefined): ImportField | "row" => (field !== undefined && FIELD_NAMES.has(field) ? (field as ImportField) : "row");
export const canFill = (r: Duplicate) => r.duplicateOfRow === null && r.matches.length === 1 && r.matches[0].sameName;

export function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/** The same person in the same file or on a re-run: name key, normalized phone, DOB. Stored on the patient. */
export function importRowKey(name: string, phone: string | null, dob: string | null): string {
  return createHash("sha256").update(`${nameKey(name)}\u001f${phone ?? ""}\u001f${dob ?? ""}`, "utf8").digest("hex");
}


/** One row through the Excel repairs, the patient form's own schema, and the clinic-day DOB rule. */
function prepare(record: { row: number; cells: string[] }, mapping: ColumnMapping, today: string): Prepared | Invalid {
  const invalid = (field: ImportField | "row", message: string): Invalid => ({ row: record.row, status: "invalid", field, message, cells: record.cells });
  const values = rowValues(record.cells, mapping);
  if (!values.ok) return invalid(values.field, values.message);
  const parsed = patientInputSchema.safeParse(values.values);
  if (!parsed.success) {
    const error = invalidFrom(parsed.error);
    return invalid(asField(error.field), error.message);
  }
  const input = parsed.data;
  if (input.dob && input.dob > today) return invalid("dob", DOB_FUTURE_MESSAGE);
  const phone = input.phone ? normalizePhone(input.phone) : null;
  return { row: record.row, input, phone, key: importRowKey(input.name, phone, input.dob ?? null) };
}

/** Classifies every row against this clinic's patients and the earlier rows of the file. Reads only. */
export async function analyse(tx: TenantTx, tenantId: string, table: ImportTable, mapping: ColumnMapping, today: string): Promise<Analysed[]> {
  const prepared = table.rows.map((r) => prepare(r, mapping, today));
  const valid = prepared.filter((r): r is Prepared => !("status" in r));

  const imported = new Set<string>();
  for (const keys of chunks([...new Set(valid.map((r) => r.key))])) {
    const rows = await tx
      .select({ key: patients.importRowKey })
      .from(patients)
      .where(and(eq(patients.tenantId, tenantId), inArray(patients.importRowKey, keys)));
    for (const r of rows) if (r.key) imported.add(r.key);
  }

  const byPhone = new Map<string, Omit<Match, "sameName">[]>();
  for (const phones of chunks([...new Set(valid.map((r) => r.phone).filter((p): p is string => p !== null))])) {
    const rows = await tx
      .select({ id: patients.id, patientNo: patients.patientNo, name: patients.name, phone: patients.phoneNormalized })
      .from(patients)
      .where(and(eq(patients.tenantId, tenantId), isNull(patients.deletedAt), inArray(patients.phoneNormalized, phones)))
      .orderBy(desc(patients.createdAt), desc(patients.id));
    for (const r of rows) {
      if (!r.phone) continue;
      byPhone.set(r.phone, [...(byPhone.get(r.phone) ?? []), { id: r.id, patientNo: r.patientNo, name: r.name }]);
    }
  }

  const firstByKey = new Map<string, number>();
  const firstByPhone = new Map<string, number>();
  return prepared.map((r): Analysed => {
    if ("status" in r) return r;
    if (imported.has(r.key)) return { ...r, status: "already_imported" };
    const repeatOf = firstByKey.get(r.key) ?? null;
    const phoneRepeatOf = r.phone !== null ? (firstByPhone.get(r.phone) ?? null) : null;
    if (repeatOf === null) firstByKey.set(r.key, r.row);
    if (r.phone !== null && phoneRepeatOf === null) firstByPhone.set(r.phone, r.row);
    const matches = (r.phone !== null ? (byPhone.get(r.phone) ?? []) : []).map((m) => ({ ...m, sameName: sameName(m.name, r.input.name) }));
    const duplicateOfRow = repeatOf ?? phoneRepeatOf;
    if (matches.length === 0 && duplicateOfRow === null) return { ...r, status: "new" };
    return { ...r, status: "duplicate", matches, duplicateOfRow, exactRepeat: repeatOf !== null };
  });
}

export function emptyTotals(): ImportTotals {
  return { rows: 0, new: 0, duplicate: 0, alreadyImported: 0, invalid: 0 };
}

export function buildReport(sha256: string, table: ImportTable, mapping: ColumnMapping, rows: Analysed[]): ImportReport {
  const totals = { ...emptyTotals(), rows: rows.length };
  const out: ImportRowReport[] = [];
  let preview = 0;
  for (const r of rows) {
    if (r.status === "invalid") {
      totals.invalid += 1;
      out.push(r);
    } else if (r.status === "already_imported") {
      totals.alreadyImported += 1;
      out.push({ row: r.row, status: r.status, name: r.input.name });
    } else if (r.status === "duplicate") {
      totals.duplicate += 1;
      out.push({
        row: r.row,
        status: "duplicate",
        name: r.input.name,
        matches: r.matches.slice(0, MAX_MATCHES).map((m) => ({ patientNo: m.patientNo, name: m.name, sameName: m.sameName })),
        duplicateOfRow: r.duplicateOfRow,
        canFill: canFill(r),
        canCreate: !r.exactRepeat,
      });
    } else {
      totals.new += 1;
      if (preview < NEW_ROW_PREVIEW) {
        preview += 1;
        out.push({ row: r.row, status: "new", name: r.input.name, dob: r.input.dob ?? null });
      }
    }
  }
  return { fileSha256: sha256, headers: table.headers, mapping, ageColumns: ageColumns(table.headers, mapping), needsName: false, totals, rows: out };
}


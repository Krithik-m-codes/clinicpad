import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { nameKey, sameName } from "@/lib/domain/names";
import { normalizePhone } from "@/lib/domain/phone";
import { invalidFrom } from "@/lib/result";
import { IMPORT_FIELDS, type ColumnMapping, type ImportField } from "@/lib/import/patient-columns";
import { rowValues, type ImportTable } from "@/lib/import/patient-rows";
import { patients } from "@/server/db/schema";
import type { TenantTx } from "@/server/db/tenant";
import { DOB_FUTURE_MESSAGE, patientInputSchema } from "@/server/validation/patient";
import { dobAgrees, type Analysed, type Invalid, type Match, type Prepared } from "./patient-import-report";

// Classification of an import file against the clinic's patients (reads only). Used by the dry-run and the commit.

const CHUNK = 500;
/** Echoed cells of a problem row are capped; a 2,000-character cell must not travel back to the browser. */
const ECHO_CHARS = 200;
const MAX_SOFT_MATCHES = 20;

const clip = (cell: string) => {
  const chars = [...cell];
  return chars.length > ECHO_CHARS ? chars.slice(0, ECHO_CHARS).join("") : cell;
};
const FIELD_NAMES = new Set<string>(IMPORT_FIELDS);
const asField = (field: string | undefined): ImportField | "row" => (field !== undefined && FIELD_NAMES.has(field) ? (field as ImportField) : "row");

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
  const invalid = (field: ImportField | "row", message: string): Invalid => ({ row: record.row, status: "invalid", field, message, cells: record.cells.map(clip) });
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

  const columns = { id: patients.id, patientNo: patients.patientNo, name: patients.name, dob: patients.dob, gender: patients.gender };
  const byPhone = new Map<string, Omit<Match, "sameName">[]>();
  for (const phones of chunks([...new Set(valid.map((r) => r.phone).filter((p): p is string => p !== null))])) {
    const rows = await tx
      .select({ ...columns, phone: patients.phoneNormalized })
      .from(patients)
      .where(and(eq(patients.tenantId, tenantId), isNull(patients.deletedAt), inArray(patients.phoneNormalized, phones)))
      .orderBy(desc(patients.createdAt), desc(patients.id));
    for (const { phone, ...match } of rows) {
      if (phone) byPhone.set(phone, [...(byPhone.get(phone) ?? []), match]);
    }
  }

  // Soft matches: the same name with an equal or empty date of birth, whatever the phone. Without them a re-import
  // with a corrected column mapping (or a row with no phone) would create everyone a second time. The clinic's whole
  // patient list is read once (five narrow columns) because names have no indexed comparison key.
  const byName = new Map<string, Omit<Match, "sameName">[]>();
  if (valid.length > 0) {
    const all = await tx
      .select(columns)
      .from(patients)
      .where(and(eq(patients.tenantId, tenantId), isNull(patients.deletedAt)))
      .orderBy(desc(patients.createdAt), desc(patients.id));
    for (const p of all) {
      const key = nameKey(p.name);
      if (key !== "") byName.set(key, [...(byName.get(key) ?? []), p]);
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
    const byPhoneMatches = (r.phone !== null ? (byPhone.get(r.phone) ?? []) : []).map((m): Match => ({ ...m, sameName: sameName(m.name, r.input.name) }));
    const seen = new Set(byPhoneMatches.map((m) => m.id));
    const soft = (byName.get(nameKey(r.input.name)) ?? [])
      .filter((m) => !seen.has(m.id) && dobAgrees(m.dob, r.input.dob))
      .slice(0, MAX_SOFT_MATCHES)
      .map((m): Match => ({ ...m, sameName: true }));
    const matches = [...byPhoneMatches, ...soft];
    const duplicateOfRow = repeatOf ?? phoneRepeatOf;
    if (matches.length === 0 && duplicateOfRow === null) return { ...r, status: "new" };
    return { ...r, status: "duplicate", matches, duplicateOfRow, exactRepeat: repeatOf !== null };
  });
}

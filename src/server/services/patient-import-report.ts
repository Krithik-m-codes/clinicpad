import { createHash } from "node:crypto";
import { ageColumns, IMPORT_FIELDS, type ColumnMapping, type ImportField } from "@/lib/import/patient-columns";
import type { ImportTable } from "@/lib/import/patient-rows";
import type { PatientInput } from "@/server/validation/patient";

// Types and the report built from an analysed file (no database access).

export type ImportDecision = "skip" | "create" | "fill";
/** An existing patient a row may be the same person as, with both sides' details so the owner can judge. */
export type DuplicateMatch = {
  patientNo: number | null;
  name: string;
  sameName: boolean;
  /** Why it matched: the row's phone is the patient's phone, or only the name (and an equal-or-empty birth date) agrees. */
  basis: "phone" | "name";
  dob: string | null;
  gender: string | null;
};
export type ImportRowReport =
  | { row: number; status: "new"; name: string; dob: string | null }
  | { row: number; status: "already_imported"; name: string }
  | {
      row: number;
      status: "duplicate";
      name: string;
      rowDob: string | null;
      rowGender: string;
      matches: DuplicateMatch[];
      duplicateOfRow: number | null;
      canFill: boolean;
      canCreate: boolean;
      /** What this row matched at check time; commit honours a create/fill choice only while it is unchanged. */
      fingerprint: string;
    }
  | { row: number; status: "invalid"; field: ImportField | "row"; message: string; cells: string[] };
export type ImportTotals = { rows: number; new: number; duplicate: number; alreadyImported: number; invalid: number };
export type ImportReport = {
  fileSha256: string;
  /** Binds the file AND the mapping that was checked; commit refuses anything else. */
  checkToken: string;
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
  /** Rows (first 50) whose matches changed since the check, so the owner's choice was not applied. */
  staleRows: number[];
  staleCount: number;
  firstPatientNo: number | null;
  lastPatientNo: number | null;
};

export const NEW_ROW_PREVIEW = 20;
export const MAX_STALE_LISTED = 50;
export const STALE_REASON = "These rows matched different patients when the file was checked. They were skipped; check the file again.";
const MAX_MATCHES = 3;

export type Match = DuplicateMatch & { id: string; /** The existing patient has a phone on record. */ hasPhone: boolean };
export type Prepared = { row: number; input: PatientInput; phone: string | null; key: string };
export type Invalid = { row: number; status: "invalid"; field: ImportField | "row"; message: string; cells: string[] };
export type Analysed =
  | (Prepared & { status: "new" })
  | (Prepared & { status: "already_imported" })
  | (Prepared & { status: "duplicate"; matches: Match[]; duplicateOfRow: number | null; exactRepeat: boolean })
  | Invalid;
export type Duplicate = Extract<Analysed, { status: "duplicate" }>;

/** Birth dates agree when equal or when either side is not recorded. */
export const dobAgrees = (a: string | null | undefined, b: string | null | undefined) => !a || !b || a === b;
const known = (g: string | null | undefined) => (g && g !== "unknown" ? g : null);
/** Genders agree when equal or when either side is unknown. */
export const genderAgrees = (a: string | null | undefined, b: string | null | undefined) => {
  const [x, y] = [known(a), known(b)];
  return x === null || y === null || x === y;
};

/**
 * A fill is offered for exactly one patient whose date of birth and gender do not contradict the row AND who is
 * the same person on stronger evidence than a name: the phone matches as well (same name), or the patient has no phone
 * and the birth date is recorded on both sides and equal. A name alone can be a namesake (two Rameshes), and a fill
 * could put one person's allergy on the other's record, so name-only matches are skip-only.
 */
export const canFill = (r: Duplicate) => {
  if (r.duplicateOfRow !== null || r.matches.length !== 1) return false;
  const [m] = r.matches;
  if (!m.sameName || !dobAgrees(m.dob, r.input.dob) || !genderAgrees(m.gender, r.input.gender)) return false;
  if (m.basis === "phone") return true;
  return !m.hasPhone && Boolean(m.dob) && m.dob === r.input.dob;
};

/** "Register as new" is never offered for an exact repeat in the file or when any match is by name only (ADR-0039). */
export const canCreate = (r: Duplicate) => !r.exactRepeat && !r.matches.some((m) => m.basis === "name");

export function fingerprintOf(r: Pick<Duplicate, "matches" | "duplicateOfRow">): string {
  const ids = r.matches.map((m) => m.id).sort();
  return createHash("sha256").update(`${ids.join(",")}|${r.duplicateOfRow ?? ""}`, "utf8").digest("hex");
}

export function checkTokenOf(fileSha256: string, mapping: ColumnMapping): string {
  const columns = IMPORT_FIELDS.map((f) => mapping[f]);
  return createHash("sha256").update(`${fileSha256}\u001f${JSON.stringify(columns)}`, "utf8").digest("hex");
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
        rowDob: r.input.dob ?? null,
        rowGender: r.input.gender,
        matches: r.matches.slice(0, MAX_MATCHES).map((m) => ({ patientNo: m.patientNo, name: m.name, sameName: m.sameName, basis: m.basis, dob: m.dob, gender: m.gender })),
        duplicateOfRow: r.duplicateOfRow,
        canFill: canFill(r),
        canCreate: canCreate(r),
        fingerprint: fingerprintOf(r),
      });
    } else {
      totals.new += 1;
      if (preview < NEW_ROW_PREVIEW) {
        preview += 1;
        out.push({ row: r.row, status: "new", name: r.input.name, dob: r.input.dob ?? null });
      }
    }
  }
  return {
    fileSha256: sha256,
    checkToken: checkTokenOf(sha256, mapping),
    headers: table.headers,
    mapping,
    ageColumns: ageColumns(table.headers, mapping),
    needsName: false,
    totals,
    rows: out,
  };
}

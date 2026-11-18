import { IMPORT_LIMITS } from "./patient-rows";

// What the import wizard sends back with the file (kept small: the file plus these fields must fit Next's 1 MB
// server-action body). Only rows the owner changed from the default (skip) are listed, so a file of 5,000
// duplicates sends almost nothing, and even if every row is chosen the text stays under 80 KB.

export type ChoiceDecision = "create" | "fill";
export type ChoiceEntry = { row: number; decision: ChoiceDecision; fingerprint: string };

/** A prefix of the row's match fingerprint: enough to notice that the matches changed since the check. */
export const FINGERPRINT_CHARS = 8;
export const MAX_CHOICES_CHARS = 100_000;
/** A bitmap of every spreadsheet row up to the largest possible row, as base64. */
export const MAX_ROWSET_CHARS = 1_400;

const ENTRY = /^([cf])(\d{1,6})\.([0-9a-f]{8})$/;
const MAX_ROW = IMPORT_LIMITS.maxRows + 1; // row 1 is the header

/** "c12.1a2b3c4d,f40.5e6f7a8b": one entry per row whose choice is not the default. */
export function encodeChoices(entries: ChoiceEntry[]): string {
  return entries.map((e) => `${e.decision === "create" ? "c" : "f"}${e.row}.${e.fingerprint.slice(0, FINGERPRINT_CHARS)}`).join(",");
}

/** Strict: any malformed entry, a repeated row or too many entries refuses the whole field (null). */
export function decodeChoices(raw: unknown): Map<number, { decision: ChoiceDecision; fingerprint: string }> | null {
  if (raw === undefined || raw === null || raw === "") return new Map();
  if (typeof raw !== "string" || raw.length > MAX_CHOICES_CHARS) return null;
  const out = new Map<number, { decision: ChoiceDecision; fingerprint: string }>();
  for (const part of raw.split(",")) {
    const m = ENTRY.exec(part);
    if (!m) return null;
    const row = Number(m[2]);
    if (row > MAX_ROW || out.has(row)) return null;
    out.set(row, { decision: m[1] === "c" ? "create" : "fill", fingerprint: m[3] });
  }
  return out.size <= IMPORT_LIMITS.maxRows ? out : null;
}

/** The rows that were duplicates when the file was checked, as a base64 bitmap (row n is bit n). */
export function encodeRowSet(rows: number[]): string {
  if (rows.length === 0) return "";
  const bytes = new Uint8Array(Math.floor(Math.max(...rows) / 8) + 1);
  for (const row of rows) bytes[Math.floor(row / 8)] |= 1 << (row % 8);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function decodeRowSet(raw: unknown): Set<number> | null {
  if (raw === undefined || raw === null || raw === "") return new Set();
  if (typeof raw !== "string" || raw.length > MAX_ROWSET_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  let binary: string;
  try {
    binary = atob(raw);
  } catch {
    return null;
  }
  const rows = new Set<number>();
  for (let i = 0; i < binary.length; i += 1) {
    const byte = binary.charCodeAt(i);
    for (let bit = 0; bit < 8; bit += 1) if (byte & (1 << bit)) rows.add(i * 8 + bit);
  }
  return [...rows].some((row) => row > MAX_ROW) ? null : rows;
}

type ReportRow = { row: number; status: string; fingerprint?: string; canCreate?: boolean; canFill?: boolean };

/** The two fields the wizard sends: the owner's non-default choices (with fingerprints) and the rows that were duplicates. */
export function commitFields(rows: ReportRow[], decisions: Record<string, string>): { choices: string; dups: string } {
  const entries: ChoiceEntry[] = [];
  const dups: number[] = [];
  for (const r of rows) {
    if (r.status !== "duplicate" || r.fingerprint === undefined) continue;
    dups.push(r.row);
    const decision = decisions[String(r.row)];
    const allowed = decision === "create" ? r.canCreate !== false : decision === "fill" ? r.canFill !== false : false;
    if (allowed && (decision === "create" || decision === "fill")) entries.push({ row: r.row, decision, fingerprint: r.fingerprint });
  }
  return { choices: encodeChoices(entries), dups: encodeRowSet(dups) };
}

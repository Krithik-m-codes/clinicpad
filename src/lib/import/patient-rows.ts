import { detectDelimiter, parseCsvRows, type CsvDelimiter, type CsvRecord } from "@/lib/csv";
import { IMPORT_FIELDS, type ColumnMapping, type ImportField } from "./patient-columns";

export const IMPORT_LIMITS = { maxBytes: 900_000, maxRows: 5_000, maxColumns: 40, maxCellChars: 2_000 } as const;

export const IMPORT_MESSAGES = {
  empty: "The file is empty.",
  noRows: "The file has a header row but no patients.",
  tooLarge: "The file is larger than 900 KB. Split it into smaller files.",
  tooManyRows: "The file has more than 5,000 patients. Split it into smaller files.",
  tooManyColumns: "The file has more than 40 columns. Remove the columns you do not need.",
  // Identical to NUL_MESSAGE (src/server/validation/text.ts); tests/unit/patient-import-rows.test.ts pins that.
  nul: "Text contains an invalid character",
  tooLong: "This cell is longer than 2,000 characters.",
  sciPhone: "Excel turned this phone number into a number like 9.88E+09, which loses digits. Format the column as Text in Excel and export again.",
  twoDigitYear: "Use a four-digit year, for example 15/08/1990.",
  monthFirst: "This looks like month/day/year. Write dates as day/month/year, for example 15/08/1990.",
  yearOnly: "Enter the full date of birth, not only the year.",
  badDate: "Write the date as day/month/year, for example 15/08/1990.",
  noSuchDate: "This date does not exist.",
  gender: "Write female, male, or other.",
} as const;

export type ImportTable = { headers: string[]; rows: CsvRecord[]; delimiter: CsvDelimiter };
export type CellResult = { ok: true; value: string } | { ok: false; message: string };
export type RawPatientRow = Record<ImportField, string>;

const MAX_HEADER_CHARS = 100;
const good = (value: string): CellResult => ({ ok: true, value });
const bad = (message: string): CellResult => ({ ok: false, message });
const singleLine = (value: string) => value.replace(/\s+/g, " ").trim();

/** Header and data rows of an import file, with caps applied. Rows whose cells are all blank are dropped. */
export function parseImportTable(text: string): { ok: true; table: ImportTable } | { ok: false; message: string } {
  const delimiter = detectDelimiter(text);
  const records = parseCsvRows(text, { delimiter });
  if (records.length === 0) return { ok: false, message: IMPORT_MESSAGES.empty };
  const [header, ...data] = records;
  if (header.cells.length > IMPORT_LIMITS.maxColumns) return { ok: false, message: IMPORT_MESSAGES.tooManyColumns };
  if (header.cells.some((h) => h.includes("\u0000"))) return { ok: false, message: IMPORT_MESSAGES.nul };
  if (data.some((r) => r.cells.length > IMPORT_LIMITS.maxColumns)) return { ok: false, message: IMPORT_MESSAGES.tooManyColumns };
  const headers = header.cells.map((h, i) => singleLine(h).slice(0, MAX_HEADER_CHARS) || `Column ${i + 1}`);
  const rows = data.filter((r) => r.cells.some((c) => c.trim() !== ""));
  if (rows.length === 0) return { ok: false, message: IMPORT_MESSAGES.noRows };
  if (rows.length > IMPORT_LIMITS.maxRows) return { ok: false, message: IMPORT_MESSAGES.tooManyRows };
  return { ok: true, table: { headers, rows, delimiter } };
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

function calendarDay(y: string, m: string, d: string): CellResult {
  const ymd = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const t = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === ymd ? good(ymd) : bad(IMPORT_MESSAGES.noSuchDate);
}

/**
 * A date cell as YYYY-MM-DD ("" when blank). Day first, as in India: 15/08/1990, 15-08-1990, 15.08.1990, an ISO
 * date, or an Excel serial number (61 = 1900-03-01). Ambiguous input is refused, never guessed: a two-digit year, a
 * second part above 12 (month/day/year), a bare year.
 */
export function dateCell(raw: string): CellResult {
  const text = raw.trim().replace(/^'/, "").replace(/[T ]00:00(?::00(?:\.0+)?)?Z?$/i, "").trim();
  if (text === "") return good("");
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (m) return calendarDay(m[1], m[2], m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (m) {
    if (Number(m[2]) > 12 && Number(m[1]) <= 12) return bad(IMPORT_MESSAGES.monthFirst);
    return calendarDay(m[3], m[2], m[1]);
  }
  if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2}$/.test(text)) return bad(IMPORT_MESSAGES.twoDigitYear);
  if (/^\d{4}$/.test(text) && Number(text) >= 1900 && Number(text) <= 2100) return bad(IMPORT_MESSAGES.yearOnly);
  if (/^\d{2,5}$/.test(text)) {
    const serial = Number(text);
    if (serial >= 61 && serial <= 73050) return good(new Date(EXCEL_EPOCH + serial * DAY_MS).toISOString().slice(0, 10));
  }
  return bad(IMPORT_MESSAGES.badDate);
}

/** A phone cell with Excel's damage repaired (a leading ' text marker, a trailing .0) or refused (scientific notation). */
export function phoneCell(raw: string): CellResult {
  const text = raw.trim().replace(/^'/, "");
  if (text === "") return good("");
  if (/^\d+(?:\.\d+)?e\+?\d+$/i.test(text)) return bad(IMPORT_MESSAGES.sciPhone);
  return good(text.replace(/\.0+$/, ""));
}

const GENDERS: Record<string, "female" | "male" | "other" | "unknown"> = {
  f: "female",
  female: "female",
  woman: "female",
  girl: "female",
  m: "male",
  male: "male",
  man: "male",
  boy: "male",
  o: "other",
  other: "other",
  t: "other",
  transgender: "other",
  u: "unknown",
  unknown: "unknown",
  na: "unknown",
  "n/a": "unknown",
  "-": "unknown",
};

export function genderCell(raw: string): CellResult {
  const key = raw.trim().toLowerCase().replace(/\.$/, "");
  if (key === "") return good("unknown");
  return Object.hasOwn(GENDERS, key) ? good(GENDERS[key]) : bad(IMPORT_MESSAGES.gender);
}

/**
 * The raw patient-form values of one row (validated afterwards by patientInputSchema, like the form). A NUL in any
 * mapped cell refuses the row (never stripped); unmapped cells are ignored entirely.
 */
export function rowValues(
  cells: readonly string[],
  mapping: ColumnMapping,
): { ok: true; values: RawPatientRow } | { ok: false; field: ImportField; message: string } {
  const cell = (field: ImportField): string => {
    const index = mapping[field];
    return index === null ? "" : (cells[index] ?? "");
  };
  for (const field of IMPORT_FIELDS) {
    const value = cell(field);
    if (value.includes("\u0000")) return { ok: false, field, message: IMPORT_MESSAGES.nul };
    if (value.length > IMPORT_LIMITS.maxCellChars) return { ok: false, field, message: IMPORT_MESSAGES.tooLong };
  }
  const phone = phoneCell(cell("phone"));
  if (!phone.ok) return { ok: false, field: "phone", message: phone.message };
  const dob = dateCell(cell("dob"));
  if (!dob.ok) return { ok: false, field: "dob", message: dob.message };
  const gender = genderCell(cell("gender"));
  if (!gender.ok) return { ok: false, field: "gender", message: gender.message };
  return {
    ok: true,
    values: {
      name: singleLine(cell("name")),
      phone: phone.value,
      dob: dob.value,
      gender: gender.value,
      address: cell("address").replace(/\s*[\r\n]+\s*/g, ", ").trim(),
      allergies: cell("allergies").replace(/[;|]/g, ","),
      notes: cell("notes").trim(),
    },
  };
}

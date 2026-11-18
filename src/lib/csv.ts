export type CsvDelimiter = "," | ";" | "\t";

/** One record and the 1-based spreadsheet row it starts on: blank lines count as rows, a quoted line break does not. */
export type CsvRecord = { row: number; cells: string[] };

/**
 * Minimal RFC 4180 parser: one delimiter (comma by default), double-quoted fields with "" escapes and embedded
 * delimiters/newlines, CRLF or LF endings, an optional UTF-8 BOM. Blank lines are skipped. Never throws: an
 * unterminated quote runs to the end of the input. Linear in the input length.
 */
export function parseCsvRows(text: string, opts: { delimiter?: CsvDelimiter } = {}): CsvRecord[] {
  const delimiter = opts.delimiter ?? ",";
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let rowNo = 1;

  const endRow = () => {
    row.push(field);
    field = "";
    if (!(row.length === 1 && row[0] === "")) records.push({ row: rowNo, cells: row });
    row = [];
    rowNo += 1;
  };

  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      i += 1;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (c === "\r" || c === "\n") {
      endRow();
      i += c === "\r" && input[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field !== "" || row.length > 0) endRow();
  return records;
}

/** Rows of cells (see parseCsvRows). */
export function parseCsv(text: string, opts: { delimiter?: CsvDelimiter } = {}): string[][] {
  return parseCsvRows(text, opts).map((r) => r.cells);
}

/** Rows as objects keyed by the trimmed, lower-cased header. Extra columns are dropped. */
export function csvRecords(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return rows.map((row) => Object.fromEntries(keys.map((key, index) => [key, (row[index] ?? "").trim()])));
}

/**
 * The delimiter of a spreadsheet export, read from its first line (outside quotes): Excel writes ";" in locales
 * that use a decimal comma and tabs for "Unicode Text". Ties go to the comma.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  const end = Math.min(text.length, 64_000);
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < end; i += 1) {
    const c = text[i];
    if (c === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (c === "\n" || c === "\r") break;
    if (c === "," || c === ";" || c === "\t") counts[c] += 1;
  }
  if (counts["\t"] > counts[","] && counts["\t"] >= counts[";"]) return "\t";
  if (counts[";"] > counts[","]) return ";";
  return ",";
}

/** A cell that a spreadsheet would run as a formula (OWASP CSV injection): = + - @ tab CR. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell, safe to open in a spreadsheet: a formula start is neutralised with a leading ', then RFC 4180 quoting. */
export function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",;\t\r\n]/.test(safe) || safe !== safe.trim() ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** A CSV file for spreadsheets: UTF-8 BOM (so Excel shows Devanagari), CRLF line ends, every cell through csvCell. */
export function serializeCsv(rows: readonly (readonly string[])[]): string {
  return `\uFEFF${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

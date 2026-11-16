/**
 * Minimal RFC 4180 parser for the sample_data catalogue files: commas, double-quoted fields
 * with "" escapes and embedded commas/newlines, CRLF or LF endings, an optional UTF-8 BOM.
 * Blank lines are skipped. Never throws: an unterminated quote runs to the end of the input.
 */
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const endRow = () => {
    row.push(field);
    field = "";
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
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
    if (c === ",") {
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
  return rows;
}

/** Rows as objects keyed by the trimmed, lower-cased header. Extra columns are dropped. */
export function csvRecords(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return rows.map((row) => Object.fromEntries(keys.map((key, index) => [key, (row[index] ?? "").trim()])));
}

// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { serializeCsv } from "@/lib/csv";
import { NUL_MESSAGE } from "@/server/validation/text";
import { ageColumns, checkMapping, PATIENT_TEMPLATE_ROWS, suggestMapping, type ColumnMapping } from "@/lib/import/patient-columns";
import { dateCell, genderCell, IMPORT_LIMITS, IMPORT_MESSAGES, parseImportTable, phoneCell, rowValues } from "@/lib/import/patient-rows";

const mapping = (overrides: Partial<ColumnMapping> = {}): ColumnMapping => ({
  name: 0,
  phone: 1,
  dob: 2,
  gender: 3,
  address: null,
  allergies: null,
  notes: null,
  ...overrides,
});

describe("parseImportTable", () => {
  it("detects the delimiter, names blank headers, skips empty rows and keeps spreadsheet row numbers", () => {
    const parsed = parseImportTable("Name;Mobile;;\r\nAsha;98765;;\r\n;;;\r\nRavi;12345;;\r\n");
    expect(parsed).toMatchObject({ ok: true, table: { delimiter: ";", headers: ["Name", "Mobile", "Column 3", "Column 4"] } });
    expect(parsed.ok && parsed.table.rows.map((r) => r.row)).toEqual([2, 4]);
  });

  it.each([
    ["", IMPORT_MESSAGES.empty],
    ["name,phone\r\n", IMPORT_MESSAGES.noRows],
    ["name,phone\r\n,\r\n , \r\n", IMPORT_MESSAGES.noRows],
    [`${Array.from({ length: 41 }, (_, i) => `c${i}`).join(",")}\nx`, IMPORT_MESSAGES.tooManyColumns],
    [`name\n${Array.from({ length: IMPORT_LIMITS.maxRows + 1 }, (_, i) => `P${i}`).join("\n")}`, IMPORT_MESSAGES.tooManyRows],
  ])("refuses %#", (text, message) => {
    expect(parseImportTable(text)).toEqual({ ok: false, message });
  });

  it("accepts exactly the row cap and exactly the column cap", () => {
    const text = `name\n${Array.from({ length: IMPORT_LIMITS.maxRows }, (_, i) => `P${i}`).join("\n")}`;
    expect(parseImportTable(text).ok).toBe(true);
    const wide = `${Array.from({ length: IMPORT_LIMITS.maxColumns }, (_, i) => `c${i}`).join(",")}\nx`;
    expect(parseImportTable(wide).ok).toBe(true);
  });

  it("does not let blank lines or blank-cell rows count toward the row cap", () => {
    const filler = "\n,".repeat(IMPORT_LIMITS.maxRows + 10);
    expect(parseImportTable(`name,x${filler}\nAsha,1`).ok).toBe(true);
  });

  it("refuses a header row that is wider than the cap even when it is the only huge row", () => {
    const header = Array.from({ length: 5_000 }, (_, i) => `h${i}`).join(",");
    expect(parseImportTable(`${header}\nx`)).toEqual({ ok: false, message: IMPORT_MESSAGES.tooManyColumns });
  });

  it("refuses a data row that is wider than the cap", () => {
    const row = Array.from({ length: IMPORT_LIMITS.maxColumns + 1 }, () => "x").join(",");
    expect(parseImportTable(`name\n${row}`)).toEqual({ ok: false, message: IMPORT_MESSAGES.tooManyColumns });
  });

  it("shortens an enormous header name and refuses a NUL in a header", () => {
    const parsed = parseImportTable(`${"h".repeat(10_000)},b\nx,y`);
    expect(parsed.ok && parsed.table.headers[0].length).toBeLessThanOrEqual(100);
    expect(parseImportTable("na\u0000me,b\nx,y")).toEqual({ ok: false, message: IMPORT_MESSAGES.nul });
  });

  it("reads tab-separated Unicode Text, CR-only line ends and a BOM", () => {
    const parsed = parseImportTable("\uFEFFName\tPhone\rAsha\t98765\rRavi\t12345");
    expect(parsed).toMatchObject({ ok: true, table: { delimiter: "\t", headers: ["Name", "Phone"] } });
    expect(parsed.ok && parsed.table.rows.map((r) => r.row)).toEqual([2, 3]);
  });
});

describe("suggestMapping", () => {
  it("maps the legacy and common spreadsheet headers, never one column twice, and reports Age as not imported", () => {
    const headers = ["Patient Name", "Mobile No.", "D.O.B", "Sex", "Age", "Address", "Drug allergy", "Remarks"];
    const m = suggestMapping(headers);
    expect(m).toEqual({ name: 0, phone: 1, dob: 2, gender: 3, address: 5, allergies: 6, notes: 7 });
    expect(ageColumns(headers, m)).toEqual(["Age"]);
  });

  it("maps Hindi headers and leaves unknown ones unmapped", () => {
    expect(suggestMapping(["नाम", "मोबाइल", "Ward"])).toMatchObject({ name: 0, phone: 1, dob: null, notes: null });
  });

  it("takes the first matching column when two look alike", () => {
    expect(suggestMapping(["Phone", "Mobile"])).toMatchObject({ phone: 0 });
  });
});

describe("checkMapping", () => {
  it("accepts a complete mapping", () => {
    expect(checkMapping(mapping(), 4)).toEqual({ ok: true, mapping: mapping() });
  });

  it.each([
    [{ ...mapping(), name: null }, "Choose the column that holds the patient's name."],
    [{ ...mapping(), phone: 0 }, "Each column can be used for one detail only."],
    [{ ...mapping(), notes: 9 }, "A chosen column does not exist in this file."],
    [{ ...mapping(), extra: 1 }, "Choose which column holds each detail."],
    [{ ...mapping(), dob: -1 }, "Choose which column holds each detail."],
    [{ ...mapping(), dob: 1.5 }, "Choose which column holds each detail."],
    [{ ...mapping(), dob: "2" }, "Choose which column holds each detail."],
    [null, "Choose which column holds each detail."],
    ["not an object", "Choose which column holds each detail."],
  ])("refuses %#", (raw, message) => {
    expect(checkMapping(raw, 4)).toEqual({ ok: false, message });
  });
});

describe("dateCell", () => {
  it.each([
    ["1990-08-15", "1990-08-15"],
    ["15/08/1990", "1990-08-15"],
    ["5/8/1990", "1990-08-05"],
    ["15-08-1990", "1990-08-15"],
    ["15.08.1990", "1990-08-15"],
    ["15/08/1990 00:00", "1990-08-15"],
    ["1990-08-15T00:00:00Z", "1990-08-15"],
    ["'15/08/1990", "1990-08-15"],
    ["33100", "1990-08-15"],
    ["61", "1900-03-01"],
    ["", ""],
    ["  ", ""],
  ])("reads %j as %j", (raw, value) => {
    expect(dateCell(raw)).toEqual({ ok: true, value });
  });

  it.each([
    ["08/15/1990", IMPORT_MESSAGES.monthFirst],
    ["15/08/90", IMPORT_MESSAGES.twoDigitYear],
    ["31/02/1990", IMPORT_MESSAGES.noSuchDate],
    ["29/02/1900", IMPORT_MESSAGES.noSuchDate],
    ["1990", IMPORT_MESSAGES.yearOnly],
    ["15 Aug 1990", IMPORT_MESSAGES.badDate],
    ["50", IMPORT_MESSAGES.badDate],
    ["99999", IMPORT_MESSAGES.badDate],
    ["1e5", IMPORT_MESSAGES.badDate],
    ["=1+1", IMPORT_MESSAGES.badDate],
  ])("refuses %j rather than guessing", (raw, message) => {
    expect(dateCell(raw)).toEqual({ ok: false, message });
  });
});

describe("phoneCell", () => {
  it.each([
    ["+91 98765 43210", "+91 98765 43210"],
    ["'9876543210", "9876543210"],
    ["9876543210.0", "9876543210"],
    ["", ""],
  ])("keeps or repairs %j", (raw, value) => {
    expect(phoneCell(raw)).toEqual({ ok: true, value });
  });

  it.each(["9.87654E+09", "9.876543210e9", "9.88E+9"])("refuses Excel's scientific notation %j (digits are lost)", (raw) => {
    expect(phoneCell(raw)).toEqual({ ok: false, message: IMPORT_MESSAGES.sciPhone });
  });
});

describe("genderCell", () => {
  it.each([
    ["F", "female"],
    ["Female", "female"],
    ["m.", "male"],
    ["MALE", "male"],
    ["other", "other"],
    ["", "unknown"],
    ["N/A", "unknown"],
  ])("%j -> %j", (raw, value) => {
    expect(genderCell(raw)).toEqual({ ok: true, value });
  });

  it("refuses anything else, including prototype keys", () => {
    expect(genderCell("robot")).toEqual({ ok: false, message: IMPORT_MESSAGES.gender });
    expect(genderCell("constructor")).toEqual({ ok: false, message: IMPORT_MESSAGES.gender });
    expect(genderCell("__proto__")).toEqual({ ok: false, message: IMPORT_MESSAGES.gender });
  });
});

describe("rowValues", () => {
  it("repairs cells and leaves validation of the result to patientInputSchema", () => {
    const result = rowValues(["  Asha   Rao ", "'98765 43210", "15/08/1990", "F", "12 MG Road\nPune", "Penicillin; Sulfa | Dust", " note "], {
      ...mapping(),
      address: 4,
      allergies: 5,
      notes: 6,
    });
    expect(result).toEqual({
      ok: true,
      values: {
        name: "Asha Rao",
        phone: "98765 43210",
        dob: "1990-08-15",
        gender: "female",
        address: "12 MG Road, Pune",
        allergies: "Penicillin, Sulfa , Dust",
        notes: "note",
      },
    });
  });

  it("refuses a NUL in a mapped cell with the same message the form uses, and ignores unmapped cells", () => {
    expect(IMPORT_MESSAGES.nul).toBe(NUL_MESSAGE);
    const nul = "Asha\u0000Rao";
    expect(nul.codePointAt(4)).toBe(0);
    expect(rowValues([nul, "", "", ""], mapping())).toEqual({ ok: false, field: "name", message: NUL_MESSAGE });
    expect(rowValues(["Asha", "", "", "", nul], mapping())).toMatchObject({ ok: true });
  });

  it("refuses an over-long mapped cell and pads a short row with blanks", () => {
    expect(rowValues(["x".repeat(IMPORT_LIMITS.maxCellChars + 1)], mapping())).toEqual({ ok: false, field: "name", message: IMPORT_MESSAGES.tooLong });
    expect(rowValues(["x".repeat(IMPORT_LIMITS.maxCellChars)], mapping())).toMatchObject({ ok: true });
    expect(rowValues(["Only Name"], mapping())).toMatchObject({ ok: true, values: { name: "Only Name", phone: "", dob: "", gender: "unknown" } });
  });

  it("does not execute or strip a formula cell: it stays text for the validators", () => {
    const result = rowValues(['=HYPERLINK("http://x","y")', "", "", ""], mapping());
    expect(result).toMatchObject({ ok: true, values: { name: '=HYPERLINK("http://x","y")' } });
  });

  it("names the field of a repair that failed", () => {
    expect(rowValues(["Asha", "9.8E+09", "", ""], mapping())).toEqual({ ok: false, field: "phone", message: IMPORT_MESSAGES.sciPhone });
    expect(rowValues(["Asha", "", "31/02/1990", ""], mapping())).toEqual({ ok: false, field: "dob", message: IMPORT_MESSAGES.noSuchDate });
    expect(rowValues(["Asha", "", "", "robot"], mapping())).toEqual({ ok: false, field: "gender", message: IMPORT_MESSAGES.gender });
  });
});

describe("the patient template", () => {
  it("is the file in sample_data, byte for byte, and parses back to the same rows", () => {
    const file = readFileSync(path.join(process.cwd(), "sample_data", "patients_template.csv"), "utf8");
    expect(file).toBe(serializeCsv(PATIENT_TEMPLATE_ROWS));
    const parsed = parseImportTable(file);
    expect(parsed.ok && [parsed.table.headers, ...parsed.table.rows.map((r) => r.cells)]).toEqual(PATIENT_TEMPLATE_ROWS);
    expect(parsed.ok && suggestMapping(parsed.table.headers)).toEqual({ name: 0, phone: 1, dob: 2, gender: 3, address: 4, allergies: 5, notes: 6 });
  });
});

import { describe, expect, it } from "vitest";
import { csvCell, csvRecords, detectDelimiter, parseCsv, parseCsvRows, serializeCsv } from "@/lib/csv";

describe("parseCsv", () => {
  it("splits rows and fields with CRLF or LF endings", () => {
    expect(parseCsv("a,b\r\nc,d\ne,f")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
  });

  it("handles quoted fields with commas, escaped quotes, and newlines", () => {
    expect(parseCsv('name,salt\nANTICRAMP,"Mg 200mg, L-Carnitine"\nQ,"say ""hi"""\nN,"two\nlines"')).toEqual([
      ["name", "salt"],
      ["ANTICRAMP", "Mg 200mg, L-Carnitine"],
      ["Q", 'say "hi"'],
      ["N", "two\nlines"],
    ]);
  });

  it("skips blank lines, a trailing newline, and a UTF-8 BOM", () => {
    const bom = "\ufeff";
    expect(bom.codePointAt(0)).toBe(0xfeff);
    expect(parseCsv(`${bom}name\r\n\r\nFEVER\r\n\r\n`)).toEqual([["name"], ["FEVER"]]);
  });

  it("keeps empty fields", () => {
    expect(parseCsv("a,,c\nd,\n")).toEqual([
      ["a", "", "c"],
      ["d", ""],
    ]);
  });

  it("does not throw on an unterminated quote", () => {
    expect(parseCsv('a,"unterminated')).toEqual([["a", "unterminated"]]);
  });

  it("returns nothing for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("csvRecords", () => {
  it("maps rows to lower-case header keys and trims values", () => {
    expect(csvRecords("name,icdCode\r\n TYPHOID , A01 \r\nMALARIA\r\n")).toEqual([
      { name: "TYPHOID", icdcode: "A01" },
      { name: "MALARIA", icdcode: "" },
    ]);
  });

  it("drops columns beyond the header", () => {
    expect(csvRecords("name\nX,extra")).toEqual([{ name: "X" }]);
  });

  it("returns nothing for an empty file", () => {
    expect(csvRecords("")).toEqual([]);
  });
});

describe("parseCsv with another delimiter", () => {
  it("splits on semicolons or tabs and keeps commas inside fields", () => {
    expect(parseCsv("name;address\nAsha;12, MG Road", { delimiter: ";" })).toEqual([
      ["name", "address"],
      ["Asha", "12, MG Road"],
    ]);
    expect(parseCsv("name\tphone\nRavi\t98765", { delimiter: "\t" })).toEqual([
      ["name", "phone"],
      ["Ravi", "98765"],
    ]);
  });
});

describe("parseCsvRows", () => {
  it("numbers records the way a spreadsheet numbers rows: blank lines count, quoted line breaks do not", () => {
    const rows = parseCsvRows('name,notes\r\nAsha,"line one\nline two"\r\n\r\nRavi,x\r\n');
    expect(rows).toEqual([
      { row: 1, cells: ["name", "notes"] },
      { row: 2, cells: ["Asha", "line one\nline two"] },
      { row: 4, cells: ["Ravi", "x"] },
    ]);
  });

  it("reads CR-only, LF and CRLF line ends the same way", () => {
    const expected = [
      { row: 1, cells: ["a", "b"] },
      { row: 2, cells: ["c", "d"] },
    ];
    expect(parseCsvRows("a,b\rc,d")).toEqual(expected);
    expect(parseCsvRows("a,b\nc,d")).toEqual(expected);
    expect(parseCsvRows("a,b\r\nc,d")).toEqual(expected);
  });

  it("drops a leading BOM only, and keeps a NUL inside a cell untouched (refusal is the caller's job)", () => {
    const rows = parseCsvRows("\uFEFFname\nAs\u0000ha");
    expect(rows[0].cells).toEqual(["name"]);
    expect(rows[1].cells[0].codePointAt(2)).toBe(0);
    expect(rows[1].cells[0]).toHaveLength(5);
  });

  it("never throws on an unterminated quote and runs it to the end", () => {
    expect(parseCsvRows('a,"b\nc,d')).toEqual([{ row: 1, cells: ["a", "b\nc,d"] }]);
  });

  it("keeps a quoted semicolon delimiter and an empty quoted cell", () => {
    expect(parseCsvRows('"a;b";"";c', { delimiter: ";" })).toEqual([{ row: 1, cells: ["a;b", "", "c"] }]);
  });

  it("parses a very wide row and a very long cell in linear time", () => {
    const wide = Array.from({ length: 50_000 }, (_, i) => `c${i}`).join(",");
    expect(parseCsvRows(wide)[0].cells).toHaveLength(50_000);
    const long = "x".repeat(2_000_000);
    expect(parseCsvRows(`"${long}"`)[0].cells[0]).toHaveLength(2_000_000);
  });
});

describe("detectDelimiter", () => {
  it.each([
    ["name,phone,dob\n", ","],
    ["name;phone;dob\n", ";"],
    ["name\tphone\tdob\n", "\t"],
    ['"a;b",c\n', ","],
    ["single\n", ","],
    ["\uFEFFname;phone\r\n", ";"],
    ["", ","],
    ["a;b,c;d\n1,2,3,4,5\n", ";"],
  ] as const)("%j -> %j", (text, expected) => {
    expect(detectDelimiter(text)).toBe(expected);
  });
});

describe("serializeCsv", () => {
  it("neutralises formula cells (= + - @ tab CR) so a spreadsheet shows them as text", () => {
    expect(csvCell("=HYPERLINK(\"http://x\",\"y\")")).toBe('"\'=HYPERLINK(""http://x"",""y"")"');
    expect(csvCell("+91 98765 43210")).toBe("'+91 98765 43210");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\t=1")).toBe("\"'\t=1\"");
    expect(csvCell("\r=1")).toBe("\"'\r=1\"");
    expect(csvCell("Asha Rao")).toBe("Asha Rao");
  });

  it("quotes a cell with a leading space (not a formula to a spreadsheet) and semicolons", () => {
    expect(csvCell(" =1+1")).toBe('" =1+1"');
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell("")).toBe("");
  });

  it("quotes commas, quotes and line breaks, starts with a BOM and ends rows with CRLF", () => {
    const out = serializeCsv([
      ["name", "notes"],
      ["आशा", 'said "hi", left\nearly'],
    ]);
    expect(out.codePointAt(0)).toBe(0xfeff);
    expect(out.slice(1)).toBe('name,notes\r\nआशा,"said ""hi"", left\nearly"\r\n');
  });

  it("round-trips through parseCsv except for the neutralising apostrophe", () => {
    const rows = [["a,b", "c\"d", "=1"]];
    expect(parseCsv(serializeCsv(rows))).toEqual([["a,b", 'c"d', "'=1"]]);
  });
});

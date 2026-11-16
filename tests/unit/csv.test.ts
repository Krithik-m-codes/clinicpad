import { describe, expect, it } from "vitest";
import { csvRecords, parseCsv } from "@/lib/csv";

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

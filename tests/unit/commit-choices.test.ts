import { describe, expect, it } from "vitest";
import { commitFields, decodeChoices, decodeRowSet, encodeChoices, encodeRowSet, MAX_CHOICES_CHARS } from "@/lib/import/commit-choices";
import { IMPORT_LIMITS } from "@/lib/import/patient-rows";

const FP = "0123456789abcdef".repeat(4);
const rowsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ row: i + 2, status: "duplicate", fingerprint: FP, canCreate: true, canFill: true }));

describe("the commit payload of the import wizard", () => {
  it("sends nothing for a file of 5,000 duplicates when every row keeps the default (skip)", () => {
    const { choices, dups } = commitFields(rowsOf(IMPORT_LIMITS.maxRows), {});
    expect(choices).toBe("");
    expect(dups.length).toBeLessThan(1_000);
  });

  it("stays under 100 KB in the worst case: all 5,000 rows chosen", () => {
    const decisions = Object.fromEntries(rowsOf(IMPORT_LIMITS.maxRows).map((r, i) => [String(r.row), i % 2 === 0 ? "create" : "fill"]));
    const { choices, dups } = commitFields(rowsOf(IMPORT_LIMITS.maxRows), decisions);
    expect(choices.length + dups.length).toBeLessThan(100_000);
    expect(choices.length).toBeLessThanOrEqual(MAX_CHOICES_CHARS);
    const decoded = decodeChoices(choices);
    expect(decoded?.size).toBe(IMPORT_LIMITS.maxRows);
    expect(decoded?.get(2)).toEqual({ decision: "create", fingerprint: FP.slice(0, 8) });
    expect(decoded?.get(3)).toEqual({ decision: "fill", fingerprint: FP.slice(0, 8) });
  });

  it("lists only the rows the owner changed, and never a choice that is not allowed", () => {
    const rows = [
      { row: 2, status: "duplicate", fingerprint: FP, canCreate: true, canFill: true },
      { row: 3, status: "duplicate", fingerprint: FP, canCreate: false, canFill: false },
      { row: 4, status: "new" },
      { row: 5, status: "duplicate", fingerprint: FP, canCreate: true, canFill: false },
    ];
    const { choices, dups } = commitFields(rows, { "2": "fill", "3": "create", "4": "create", "5": "skip" });
    expect(choices).toBe(`f2.${FP.slice(0, 8)}`);
    expect([...(decodeRowSet(dups) ?? [])].sort()).toEqual([2, 3, 5]);
  });
});

describe("decodeChoices / decodeRowSet", () => {
  it("round-trips and refuses anything malformed", () => {
    expect(decodeChoices(encodeChoices([{ row: 7, decision: "create", fingerprint: FP }]))?.get(7)).toEqual({ decision: "create", fingerprint: FP.slice(0, 8) });
    expect(decodeChoices("")?.size).toBe(0);
    for (const bad of ["x", "c7", "c7.zzzzzzzz", "c7.0123456789abcdef", "c7.01234567,c7.01234567", "c999999.01234567", false, 5, "c7.01234567,"]) {
      expect(decodeChoices(bad)).toBeNull();
    }
    expect(decodeRowSet(encodeRowSet([2, 9, 5001]))).toEqual(new Set([2, 9, 5001]));
    for (const bad of ["not base64!", "A".repeat(2_000), false, 12]) expect(decodeRowSet(bad)).toBeNull();
    expect(decodeRowSet(encodeRowSet([90_000]))).toBeNull();
  });
});

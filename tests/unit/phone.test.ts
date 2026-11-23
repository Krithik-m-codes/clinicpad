import { describe, expect, it } from "vitest";
import { normalizePhone } from "@/lib/domain/phone";

describe("normalizePhone", () => {
  it.each([
    ["9876543210", "9876543210"],
    ["98765 43210", "9876543210"],
    ["98765-43210", "9876543210"],
    ["+91 98765 43210", "9876543210"],
    ["919876543210", "9876543210"],
    ["09876543210", "9876543210"],
    ["(022) 2345 6789", "2223456789"],
    ["+44 7911 123456", "447911123456"],
    ["0091 98765 43210", "9876543210"],
    ["+91 098765 43210", "9876543210"],
    ["0044 7911 123456", "447911123456"],
    ["1234567", "1234567"],
    ["123456789012345", "123456789012345"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "abc",
    "12345",
    "+91 98",
    "+1",
    "+91 98765",
    "+91 98765 4321",
    "+91 12345678",
    "+91 98765 432100",
    "123456",
    "1234567890123456",
  ])("rejects %j", (input) => {
    expect(normalizePhone(input)).toBeNull();
  });

  it("does not strip a leading 91 from a 10-digit national number", () => {
    expect(normalizePhone("9123456789")).toBe("9123456789");
  });
});

describe("normalizePhone dialling noise (Plan 1D)", () => {
  it.each([
    ["tel:+91 98765 43210", "9876543210"],
    ["TEL:9876543210", "9876543210"],
    ["+0091 98765 43210", "9876543210"],
    ["\u200E+91 98765 43210", "9876543210"],
    ["\u202A+1 415 555 0100\u202C", "14155550100"],
    ["tel:+1-415-555-0100", "14155550100"],
    ["98765\u200B43210", "9876543210"],
    ["\uFEFF+91 98765 43210", "9876543210"],
    ["  tel: +91 98765 43210 ", "9876543210"],
  ])("%j -> %j", (raw, expected) => {
    expect(Array.from(raw).some((ch) => /\p{Cf}/u.test(ch)) || /tel:|\+00/i.test(raw)).toBe(true);
    expect(normalizePhone(raw)).toBe(expected);
  });

  it("still refuses nonsense", () => {
    expect(normalizePhone("tel:")).toBeNull();
    expect(normalizePhone("\u200E\u200F")).toBeNull();
    expect(normalizePhone("+00")).toBeNull();
  });
});

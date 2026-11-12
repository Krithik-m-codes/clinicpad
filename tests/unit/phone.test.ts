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
  ])("normalizes %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(["", "   ", "abc", "12345", "+91 98", "+1"])("rejects %j", (input) => {
    expect(normalizePhone(input)).toBeNull();
  });

  it("does not strip a leading 91 from a 10-digit national number", () => {
    expect(normalizePhone("9123456789")).toBe("9123456789");
  });
});

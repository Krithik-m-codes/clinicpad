import { describe, expect, it } from "vitest";
import { addMoney, formatMoney, money } from "@/lib/domain/money";

describe("money", () => {
  it("stores integer paise", () => {
    expect(money(1999).amount).toBe(1999);
  });

  it("rejects fractional minor units", () => {
    expect(() => money(19.99)).toThrow("integer minor units");
  });

  it("rejects negative amounts by default", () => {
    expect(() => money(-1)).toThrow("non-negative");
  });

  it("adds only matching currencies", () => {
    expect(addMoney(money(100), money(250))).toEqual({ amount: 350, currency: "INR" });
    expect(() => addMoney(money(100, "INR"), money(100, "USD"))).toThrow("currency mismatch");
  });

  it("formats paise as rupees", () => {
    expect(formatMoney(money(199900), "en-IN")).toContain("1,999");
  });
});

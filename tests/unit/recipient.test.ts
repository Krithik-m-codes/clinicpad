import { describe, expect, it } from "vitest";
import { emailRecipient, RECIPIENT_MESSAGES, whatsAppRecipient } from "@/lib/domain/recipient";

describe("whatsAppRecipient", () => {
  it.each([
    ["98765 43210", "919876543210"],
    ["098765-43210", "919876543210"],
    ["+91 98765 43210", "919876543210"],
    ["91 98765 43210", "919876543210"],
    ["0091 98765 43210", "919876543210"],
    ["+0091 98765 43210", "919876543210"],
    ["tel:+91-98765-43210", "919876543210"],
    ["\u200E+91 98765 43210", "919876543210"],
    ["\u202A+1 415 555 0100\u202C", "14155550100"],
    ["+1 (415) 555-0100", "14155550100"],
    ["+971 50 123 4567", "971501234567"],
    ["+44 7700 900123", "447700900123"],
    ["0 98765 43210", "919876543210"],
    ["09876543210", "919876543210"],
    ["0-98765-43210", "919876543210"],
    // A foreign number whose country code is set apart is not mistaken for an Indian mobile with a stray plus.
    ["+65 8123 4567", "6581234567"],
    ["+61 412 345 678", "61412345678"],
  ])("%j -> wa.me/%s", (raw, digits) => {
    expect(whatsAppRecipient(raw)).toMatchObject({ ok: true, digits });
  });

  it("masks all but the country code and the last four digits", () => {
    expect(whatsAppRecipient("98765 43210")).toEqual({ ok: true, digits: "919876543210", masked: "+91******3210" });
    expect(whatsAppRecipient("+1 415 555 0100")).toMatchObject({ masked: "+14*****0100" });
  });

  it.each([
    ["", RECIPIENT_MESSAGES.phoneEmpty],
    ["   ", RECIPIENT_MESSAGES.phoneEmpty],
    ["98765 abcde", RECIPIENT_MESSAGES.phoneChars],
    ["9.87654E+09", RECIPIENT_MESSAGES.phoneChars],
    ["12", RECIPIENT_MESSAGES.phoneInvalid],
    // Ten digits not starting 6-9: not an Indian mobile (a foreign number typed without +, or a 4-digit STD landline).
    ["4155550100", RECIPIENT_MESSAGES.notMobile],
    ["0141 234 5678", RECIPIENT_MESSAGES.notMobile],
    ["011 2345 6789", RECIPIENT_MESSAGES.notMobile], // a Jaipur landline: starts 1, never a mobile,
    // Eleven digits with no +: we cannot know the country.
    ["14155550100", RECIPIENT_MESSAGES.needsCountry],
  ])("refuses %j rather than guessing", (raw, message) => {
    expect(whatsAppRecipient(raw)).toEqual({ ok: false, message });
  });
});

describe("whatsAppRecipient: a number that began with 0 (STD landlines)", () => {
  it.each([["080 2345 6789"], ["079 2345 6789"], ["0755 123 4567"], ["0612 345 6789"], ["08023456789"], ["07551234567"]])(
    "refuses %j as a landline and never turns it into a +91 mobile",
    (raw) => {
      expect(whatsAppRecipient(raw)).toEqual({ ok: false, message: RECIPIENT_MESSAGES.landline });
    },
  );

  it("keeps a mobile typed after a trunk 0", () => {
    expect(whatsAppRecipient("09123456789")).toMatchObject({ ok: true, digits: "919123456789" });
  });
});

describe("whatsAppRecipient: a + in front of an Indian-looking number", () => {
  it.each([["+9876543210"], ["+98765 43210"], ["+6000000000"], ["+6581234567"]])("refuses %j without suggesting any digits", (raw) => {
    expect(whatsAppRecipient(raw)).toEqual({ ok: false, message: RECIPIENT_MESSAGES.plusAmbiguous });
    expect(RECIPIENT_MESSAGES.plusAmbiguous).not.toMatch(/[0-9]{3}/);
    expect(RECIPIENT_MESSAGES.plusAmbiguous).not.toContain("Did you mean");
  });

  it.each([["+4155550100"], ["+5155550100"], ["+98765432101"], ["+987654321"]])("never suggests India for %j", (raw) => {
    const result = whatsAppRecipient(raw);
    if (!result.ok) expect(result.message).not.toContain("Did you mean");
  });

  it("still accepts a real +91 number and real foreign numbers", () => {
    expect(whatsAppRecipient("+91 98765 43210")).toMatchObject({ ok: true, digits: "919876543210" });
    expect(whatsAppRecipient("+44 7700 900123")).toMatchObject({ ok: true, digits: "447700900123" });
    expect(whatsAppRecipient("+65 8123 4567")).toMatchObject({ ok: true, digits: "6581234567" });
  });
});

describe("emailRecipient mask", () => {
  it("never keeps a run of five digits, so it always satisfies the share-log check", () => {
    const r = emailRecipient("ravi@clinic12345.in");
    expect(r).toMatchObject({ ok: true, address: "ravi@clinic12345.in" });
    if (r.ok) {
      expect(r.masked).toBe("r***@clinic*****.in");
      expect(r.masked).not.toMatch(/\d{5}/);
    }
  });

  it.each(["1234567890@12345678.example.com", `a@${"d".repeat(60)}.example.com`, "a@" + "1".repeat(20) + ".in", "émile@café.example.com"])(
    "%j has a mask that is loggable (contains *, no 5-digit run, at most 64 characters)",
    (raw) => {
      const r = emailRecipient(raw);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.masked).toContain("*");
      expect(r.masked).not.toMatch(/\d{5}/);
      expect(Array.from(r.masked).length).toBeLessThanOrEqual(64);
    },
  );
});

describe("emailRecipient", () => {
  it("accepts an address, lower-cases the domain, and masks the local part", () => {
    expect(emailRecipient("  Asha.Rao@Example.COM ")).toEqual({ ok: true, address: "Asha.Rao@example.com", masked: "A***@example.com" });
  });

  it.each([
    ["", RECIPIENT_MESSAGES.emailEmpty],
    ["asha", RECIPIENT_MESSAGES.emailInvalid],
    ["asha@localhost", RECIPIENT_MESSAGES.emailInvalid],
    ["a b@example.com", RECIPIENT_MESSAGES.emailInvalid],
    ["a@example.com\r\nBcc: victim@example.com", RECIPIENT_MESSAGES.emailInvalid],
    ["a@example.com\u0000", RECIPIENT_MESSAGES.emailInvalid],
    ["<a@example.com>", RECIPIENT_MESSAGES.emailInvalid],
    [`${"a".repeat(65)}@example.com`, RECIPIENT_MESSAGES.emailInvalid],
  ])("refuses %j", (raw, message) => {
    expect(emailRecipient(raw)).toEqual({ ok: false, message });
  });
});

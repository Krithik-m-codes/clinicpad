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
    // A Bangalore landline in E.164 form: right digits; WhatsApp will simply not find an account.
    ["080 2345 6789", "918023456789"],
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
    // Eleven digits with no +: we cannot know the country.
    ["14155550100", RECIPIENT_MESSAGES.needsCountry],
  ])("refuses %j rather than guessing", (raw, message) => {
    expect(whatsAppRecipient(raw)).toEqual({ ok: false, message });
  });
});

describe("whatsAppRecipient: a + in front of an Indian-looking number", () => {
  it.each([
    ["+9876543210", "Did you mean +91 98765 43210? Add the country code 91."],
    ["+98765 43210", "Did you mean +91 98765 43210? Add the country code 91."],
    ["+6000000000", "Did you mean +91 60000 00000? Add the country code 91."],
  ])("refuses %j with a suggestion", (raw, message) => {
    expect(whatsAppRecipient(raw)).toEqual({ ok: false, message });
  });

  it.each([["+4155550100"], ["+5155550100"], ["+98765432101"], ["+987654321"]])("does not suggest India for %j", (raw) => {
    const result = whatsAppRecipient(raw);
    if (!result.ok) expect(result.message).not.toContain("Did you mean");
  });

  it("still accepts a real +91 number and a real foreign number", () => {
    expect(whatsAppRecipient("+91 98765 43210")).toMatchObject({ ok: true, digits: "919876543210" });
    expect(whatsAppRecipient("+44 7700 900123")).toMatchObject({ ok: true, digits: "447700900123" });
  });
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

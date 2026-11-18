import { describe, expect, it } from "vitest";
import { shareMessageText, waMeLink } from "@/server/messaging/whatsapp";

const parts = { clinicName: "Asha  Clinic\nPune", rxNo: 12, version: 2, url: "https://app.clinicpad.in/s/AbC_-123", expiresOn: "24 Nov 2026" };

describe("shareMessageText", () => {
  it("names the clinic, the Rx number and the expiry, and carries the link; never the patient or clinical text", () => {
    const text = shareMessageText(parts);
    expect(text).toBe("Asha Clinic Pune: your prescription Rx 12 v2 is ready. Open it here (the link works until 24 Nov 2026): https://app.clinicpad.in/s/AbC_-123");
  });

  it("falls back to a neutral sender and caps a long clinic name", () => {
    expect(shareMessageText({ ...parts, clinicName: "   " })).toMatch(/^Your clinic: /);
    expect(shareMessageText({ ...parts, clinicName: "x".repeat(500) }).indexOf(":")).toBeLessThanOrEqual(80);
  });
});

describe("waMeLink", () => {
  it("is the universal https://wa.me link (works on phones and on desktop), digits only, the text encoded", () => {
    const link = waMeLink("919876543210", shareMessageText(parts));
    expect(link.startsWith("https://wa.me/919876543210?text=")).toBe(true);
    expect(link).not.toContain("whatsapp://");
    expect(decodeURIComponent(new URL(link).searchParams.get("text") ?? "")).toContain(parts.url);
    expect(new URL(link).searchParams.get("text")).toBe(shareMessageText(parts));
    expect(link.length).toBeLessThan(2048);
  });

  it.each(["+919876543210", "91 98765", "1234567", "1".repeat(16), "91987654321a"])("refuses %j as digits", (digits) => {
    expect(() => waMeLink(digits, "x")).toThrow();
  });
});

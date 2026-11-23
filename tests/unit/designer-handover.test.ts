import { describe, expect, it } from "vitest";
import {
  DESIGNER_DEFAULT_DAYS,
  DESIGNER_MAX_DAYS,
  buildHandoverNote,
  designerStatus,
  generateTemporaryPassword,
  parseDesignerDays,
} from "@/lib/domain/designer";

describe("designer invitation rules", () => {
  it("defaults to seven days and caps at thirty", () => {
    expect(DESIGNER_DEFAULT_DAYS).toBe(7);
    expect(DESIGNER_MAX_DAYS).toBe(30);
    expect(parseDesignerDays(undefined)).toEqual({ ok: true, days: 7 });
    expect(parseDesignerDays("")).toEqual({ ok: true, days: 7 });
    expect(parseDesignerDays("30")).toEqual({ ok: true, days: 30 });
    expect(parseDesignerDays(1)).toEqual({ ok: true, days: 1 });
  });

  it.each(["0", "31", "-1", "1.5", "abc", "1e1", NaN, 0, 31, Infinity, {}, null])("refuses %s", (value) => {
    expect(parseDesignerDays(value as unknown).ok).toBe(false);
  });

  it("generates long random passwords that bcrypt accepts and never repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = generateTemporaryPassword();
      expect(p.length).toBeGreaterThanOrEqual(20);
      expect(p.length).toBeLessThanOrEqual(72);
      expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9-]+$/);
      seen.add(p);
    }
    expect(seen.size).toBe(50);
  });

  it("derives a status from the row and the clock", () => {
    const now = new Date("2026-11-23T10:00:00Z");
    const later = new Date("2026-11-24T10:00:00Z");
    const earlier = new Date("2026-11-22T10:00:00Z");
    expect(designerStatus({ status: "active", expiresAt: later }, now)).toBe("active");
    expect(designerStatus({ status: "active", expiresAt: earlier }, now)).toBe("expired");
    expect(designerStatus({ status: "active", expiresAt: now }, now)).toBe("expired");
    expect(designerStatus({ status: "disabled", expiresAt: later }, now)).toBe("revoked");
    expect(designerStatus({ status: "invited", expiresAt: later }, now)).toBe("revoked");
    expect(designerStatus({ status: "active", expiresAt: null }, now)).toBe("expired");
  });

  it("writes a hand-over note with the sign-in details, the expiry and the limits", () => {
    const note = buildHandoverNote({
      signInUrl: "https://app.example.com/login",
      email: "setup@example.com",
      password: "Abcd-2345-Wxyz-6789",
      expiresAt: new Date("2026-11-30T18:29:00Z"),
      timeZone: "Asia/Kolkata",
      clinicName: "Sunrise Clinic",
    });
    expect(note).toContain("https://app.example.com/login");
    expect(note).toContain("setup@example.com");
    expect(note).toContain("Abcd-2345-Wxyz-6789");
    expect(note).toContain("Sunrise Clinic");
    expect(note).toMatch(/30 Nov 2026/);
    expect(note).toMatch(/pad templates only|templates only/i);
    expect(note).toMatch(/cannot open patients/i);
  });
});

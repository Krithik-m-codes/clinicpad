import { describe, expect, it } from "vitest";
import { onboardingSchema } from "@/server/validation/onboarding";
import { lastPrinted } from "@/components/rx/rx-output-panel";

const base = { clinicName: "Sunrise Clinic", doctorName: "Dr Rao", email: "a@b.co", phone: "9876543210", password: "longenough1" };

describe("onboardingSchema", () => {
  it("accepts a real IANA time zone and defaults to Asia/Kolkata", () => {
    expect(onboardingSchema.parse(base).timezone).toBe("Asia/Kolkata");
    expect(onboardingSchema.parse({ ...base, timezone: "Europe/London" }).timezone).toBe("Europe/London");
  });

  it.each(["Not/AZone", "Mars/Olympus", "'; drop table", "UTC+5"])("refuses the time zone %s", (timezone) => {
    expect(onboardingSchema.safeParse({ ...base, timezone }).success).toBe(false);
  });

  it("cleans names (NFC, control characters) and refuses a NUL instead of stripping it", () => {
    const parsed = onboardingSchema.parse({ ...base, clinicName: "  Sun\u0007rise  Clinic ", doctorName: "Dr Rao\r\n" });
    expect(parsed.clinicName).toBe("Sunrise  Clinic");
    expect(parsed.doctorName).toBe("Dr Rao");
    expect(onboardingSchema.safeParse({ ...base, clinicName: "Sun\u0000rise" }).success).toBe(false);
    expect(onboardingSchema.safeParse({ ...base, doctorName: "D\u0000r" }).success).toBe(false);
    expect(onboardingSchema.safeParse({ ...base, clinicName: "\u0007\u0007" }).success).toBe(false);
    expect(onboardingSchema.safeParse({ ...base, clinicName: "A" }).success).toBe(false);
  });
});

describe("lastPrinted", () => {
  const outputs = { count: 2, lastAt: new Date("2026-11-12T19:00:00.000Z") };

  it("formats in the clinic zone", () => {
    expect(lastPrinted(outputs, "Asia/Kolkata")).toContain("13 Nov 2026");
  });

  it.each(["Not/AZone", "", "x".repeat(300)])("falls back to Asia/Kolkata instead of throwing for %j", (zone) => {
    expect(() => lastPrinted(outputs, zone)).not.toThrow();
    expect(lastPrinted(outputs, zone)).toBe(lastPrinted(outputs, "Asia/Kolkata"));
  });
});

import { describe, expect, it } from "vitest";
import { clinicLocalDate, latestCalendarDate } from "@/lib/domain/clinic-date";
import { ageLabel } from "@/lib/domain/age";

// 2026-11-16T19:00:00Z is 00:30 on 17 November in India (UTC+05:30) and 14:00 on 16 November in New York.
const halfPastMidnightIst = new Date("2026-11-16T19:00:00.000Z");

describe("clinicLocalDate", () => {
  it("returns the clinic's calendar day, not UTC's", () => {
    expect(clinicLocalDate(halfPastMidnightIst, "Asia/Kolkata")).toBe("2026-11-17");
    expect(clinicLocalDate(halfPastMidnightIst, "UTC")).toBe("2026-11-16");
    expect(clinicLocalDate(halfPastMidnightIst, "America/New_York")).toBe("2026-11-16");
    expect(clinicLocalDate(halfPastMidnightIst, "Asia/Dubai")).toBe("2026-11-16");
  });

  it("falls back to Asia/Kolkata (never UTC) for a missing or damaged zone", () => {
    for (const zone of [null, undefined, "", "Mars/Olympus", "Asia/Kolkata\u0000"]) {
      expect(clinicLocalDate(halfPastMidnightIst, zone)).toBe("2026-11-17");
    }
  });
});

describe("latestCalendarDate", () => {
  it("is the date at UTC+14, the first place on Earth where a day starts", () => {
    expect(latestCalendarDate(new Date("2026-11-16T09:59:59.000Z"))).toBe("2026-11-16");
    expect(latestCalendarDate(new Date("2026-11-16T10:00:00.000Z"))).toBe("2026-11-17");
  });

  it("is never earlier than any clinic's day", () => {
    for (const zone of ["Pacific/Kiritimati", "Asia/Kolkata", "UTC", "Pacific/Pago_Pago"]) {
      expect(latestCalendarDate(halfPastMidnightIst) >= clinicLocalDate(halfPastMidnightIst, zone)).toBe(true);
    }
  });
});

describe("a newborn's age at 00:30 IST", () => {
  it("is 0 days on the clinic's day, where the UTC day would print nothing (the born-in-the-future bug)", () => {
    expect(ageLabel("2026-11-17", clinicLocalDate(halfPastMidnightIst, "Asia/Kolkata"))).toBe("0 d");
    expect(ageLabel("2026-11-17", halfPastMidnightIst)).toBe("");
  });
});

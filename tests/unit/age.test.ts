import { describe, expect, it } from "vitest";
import { ageLabel } from "@/lib/domain/age";

const now = new Date("2026-11-12T10:00:00Z");

describe("ageLabel", () => {
  it.each([
    ["2020-03-15", "6 y"],
    ["2024-11-13", "23 mo"],
    ["2024-11-12", "2 y"],
    ["2025-08-01", "15 mo"],
    ["2026-10-12", "1 mo"],
    ["2026-11-01", "11 d"],
    ["2026-11-12", "0 d"],
  ])("labels %s as %s", (dob, expected) => {
    expect(ageLabel(dob, now)).toBe(expected);
  });

  it.each(["", "not-a-date", "2027-01-01", "2026-13-40"])("returns empty for %j", (dob) => {
    expect(ageLabel(dob, now)).toBe("");
  });
});

describe("ageLabel with a calendar day instead of an instant", () => {
  it.each([
    ["2020-11-17", "2026-11-17", "6 y"],
    ["2020-11-17", "2026-11-16", "5 y"],
    ["2026-11-05", "2026-11-17", "12 d"],
    ["2026-11-05", "2026-11-16", "11 d"],
    ["2026-11-17", "2026-11-17", "0 d"],
    ["2026-11-18", "2026-11-17", ""],
  ])("labels %s on %s as %j", (dob, today, expected) => {
    expect(ageLabel(dob, today)).toBe(expected);
  });

  it("returns empty for a malformed day", () => {
    expect(ageLabel("2020-01-01", "yesterday")).toBe("");
    expect(ageLabel("2020-01-01", "2026-13-40")).toBe("");
  });
});

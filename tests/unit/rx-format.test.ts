import { describe, expect, it } from "vitest";
import {
  bmi,
  durationToDays,
  formatBp,
  formatDuration,
  formatSchedule,
  parseSchedule,
  vitalsLine,
  type Schedule,
} from "@/lib/domain/rx-format";
import { SCHEDULE_PRESETS } from "@/lib/domain/rx-options";

const s = (morning: number | null, afternoon: number | null, evening: number | null, night: number | null): Schedule => ({
  morning,
  afternoon,
  evening,
  night,
});

describe("formatSchedule", () => {
  it.each([
    [s(1, 0, null, 1), "1-0-1"],
    [s(1, 1, 1, 1), "1-1-1-1"],
    [s(0.5, 0, null, 0.5), "½-0-½"],
    [s(1.5, null, null, null), "1½-0-0"],
    [s(0.25, 0.75, 0, 0), "¼-¾-0"],
    [s(12, 0, null, 10), "12-0-10"],
    [s(1, 0, 0, 1), "1-0-1"],
    [s(0.3, 0, null, 0), "0.3-0-0"],
  ])("formats %j as %s", (schedule, expected) => {
    expect(formatSchedule(schedule)).toBe(expected);
  });

  it("is empty when no slot has a dose", () => {
    expect(formatSchedule(s(null, null, null, null))).toBe("");
    expect(formatSchedule(s(0, 0, 0, 0))).toBe("");
  });
});

describe("parseSchedule", () => {
  it.each([
    ["1-0-1", s(1, 0, null, 1)],
    ["1-0-0-1", s(1, 0, 0, 1)],
    ["½-0-½", s(0.5, 0, null, 0.5)],
    ["1/2-0-1/2", s(0.5, 0, null, 0.5)],
    ["1½-0-1", s(1.5, 0, null, 1)],
    [" 1 - 0 - 1 ", s(1, 0, null, 1)],
    ["0.5-0-0.5", s(0.5, 0, null, 0.5)],
  ])("parses %j", (pattern, expected) => {
    expect(parseSchedule(pattern)).toEqual(expected);
  });

  it.each(["", "TDS", "1-0", "1--1", "1-0-1-1-1", "1-0-100", "1-0-1/0", "a-b-c"])("rejects %j", (pattern) => {
    expect(parseSchedule(pattern)).toBeNull();
  });

  it("round-trips every preset", () => {
    for (const preset of SCHEDULE_PRESETS) {
      const parsed = parseSchedule(preset);
      expect(parsed).not.toBeNull();
      expect(formatSchedule(parsed as Schedule)).toBe(preset);
    }
  });
});

describe("durations", () => {
  it("converts to days with 7-day weeks and 30-day months", () => {
    expect(durationToDays(5, "days")).toBe(5);
    expect(durationToDays(2, "weeks")).toBe(14);
    expect(durationToDays(3, "months")).toBe(90);
  });

  it.each([
    [1, "days", "1 day"],
    [5, "days", "5 days"],
    [1, "weeks", "1 week"],
    [2, "weeks", "2 weeks"],
    [3, "months", "3 months"],
    [3, null, "3 days"],
    [3, "fortnights", "3 days"],
  ])("formats %i %s as %s", (value, unit, expected) => {
    expect(formatDuration(value, unit)).toBe(expected);
  });

  it("is empty without a value", () => {
    expect(formatDuration(null, "days")).toBe("");
  });
});

describe("vitals helpers", () => {
  it("computes BMI to one decimal and refuses missing or zero inputs", () => {
    expect(bmi(70, 175)).toBe(22.9);
    expect(bmi(null, 170)).toBeNull();
    expect(bmi(70, 0)).toBeNull();
    expect(bmi(undefined, undefined)).toBeNull();
  });

  it("formats BP only when both numbers exist", () => {
    expect(formatBp(120, 80)).toBe("120/80");
    expect(formatBp(120, undefined)).toBe("");
  });

  it("builds a one-line summary in a fixed order", () => {
    expect(vitalsLine({ bpSystolic: 130, bpDiastolic: 85, pulse: 92, weightKg: 70, heightCm: 175 })).toBe(
      "BP 130/85 mmHg · Pulse 92/min · Weight 70 kg · Height 175 cm · BMI 22.9",
    );
    expect(vitalsLine({ notes: "after a walk", spo2: 97, temperatureF: 100.4 })).toBe(
      "Temp 100.4 °F · SpO₂ 97% · after a walk",
    );
    expect(vitalsLine({})).toBe("");
  });
});

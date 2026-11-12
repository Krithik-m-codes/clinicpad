import { describe, expect, it } from "vitest";
import { can } from "@/lib/domain/permissions";

describe("can", () => {
  it("lets reception register patients but not write prescriptions", () => {
    expect(can("reception", "patient.write")).toBe(true);
    expect(can("reception", "rx.draft")).toBe(false);
    expect(can("reception", "rx.finalize")).toBe(false);
    expect(can("reception", "rx.amend")).toBe(false);
  });

  it("lets owners and doctors finalize and amend", () => {
    for (const role of ["owner", "doctor"]) {
      expect(can(role, "rx.finalize")).toBe(true);
      expect(can(role, "rx.amend")).toBe(true);
    }
  });

  it("keeps nurses read-only on prescriptions", () => {
    expect(can("nurse", "rx.read")).toBe(true);
    expect(can("nurse", "rx.draft")).toBe(false);
  });

  it("denies accountants all clinical access", () => {
    expect(can("accountant", "patient.read")).toBe(false);
    expect(can("accountant", "rx.read")).toBe(false);
  });

  it("restricts archiving to owners", () => {
    expect(can("owner", "patient.archive")).toBe(true);
    expect(can("doctor", "patient.archive")).toBe(false);
  });

  it("denies unknown, empty, and missing roles", () => {
    expect(can("mystery", "patient.read")).toBe(false);
    expect(can("", "patient.read")).toBe(false);
    expect(can(null, "patient.read")).toBe(false);
    expect(can(undefined, "patient.read")).toBe(false);
  });
});

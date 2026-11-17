import { describe, expect, it } from "vitest";
import { type Action, can } from "@/lib/domain/permissions";

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

  it("keeps nurses read-only on patients and prescriptions", () => {
    expect(can("nurse", "rx.read")).toBe(true);
    expect(can("nurse", "patient.read")).toBe(true);
    expect(can("nurse", "patient.write")).toBe(false);
    expect(can("nurse", "rx.draft")).toBe(false);
  });

  it("lets reception and nurses view prescriptions", () => {
    expect(can("reception", "rx.read")).toBe(true);
    expect(can("nurse", "rx.read")).toBe(true);
  });

  it("denies accountants all clinical access", () => {
    expect(can("accountant", "patient.read")).toBe(false);
    expect(can("accountant", "rx.read")).toBe(false);
  });

  it("restricts archiving to owners", () => {
    expect(can("owner", "patient.archive")).toBe(true);
    expect(can("doctor", "patient.archive")).toBe(false);
  });

  it("restricts patient import to owners", () => {
    expect(can("owner", "patient.import")).toBe(true);
    for (const role of ["doctor", "reception", "nurse", "pharmacist", "accountant"]) expect(can(role, "patient.import")).toBe(false);
  });

  it("denies unknown, empty, and missing roles", () => {
    expect(can("mystery", "patient.read")).toBe(false);
    expect(can("", "patient.read")).toBe(false);
    expect(can(null, "patient.read")).toBe(false);
    expect(can(undefined, "patient.read")).toBe(false);
  });

  it("denies unknown and prototype-chain action keys without throwing", () => {
    for (const action of ["constructor", "__proto__", "hasOwnProperty", "nope"]) {
      expect(() => can("owner", action as Action)).not.toThrow();
      expect(can("owner", action as Action)).toBe(false);
    }
  });

  it("lets nurses and pharmacists search the catalogue, but only owners and doctors add to it", () => {
    expect(can("nurse", "catalogue.read")).toBe(true);
    expect(can("pharmacist", "catalogue.read")).toBe(true);
    expect(can("reception", "catalogue.read")).toBe(false);
    expect(can("accountant", "catalogue.read")).toBe(false);
    expect(can("nurse", "catalogue.write")).toBe(false);
    expect(can("mystery", "catalogue.read")).toBe(false);
    expect(can(undefined, "catalogue.write")).toBe(false);
  });
});

describe("role x action matrix", () => {
  const roles = ["owner", "doctor", "reception", "nurse", "accountant", "pharmacist"] as const;
  const granted: Record<Action, readonly string[]> = {
    "patient.read": ["owner", "doctor", "reception", "nurse"],
    "patient.write": ["owner", "doctor", "reception"],
    "patient.archive": ["owner"],
    "patient.import": ["owner"],
    "rx.read": ["owner", "doctor", "reception", "nurse", "pharmacist"],
    "rx.draft": ["owner", "doctor"],
    "rx.finalize": ["owner", "doctor"],
    "rx.amend": ["owner", "doctor"],
    "consent.capture": ["owner", "doctor", "reception"],
    "rx.share": ["owner", "doctor", "reception"],
    "catalogue.read": ["owner", "doctor", "nurse", "pharmacist"],
    "catalogue.write": ["owner", "doctor"],
    "settings.clinic": ["owner"],
    "settings.profile": ["owner", "doctor"],
  };
  const actions = Object.keys(granted) as Action[];

  const cells = actions.flatMap((action) =>
    roles.map((role) => [role, action, granted[action].includes(role)] as const),
  );

  it.each(cells)("%s on %s is %s", (role, action, expected) => {
    expect(can(role, action)).toBe(expected);
  });
});

describe("sharing permissions", () => {
  it("lets owners, doctors and reception record consent and share; never nurses, pharmacists or accountants", () => {
    for (const action of ["consent.capture", "rx.share"] as const) {
      for (const role of ["owner", "doctor", "reception"]) expect(can(role, action)).toBe(true);
      for (const role of ["nurse", "pharmacist", "accountant", "mystery"]) expect(can(role, action)).toBe(false);
    }
  });
});

describe("pad settings permissions", () => {
  it("lets only owners edit the clinic pad", () => {
    expect(can("owner", "settings.clinic")).toBe(true);
    for (const role of ["doctor", "reception", "nurse", "pharmacist", "accountant", "mystery"]) {
      expect(can(role, "settings.clinic")).toBe(false);
    }
  });

  it("lets owners and doctors edit their own doctor profile", () => {
    expect(can("owner", "settings.profile")).toBe(true);
    expect(can("doctor", "settings.profile")).toBe(true);
    for (const role of ["reception", "nurse", "pharmacist", "accountant", "mystery"]) {
      expect(can(role, "settings.profile")).toBe(false);
    }
  });
});

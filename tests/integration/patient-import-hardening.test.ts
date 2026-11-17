// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { patients, tenantCounters } from "@/server/db/schema";
import { clinicLocalDate } from "@/lib/domain/clinic-date";
import { createPatient } from "@/server/services/patients";
import { commitPatientImport, dryRunPatientImport } from "@/server/services/patient-import";
import { csv, utf8File } from "../helpers/csv-files";
import { commitInput, dryRunOk } from "../helpers/patient-import";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

// Wrapped so one test can write a row between the check and the number allocation (a writer that bypasses the lock).
const hooks = vi.hoisted(() => ({ beforeAllocate: null as null | (() => Promise<void>) }));
vi.mock("@/server/services/numbering", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/numbering")>();
  return {
    ...actual,
    allocateNumbers: async (...args: Parameters<typeof actual.allocateNumbers>) => {
      await hooks.beforeAllocate?.();
      return actual.allocateNumbers(...args);
    },
  };
});

let A: TestTenant;
const owner = () => A.as("owner");
const NO_PHONE = { name: 0, phone: null, dob: null, gender: null, address: null, allergies: null, notes: null };

beforeAll(async () => {
  A = await createTestTenant("import-hard");
});
afterAll(async () => {
  await A.cleanup();
});
afterEach(() => {
  hooks.beforeAllocate = null;
  vi.useRealTimers();
});

/** Another registration on a phone already in use (reception confirmed the duplicate warning). */
async function registerSamePhone(name: string, phone: string) {
  await adminDb.insert(patients).values({ tenantId: A.tenantId, name, phone, phoneNormalized: phone });
}

async function register(input: Parameters<typeof createPatient>[1]) {
  const made = await createPatient(owner(), input);
  if (!made.ok) throw new Error(made.message);
  return made.value;
}

describe("filling an existing patient", () => {
  it("is offered only when date of birth and gender agree or one side is empty, and the match shows both sides", async () => {
    for (const n of ["1", "2", "3"]) await register({ name: `Fill Person ${n}`, phone: `900006660${n}`, dob: "1970-05-05", gender: "male" });
    await register({ name: "Fill Blank", phone: "9000066604" });
    const bytes = utf8File(
      csv([
        "name,phone,dob,gender",
        "Fill Person 1,9000066601,05/05/1970,male",
        "Fill Person 2,9000066602,06/06/1971,male",
        "Fill Person 3,9000066603,05/05/1970,female",
        "Fill Blank,9000066604,01/01/1990,female",
      ]),
    );
    const report = await dryRunOk(owner(), bytes);
    expect(report.rows.map((r) => r.status === "duplicate" && r.canFill)).toEqual([true, false, false, true]);
    expect(report.rows[1]).toMatchObject({
      rowDob: "1971-06-06",
      rowGender: "male",
      matches: [{ name: "Fill Person 2", dob: "1970-05-05", gender: "male", sameName: true }],
    });
  });

  it("never fills a patient whose recorded details disagree, even if the owner asks", async () => {
    const bytes = utf8File(csv(["name,phone,dob,address", "Fill Person 2,9000066602,06/06/1971,9 Hill Road"]));
    const report = await dryRunOk(owner(), bytes);
    const done = await commitPatientImport(owner(), { bytes }, commitInput(report, { "2": "fill" }));
    expect(done).toMatchObject({ ok: true, value: { filled: 0, skipped: 1 } });
  });
});

describe("a duplicate that changed after the check", () => {
  it("skips a fill the owner chose when reception registered another patient on that phone in between", async () => {
    const sam = await register({ name: "Stale Sam", phone: "9000066701" });
    const bytes = utf8File(csv(["name,phone,address", "Stale Sam,9000066701,1 Old Road"]));
    const report = await dryRunOk(owner(), bytes);
    expect(report.rows[0]).toMatchObject({ status: "duplicate", canFill: true });
    await registerSamePhone("Sam's Brother", "9000066701");
    const done = await commitPatientImport(owner(), { bytes }, commitInput(report, { "2": "fill" }));
    expect(done).toMatchObject({ ok: true, value: { filled: 0, created: 0, skipped: 1, staleRows: [2] } });
    const [after] = await adminDb.select().from(patients).where(eq(patients.id, sam.id));
    expect(after.address).toBeNull();
  });

  it("skips a create the owner chose when the matches changed, and imports when nothing changed", async () => {
    await register({ name: "Stale Kin", phone: "9000066801" });
    const bytes = utf8File(csv(["name,phone", "Stale Twin,9000066801"]));
    const report = await dryRunOk(owner(), bytes);
    expect(report.rows[0]).toMatchObject({ status: "duplicate", canCreate: true });
    const fresh = await commitPatientImport(owner(), { bytes }, commitInput(report, { "2": "create" }));
    expect(fresh).toMatchObject({ ok: true, value: { created: 1, staleRows: [] } });

    await register({ name: "Stale Kin Two", phone: "9000066802" });
    const bytes2 = utf8File(csv(["name,phone", "Stale Twin Two,9000066802"]));
    const report2 = await dryRunOk(owner(), bytes2);
    await registerSamePhone("Third", "9000066802");
    const stale = await commitPatientImport(owner(), { bytes: bytes2 }, commitInput(report2, { "2": "create" }));
    expect(stale).toMatchObject({ ok: true, value: { created: 0, skipped: 1, staleRows: [2] } });
  });

  it("refuses a mapping that is not the one that was checked, and missing fingerprints skip the row", async () => {
    const bytes = utf8File(csv(["name,phone", "Token Person,9000066901"]));
    const report = await dryRunOk(owner(), bytes);
    const other = { ...commitInput(report), mapping: { ...report.mapping, phone: null } };
    expect(await commitPatientImport(owner(), { bytes }, other)).toMatchObject({ ok: false, code: "conflict", field: "mapping" });
    expect(await commitPatientImport(owner(), { bytes }, { ...commitInput(report), checkToken: "nope" })).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("a re-import with a corrected mapping", () => {
  it("creates nobody twice: the same name with an equal or empty date of birth is a duplicate", async () => {
    const bytes = utf8File(csv(["name,phone,dob", "Remap Rani,9000077001,", "Remap Ravi,,12/12/1988"]));
    const first = await dryRunOk(owner(), bytes, { ...NO_PHONE, dob: null });
    expect(first.totals).toMatchObject({ new: 2 });
    expect(await commitPatientImport(owner(), { bytes }, commitInput(first))).toMatchObject({ ok: true, value: { created: 2 } });

    const second = await dryRunOk(owner(), bytes, { ...NO_PHONE, phone: 1, dob: 2 });
    expect(second.totals).toMatchObject({ new: 0, duplicate: 2 });
    const done = await commitPatientImport(owner(), { bytes }, commitInput(second));
    expect(done).toMatchObject({ ok: true, value: { created: 0, skipped: 2 } });
    const rows = await adminDb.select().from(patients).where(and(eq(patients.tenantId, A.tenantId), eq(patients.name, "Remap Rani")));
    expect(rows).toHaveLength(1);
  });

  it("flags a phone-less row that matches an existing patient, but not one with a different date of birth", async () => {
    await register({ name: "Soft Sita", dob: "1991-01-01" });
    const bytes = utf8File(csv(["name,dob", "Soft Sita,01/01/1991", "Soft Sita,02/02/1992"]));
    const report = await dryRunOk(owner(), bytes);
    expect(report.rows.map((r) => r.status)).toEqual(["duplicate", "new"]);
  });
});

describe("the check is bound to the clinic's own day", () => {
  it("accepts today and refuses tomorrow on the clinic's calendar while UTC is still yesterday", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-17T18:45:00Z") });
    expect(clinicLocalDate(new Date(), "Asia/Kolkata")).toBe("2026-11-18");
    const bytes = utf8File(csv(["name,dob", "Midnight Today,18/11/2026", "Midnight Tomorrow,19/11/2026"]));
    const report = await dryRunOk(owner(), bytes);
    expect(report.rows.map((r) => r.status === "invalid" && r.field)).toEqual([false, "dob"]);
    expect(report.totals).toMatchObject({ new: 1, invalid: 1 });
  });
});

describe("cell contents", () => {
  it("stores a formula-looking name verbatim and strips bidi and invisible characters from names and phones", async () => {
    const formula = '=HYPERLINK("http://evil")';
    const name = "Bidi\u202EName\u200B\u2066 Ok";
    const phone = "\u200E90000\u202A88801\u200B";
    expect([...name].filter((c) => c.codePointAt(0)! > 0x2000)).toHaveLength(3);
    const bytes = utf8File(csv([`name,phone`, `"${formula.replace(/"/g, '""')}",`, `${name},${phone}`]));
    const done = await commitPatientImport(owner(), { bytes }, commitInput(await dryRunOk(owner(), bytes)));
    expect(done).toMatchObject({ ok: true, value: { created: 2 } });
    const stored = await adminDb.select().from(patients).where(and(eq(patients.tenantId, A.tenantId), eq(patients.importId, done.ok ? done.value.importId : "")));
    expect(stored.map((p) => p.name).sort()).toEqual([formula, "BidiName Ok"].sort());
    expect(stored.find((p) => p.name === "BidiName Ok")?.phoneNormalized).toBe("9000088801");
  });

  it("echoes at most 200 characters of an invalid cell", async () => {
    const long = "x".repeat(1500);
    const bytes = utf8File(csv(["name,dob", `Long Cell,${long}`]));
    const report = await dryRunOk(owner(), bytes);
    const row = report.rows[0];
    expect(row.status === "invalid" && row.cells.every((c) => [...c].length <= 200)).toBe(true);
  });
});

describe("unique violations at commit", () => {
  it("reports a clash on the import row key as a retryable conflict", async () => {
    const bytes = utf8File(csv(["name,phone", "Race Person,9000099001"]));
    const report = await dryRunOk(owner(), bytes);
    const { importRowKey } = await import("@/server/services/patient-import");
    hooks.beforeAllocate = async () => {
      await adminDb.insert(patients).values({ tenantId: A.tenantId, name: "Race Person", importRowKey: importRowKey("Race Person", "9000099001", null) });
      hooks.beforeAllocate = null;
    };
    expect(await commitPatientImport(owner(), { bytes }, commitInput(report))).toMatchObject({ ok: false, code: "conflict" });
  });

  it("does not hide a clash on another key (the patient number) behind that message", async () => {
    const bytes = utf8File(csv(["name,phone", "Number Clash,9000099002"]));
    const report = await dryRunOk(owner(), bytes);
    hooks.beforeAllocate = async () => {
      const [row] = await adminDb
        .select()
        .from(tenantCounters)
        .where(and(eq(tenantCounters.tenantId, A.tenantId), eq(tenantCounters.name, "patient")));
      await adminDb.insert(patients).values({ tenantId: A.tenantId, name: "Number Squatter", patientNo: (row?.lastNo ?? 0) + 1 });
      hooks.beforeAllocate = null;
    };
    await expect(commitPatientImport(owner(), { bytes }, commitInput(report))).rejects.toThrow();
  });
});

describe("dry-run only reads", () => {
  it("writes nothing", async () => {
    const before = await adminDb.select().from(patients).where(eq(patients.tenantId, A.tenantId));
    await dryRunPatientImport(owner(), { bytes: utf8File(csv(["name", "Reads Only"])) });
    expect(await adminDb.select().from(patients).where(eq(patients.tenantId, A.tenantId))).toHaveLength(before.length);
  });
});

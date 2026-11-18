// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { patients } from "@/server/db/schema";
import { commitFields } from "@/lib/import/commit-choices";
import { createPatient } from "@/server/services/patients";
import { commitPatientImport } from "@/server/services/patient-import";
import { csv, utf8File } from "../helpers/csv-files";
import { commitInput, dryRunOk } from "../helpers/patient-import";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
const owner = () => A.as("owner");

beforeAll(async () => {
  A = await createTestTenant("import-match");
});
afterAll(async () => {
  await A.cleanup();
});

async function register(input: Parameters<typeof createPatient>[1]) {
  const made = await createPatient(owner(), input);
  if (!made.ok) throw new Error(made.message);
  return made.value;
}

describe("matches by name only (a namesake is not the same person)", () => {
  it("never offers a fill or a new registration, and shows the basis, for two Rameshes with different phones", async () => {
    const ramesh = await register({ name: "Ramesh Kumar", phone: "9000055501", allergies: ["Sulfa"] });
    const bytes = utf8File(csv(["name,phone,allergies,address", "Ramesh Kumar,9000055502,Penicillin,2 Mill Road"]));
    const report = await dryRunOk(owner(), bytes);
    expect(report.rows[0]).toMatchObject({
      status: "duplicate",
      canFill: false,
      canCreate: false,
      matches: [{ name: "Ramesh Kumar", sameName: true, basis: "name" }],
    });
    // Even a hand-made request to fill or create changes nothing.
    for (const decision of ["fill", "create"]) {
      const done = await commitPatientImport(owner(), { bytes }, { ...commitInput(report), ...commitFields([{ ...report.rows[0], canFill: true, canCreate: true }], { "2": decision }) });
      expect(done).toMatchObject({ ok: true, value: { created: 0, filled: 0, skipped: 1 } });
    }
    const [after] = await adminDb.select().from(patients).where(eq(patients.id, ramesh.id));
    expect(after.allergies).toEqual(["Sulfa"]);
    expect(after.address).toBeNull();
  });

  it("offers a fill when the phone matches as well, and shows the phone basis", async () => {
    await register({ name: "Geeta Rao", phone: "9000055511" });
    const bytes = utf8File(csv(["name,phone,address", "Geeta Rao,9000055511,3 Lake View"]));
    const report = await dryRunOk(owner(), bytes);
    expect(report.rows[0]).toMatchObject({ canFill: true, canCreate: true, matches: [{ basis: "phone", sameName: true }] });
  });

  it("offers a fill by name only when the patient has no phone and the birth dates are recorded and equal", async () => {
    await register({ name: "Dev Anand", dob: "1980-04-04" });
    await register({ name: "Dev Blank" });
    await register({ name: "Dev Phoned", dob: "1980-04-04", phone: "9000055521" });
    const bytes = utf8File(
      csv([
        "name,phone,dob,address",
        "Dev Anand,9000055522,04/04/1980,Same DOB and no phone on file",
        "Dev Blank,9000055523,,Nothing to compare",
        "Dev Phoned,9000055524,04/04/1980,Phone on file differs",
      ]),
    );
    const report = await dryRunOk(owner(), bytes);
    expect(report.rows.map((r) => r.status === "duplicate" && [r.canFill, r.canCreate])).toEqual([
      [true, false],
      [false, false],
      [false, false],
    ]);
    const done = await commitPatientImport(owner(), { bytes }, commitInput(report, { "2": "fill", "3": "fill", "4": "fill" }));
    expect(done).toMatchObject({ ok: true, value: { filled: 1, created: 0, skipped: 2 } });
  });

  it("still allows a family member on the same phone to be registered", async () => {
    await register({ name: "Sunita Joshi", phone: "9000055531" });
    const report = await dryRunOk(owner(), utf8File(csv(["name,phone", "Anil Joshi,9000055531"])));
    expect(report.rows[0]).toMatchObject({ canFill: false, canCreate: true, matches: [{ basis: "phone", sameName: false }] });
  });
});

describe("a file of 5,000 duplicate rows", () => {
  const COUNT = 5_000;
  it("is checked and committed with the default choice (skip), sending next to nothing", async () => {
    const names = Array.from({ length: COUNT }, (_, i) => `Bulk Patient ${String(i).padStart(4, "0")}`);
    const phone = (i: number) => String(9100000000 + i);
    for (let i = 0; i < COUNT; i += 1000) {
      await adminDb.insert(patients).values(
        names.slice(i, i + 1000).map((name, j) => ({ tenantId: A.tenantId, name, phone: phone(i + j), phoneNormalized: phone(i + j) })),
      );
    }
    const bytes = utf8File(csv(["name,phone", ...names.map((name, i) => `${name},${phone(i)}`)]));
    expect(bytes.byteLength).toBeLessThan(900_000);
    const report = await dryRunOk(owner(), bytes);
    expect(report.totals).toMatchObject({ rows: COUNT, duplicate: COUNT, new: 0 });

    const input = commitInput(report);
    expect(input.choices).toBe("");
    expect(input.dups.length).toBeLessThanOrEqual(1_400);
    const done = await commitPatientImport(owner(), { bytes }, input);
    expect(done).toMatchObject({ ok: true, value: { created: 0, filled: 0, skipped: COUNT, staleCount: 0 } });
    const count = await adminDb
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.tenantId, A.tenantId), inArray(patients.name, names.slice(0, 50))));
    expect(count).toHaveLength(50);
  }, 120_000);
});

describe("rows that were duplicates but are not any more", () => {
  it("are not created when the owner skipped them, even though they now look new", async () => {
    const gone = await register({ name: "Vanished Vimal", phone: "9000055541" });
    const bytes = utf8File(csv(["name,phone", "Vanished Vimal,9000055541"]));
    const report = await dryRunOk(owner(), bytes);
    expect(report.rows[0]).toMatchObject({ status: "duplicate" });
    await adminDb.update(patients).set({ deletedAt: new Date() }).where(eq(patients.id, gone.id));
    const done = await commitPatientImport(owner(), { bytes }, commitInput(report));
    expect(done).toMatchObject({ ok: true, value: { created: 0, skipped: 1 } });
  });

  it("are reported as stale when the owner had chosen to register them", async () => {
    const gone = await register({ name: "Vanished Vani", phone: "9000055551" });
    const bytes = utf8File(csv(["name,phone", "Vanished Vani,9000055551"]));
    const report = await dryRunOk(owner(), bytes);
    await adminDb.update(patients).set({ deletedAt: new Date() }).where(eq(patients.id, gone.id));
    const done = await commitPatientImport(owner(), { bytes }, commitInput(report, { "2": "create" }));
    expect(done).toMatchObject({ ok: true, value: { created: 0, staleRows: [2] } });
  });
});

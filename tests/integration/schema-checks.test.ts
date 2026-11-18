import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@/server/db/schema";
import { adminDb } from "@/server/db/admin";
import { pgErrorInfo } from "@/server/db/errors";
import { doctors, medicineFavourites, memberships, patients, prescriptionItems, prescriptions, tenantMedicines, users, visits } from "@/server/db/schema";
import { PERIODICITIES } from "@/lib/domain/rx-options";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
let draftId = "";
let doctorA = "";

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").not.toBeNull();
  expect(pgErrorInfo(error).code).toBe(code);
}

beforeAll(async () => {
  A = await createTestTenant("checks-a");
  B = await createTestTenant("checks-b");
  const [patient] = await adminDb.insert(patients).values({ tenantId: A.tenantId, name: "Checks Patient" }).returning();
  const [visit] = await adminDb.insert(visits).values({ tenantId: A.tenantId, patientId: patient.id, status: "draft" }).returning();
  const [rx] = await adminDb.insert(prescriptions).values({ tenantId: A.tenantId, visitId: visit.id, status: "draft" }).returning();
  draftId = rx.id;
  const [doc] = await adminDb.select({ id: doctors.id }).from(doctors).where(eq(doctors.tenantId, A.tenantId)).limit(1);
  doctorA = doc.id;
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

const item = (values: Partial<typeof prescriptionItems.$inferInsert>) =>
  adminDb.insert(prescriptionItems).values({ tenantId: A.tenantId, prescriptionId: draftId, drugName: "Check drug", ...values });
const favourite = (key: string, values: Partial<typeof medicineFavourites.$inferInsert>) =>
  adminDb.insert(medicineFavourites).values({ tenantId: A.tenantId, doctorId: doctorA, nameKey: key, drugName: key, ...values });

describe("clinical value checks (the same rules as src/server/validation/prescription.ts)", () => {
  it.each([
    ["an unknown periodicity", { periodicity: "hourly" }],
    ["a dose that is not a quarter step", { doseMorning: 0.3 }],
    ["a negative dose", { doseEvening: -1 }],
    ["a dose above 99", { doseNight: 99.25 }],
    ["a zero duration", { durationValue: 0 }],
    ["a duration above 365", { durationValue: 366 }],
    ["more than 365 total days", { durationDays: 400 }],
  ])("refuses %s on a prescription item, even on the admin connection (23514)", async (_label, values) => {
    await expectCode(item(values), "23514");
  });

  it("accepts every periodicity the editor offers, quarter-step doses, and the Plan 1A day count", async () => {
    for (const periodicity of PERIODICITIES) await item({ periodicity });
    await item({ doseMorning: 0.25, doseAfternoon: 0.5, doseEvening: 0.75, doseNight: 99 });
    await item({ durationValue: 12, durationUnit: "months", durationDays: 360 });
    await item({ durationDays: 365 });
  });

  it.each([
    ["an unknown periodicity", { periodicity: "hourly" }],
    ["a dose that is not a quarter step", { doseAfternoon: 1.1 }],
    ["a zero duration", { durationValue: 0 }],
  ])("refuses %s on a favourite (23514)", async (label, values) => {
    await expectCode(favourite(`fav-${label}`, values), "23514");
  });
});

describe("indexes on the 0010 foreign-key columns", () => {
  it("exist under their names", async () => {
    const rows = await adminDb.execute<{ indexname: string }>(sql`
      select indexname::text as indexname from pg_indexes
       where schemaname = 'public'
         and indexname in ('visits_tenant_doctor_idx', 'visits_tenant_branch_idx', 'prescriptions_tenant_template_version_idx')
       order by 1`);
    expect(rows.map((r) => r.indexname)).toEqual([
      "prescriptions_tenant_template_version_idx",
      "visits_tenant_branch_idx",
      "visits_tenant_doctor_idx",
    ]);
  });
});

describe("tenant_medicines.created_by", () => {
  it("must name a member of the same clinic (23503), or nobody", async () => {
    const own = A.as("doctor").userId;
    const foreign = B.as("doctor").userId;
    await adminDb.insert(tenantMedicines).values({ tenantId: A.tenantId, name: "Own Med", nameKey: "own med", createdBy: own });
    await adminDb.insert(tenantMedicines).values({ tenantId: A.tenantId, name: "Nobody Med", nameKey: "nobody med", createdBy: null });
    await expectCode(
      adminDb.insert(tenantMedicines).values({ tenantId: A.tenantId, name: "Foreign Med", nameKey: "foreign med", createdBy: foreign }),
      "23503",
    );
  });

  it("is cleared, and tenant_id kept, when the member leaves the clinic", async () => {
    const [user] = await adminDb.insert(users).values({ email: `leaver-${Date.now()}@example.com`, name: "Leaver" }).returning();
    try {
      await adminDb.insert(memberships).values({ tenantId: A.tenantId, userId: user.id, role: "doctor" });
      const [med] = await adminDb
        .insert(tenantMedicines)
        .values({ tenantId: A.tenantId, name: "Leaver Med", nameKey: "leaver med", createdBy: user.id })
        .returning();
      await adminDb.delete(memberships).where(eq(memberships.userId, user.id));
      const [after] = await adminDb.select().from(tenantMedicines).where(eq(tenantMedicines.id, med.id));
      expect(after).toMatchObject({ tenantId: A.tenantId, createdBy: null });
    } finally {
      await adminDb.delete(users).where(eq(users.id, user.id));
    }
  });
});

describe("the schema declares every CHECK constraint", () => {
  it("lists exactly the CHECK constraints that exist in the database", async () => {
    const tables = Object.values(schema).filter((value) => is(value, PgTable)) as PgTable[];
    const declared = tables
      .flatMap((table) => getTableConfig(table).checks.map((c) => c.name))
      .sort();
    const rows = await adminDb.execute<{ conname: string }>(sql`
      select conname::text as conname from pg_constraint
       where contype = 'c' and connamespace = 'public'::regnamespace order by 1`);
    expect(declared).toEqual(rows.map((r) => r.conname).sort());
    expect(declared.length).toBeGreaterThanOrEqual(27);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import {
  doctors,
  globalClinicalTerms,
  globalMedicines,
  medicineFavourites,
  patients,
  prescriptionItems,
  prescriptions,
  tenantMedicines,
  tenants,
  visits,
} from "@/server/db/schema";

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const globalKey = `zzschema ${stamp}`;
let tenantId = "";
let otherTenantId = "";
let doctorId = "";
let otherDoctorId = "";

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").not.toBeNull();
  expect(pgErrorInfo(error).code).toBe(code);
}

/** A draft visit + prescription + item using every new column. */
async function clinicalDraft() {
  const [patient] = await adminDb.insert(patients).values({ tenantId, name: "Schema Patient" }).returning();
  const [visit] = await adminDb
    .insert(visits)
    .values({
      tenantId,
      patientId: patient.id,
      status: "draft",
      complaints: ["Fever"],
      medicalHistory: ["DM"],
      drugHistory: ["Metformin"],
      examinationNotes: "Throat congested",
      vitals: { pulse: 88, spo2: 97 },
      investigations: [{ name: "CBC", instructions: "Fasting" }],
      followUpReason: "Review reports",
    })
    .returning();
  const [rx] = await adminDb.insert(prescriptions).values({ tenantId, visitId: visit.id, status: "draft" }).returning();
  const [item] = await adminDb
    .insert(prescriptionItems)
    .values({
      tenantId,
      prescriptionId: rx.id,
      drugName: "DOLO 650MG",
      genericName: "Paracetamol 650Mg",
      doseMorning: 1,
      doseAfternoon: 0,
      doseNight: 1,
      periodicity: "daily",
      durationValue: 5,
      durationUnit: "days",
      durationDays: 5,
    })
    .returning();
  return { visit, rx, item };
}

async function finalize(rxId: string, visitId: string) {
  await adminDb
    .update(prescriptions)
    .set({ status: "finalized", finalizedAt: new Date() })
    .where(eq(prescriptions.id, rxId));
  await adminDb.update(visits).set({ status: "finalized", finalizedAt: new Date() }).where(eq(visits.id, visitId));
}

beforeAll(async () => {
  const [t] = await adminDb.insert(tenants).values({ name: "Schema1B", slug: `schema1b-${stamp}` }).returning();
  const [o] = await adminDb.insert(tenants).values({ name: "Schema1B-2", slug: `schema1b2-${stamp}` }).returning();
  tenantId = t.id;
  otherTenantId = o.id;
  const [d] = await adminDb.insert(doctors).values({ tenantId }).returning();
  const [od] = await adminDb.insert(doctors).values({ tenantId: otherTenantId }).returning();
  doctorId = d.id;
  otherDoctorId = od.id;
});

afterAll(async () => {
  // Deleting a tenant must still cascade through finalized records and the new tables.
  await adminDb.delete(tenants).where(eq(tenants.id, tenantId));
  await adminDb.delete(tenants).where(eq(tenants.id, otherTenantId));
  expect(await adminDb.select().from(visits).where(eq(visits.tenantId, tenantId))).toHaveLength(0);
  expect(await adminDb.select().from(prescriptionItems).where(eq(prescriptionItems.tenantId, tenantId))).toHaveLength(0);
  expect(await adminDb.select().from(tenantMedicines).where(eq(tenantMedicines.tenantId, tenantId))).toHaveLength(0);
  expect(await adminDb.select().from(medicineFavourites).where(eq(medicineFavourites.tenantId, tenantId))).toHaveLength(0);
});

describe("new clinical columns", () => {
  it("round-trip on a draft and stay editable while it is a draft", async () => {
    const { visit, rx, item } = await clinicalDraft();
    expect(visit.vitals).toEqual({ pulse: 88, spo2: 97 });
    expect(visit.investigations).toEqual([{ name: "CBC", instructions: "Fasting" }]);
    expect(rx.draftRevision).toBe(0);
    expect(item.doseMorning).toBe(1);
    expect(item.doseEvening).toBeNull();
    expect(item.isSos).toBe(false);

    await adminDb.update(visits).set({ complaints: ["Cough"] }).where(eq(visits.id, visit.id));
    await adminDb.update(prescriptionItems).set({ doseMorning: 0.5 }).where(eq(prescriptionItems.id, item.id));
    await adminDb.update(prescriptions).set({ draftRevision: 1 }).where(eq(prescriptions.id, rx.id));
    const [after] = await adminDb.select().from(prescriptionItems).where(eq(prescriptionItems.id, item.id));
    expect(after.doseMorning).toBe(0.5);
  });

  it("are frozen with the rest of a finalized prescription, even on the admin connection", async () => {
    const { visit, rx, item } = await clinicalDraft();
    await finalize(rx.id, visit.id);

    await expectCode(adminDb.update(visits).set({ complaints: ["Changed"] }).where(eq(visits.id, visit.id)), "23000");
    await expectCode(adminDb.update(visits).set({ vitals: { pulse: 200 } }).where(eq(visits.id, visit.id)), "23000");
    await expectCode(adminDb.update(visits).set({ investigations: [] }).where(eq(visits.id, visit.id)), "23000");
    await expectCode(
      adminDb.update(visits).set({ examinationNotes: "x", followUpReason: "y" }).where(eq(visits.id, visit.id)),
      "23000",
    );
    await expectCode(adminDb.update(prescriptionItems).set({ doseNight: 3 }).where(eq(prescriptionItems.id, item.id)), "23000");
    await expectCode(
      adminDb.update(prescriptionItems).set({ isSos: true, durationUnit: "weeks" }).where(eq(prescriptionItems.id, item.id)),
      "23000",
    );
    await expectCode(adminDb.update(prescriptions).set({ draftRevision: 99 }).where(eq(prescriptions.id, rx.id)), "23000");

    const [unchanged] = await adminDb.select().from(visits).where(eq(visits.id, visit.id));
    expect(unchanged.vitals).toEqual({ pulse: 88, spo2: 97 });
    expect(unchanged.complaints).toEqual(["Fever"]);
  });

  it("are frozen on a still-draft visit as soon as its prescription is finalized (the 0008 visit guard)", async () => {
    const { visit, rx } = await clinicalDraft();
    await adminDb.update(prescriptions).set({ status: "finalized", finalizedAt: new Date() }).where(eq(prescriptions.id, rx.id));

    await expectCode(adminDb.update(visits).set({ complaints: ["Changed"] }).where(eq(visits.id, visit.id)), "23000");
    await expectCode(adminDb.update(visits).set({ investigations: [] }).where(eq(visits.id, visit.id)), "23000");
    await expectCode(adminDb.update(visits).set({ vitals: { pulse: 60 } }).where(eq(visits.id, visit.id)), "23000");
    // The plain draft -> finalized flip is still accepted, with every new column unchanged.
    await adminDb.update(visits).set({ status: "finalized", finalizedAt: new Date() }).where(eq(visits.id, visit.id));
    const [flipped] = await adminDb.select().from(visits).where(eq(visits.id, visit.id));
    expect(flipped).toMatchObject({ status: "finalized", complaints: ["Fever"], vitals: { pulse: 88, spo2: 97 } });
  });

  it("rejects an unknown duration unit at the database", async () => {
    const { rx } = await clinicalDraft();
    await expectCode(
      adminDb.insert(prescriptionItems).values({ tenantId, prescriptionId: rx.id, drugName: "X", durationUnit: "fortnights" }),
      "23514",
    );
  });
});

describe("tenant catalogue tables", () => {
  it("isolate clinic medicines and favourites by tenant", async () => {
    await withTenant(tenantId, (tx) =>
      tx.insert(tenantMedicines).values({ tenantId, name: "My Clinic Syrup", nameKey: "my clinic syrup" }),
    );
    await withTenant(tenantId, (tx) =>
      tx.insert(medicineFavourites).values({ tenantId, doctorId, nameKey: "my clinic syrup", drugName: "My Clinic Syrup" }),
    );
    expect(await withTenant(tenantId, (tx) => tx.select().from(tenantMedicines))).toHaveLength(1);
    expect(await withTenant(otherTenantId, (tx) => tx.select().from(tenantMedicines))).toHaveLength(0);
    expect(await withTenant(otherTenantId, (tx) => tx.select().from(medicineFavourites))).toHaveLength(0);
  });

  it("refuse a favourite that points at another clinic's doctor (composite key)", async () => {
    const row = { tenantId, doctorId: otherDoctorId, nameKey: "leak", drugName: "Leak" };
    const attempts = [
      async () => {
        await adminDb.insert(medicineFavourites).values(row);
      },
      async () => {
        await withTenant(tenantId, (tx) => tx.insert(medicineFavourites).values(row));
      },
    ];
    for (const attempt of attempts) {
      const error = await attempt().then(
        () => null,
        (e: unknown) => e,
      );
      expect(pgErrorInfo(error)).toMatchObject({ code: "23503", constraint: "medicine_favourites_doctor_fk" });
    }
  });

  it("delete a doctor's favourites with the doctor", async () => {
    const [extra] = await adminDb.insert(doctors).values({ tenantId }).returning();
    await adminDb.insert(medicineFavourites).values({ tenantId, doctorId: extra.id, nameKey: "gone", drugName: "Gone" });
    await adminDb.delete(doctors).where(eq(doctors.id, extra.id));
    expect(await adminDb.select().from(medicineFavourites).where(eq(medicineFavourites.doctorId, extra.id))).toHaveLength(0);
  });

  it("refuse rows written for another tenant", async () => {
    await expectCode(
      withTenant(otherTenantId, (tx) => tx.insert(tenantMedicines).values({ tenantId, name: "Leak", nameKey: "leak" })),
      "42501",
    );
  });

  it("return nothing when no tenant is set", async () => {
    expect(await db.select().from(tenantMedicines)).toHaveLength(0);
    expect(await db.select().from(medicineFavourites)).toHaveLength(0);
  });
});

describe("global reference tables", () => {
  beforeAll(async () => {
    await adminDb.insert(globalMedicines).values({ name: `ZZSCHEMA ${stamp} TAB`, nameKey: `${globalKey} tab`, genericName: "Testamol" });
    await adminDb.insert(globalClinicalTerms).values({ kind: "complaint", name: `ZZSCHEMA ${stamp} ACHE`, nameKey: `${globalKey} ache` });
  });

  afterAll(async () => {
    await adminDb.delete(globalMedicines).where(like(globalMedicines.nameKey, `${globalKey}%`));
    await adminDb.delete(globalClinicalTerms).where(like(globalClinicalTerms.nameKey, `${globalKey}%`));
  });

  it("are readable by every clinic", async () => {
    for (const id of [tenantId, otherTenantId]) {
      const meds = await withTenant(id, (tx) =>
        tx.select().from(globalMedicines).where(eq(globalMedicines.nameKey, `${globalKey} tab`)),
      );
      expect(meds).toHaveLength(1);
      const terms = await withTenant(id, (tx) =>
        tx.select().from(globalClinicalTerms).where(eq(globalClinicalTerms.nameKey, `${globalKey} ache`)),
      );
      expect(terms).toHaveLength(1);
    }
  });

  it("are read-only for the application role", async () => {
    await expectCode(
      withTenant(tenantId, (tx) => tx.insert(globalMedicines).values({ name: "Injected", nameKey: `${globalKey} injected` })),
      "42501",
    );
    await expectCode(
      withTenant(tenantId, (tx) =>
        tx.update(globalMedicines).set({ genericName: "Tampered" }).where(eq(globalMedicines.nameKey, `${globalKey} tab`)),
      ),
      "42501",
    );
    await expectCode(
      withTenant(tenantId, (tx) => tx.delete(globalMedicines).where(eq(globalMedicines.nameKey, `${globalKey} tab`))),
      "42501",
    );
    await expectCode(
      withTenant(tenantId, (tx) =>
        tx.insert(globalClinicalTerms).values({ kind: "test", name: "Injected", nameKey: `${globalKey} injected` }),
      ),
      "42501",
    );
    await expectCode(db.delete(globalClinicalTerms).where(like(globalClinicalTerms.nameKey, `${globalKey}%`)), "42501");

    const [still] = await adminDb.select().from(globalMedicines).where(eq(globalMedicines.nameKey, `${globalKey} tab`));
    expect(still.genericName).toBe("Testamol");
  });

  it("reject unknown term kinds", async () => {
    await expectCode(
      adminDb.insert(globalClinicalTerms).values({ kind: "spell", name: "X", nameKey: `${globalKey} spell` }),
      "23514",
    );
  });
});

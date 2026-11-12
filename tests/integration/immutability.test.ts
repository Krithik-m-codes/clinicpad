import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import {
  patients,
  prescriptionItems,
  prescriptions,
  tenantCounters,
  tenants,
  visits,
} from "@/server/db/schema";

let tenantId = "";
let otherTenantId = "";

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").not.toBeNull();
  expect(pgErrorInfo(error).code).toBe(code);
}

/** A visit + draft prescription with one item. */
async function draftRx(rxNo: number | null = 1) {
  const [patient] = await adminDb.insert(patients).values({ tenantId, name: "Immutable P" }).returning();
  const [visit] = await adminDb
    .insert(visits)
    .values({ tenantId, patientId: patient.id, status: "draft" })
    .returning();
  const [rx] = await adminDb
    .insert(prescriptions)
    .values({ tenantId, visitId: visit.id, rxNo, status: "draft" })
    .returning();
  const [item] = await adminDb
    .insert(prescriptionItems)
    .values({ tenantId, prescriptionId: rx.id, drugName: "Paracetamol" })
    .returning();
  return { patient, visit, rx, item };
}

async function finalize(rxId: string, visitId: string) {
  await adminDb.update(prescriptions).set({ status: "finalized", finalizedAt: new Date() }).where(eq(prescriptions.id, rxId));
  await adminDb.update(visits).set({ status: "finalized", finalizedAt: new Date() }).where(eq(visits.id, visitId));
}

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const [t] = await adminDb.insert(tenants).values({ name: "Immut", slug: `immut-${stamp}` }).returning();
  const [o] = await adminDb.insert(tenants).values({ name: "Immut2", slug: `immut2-${stamp}` }).returning();
  tenantId = t.id;
  otherTenantId = o.id;
});

afterAll(async () => {
  // Deleting the tenant must still work while it owns finalized and amended records.
  await adminDb.delete(tenants).where(eq(tenants.id, tenantId));
  await adminDb.delete(tenants).where(eq(tenants.id, otherTenantId));
  const left = await adminDb.select().from(prescriptions).where(eq(prescriptions.tenantId, tenantId));
  expect(left).toHaveLength(0);
});

describe("draft prescriptions stay editable", () => {
  it("allows editing, deleting, and re-inserting items while draft", async () => {
    const { rx, item } = await draftRx(null);
    await adminDb.update(prescriptionItems).set({ dose: "2 tablets" }).where(eq(prescriptionItems.id, item.id));
    await adminDb.delete(prescriptionItems).where(eq(prescriptionItems.prescriptionId, rx.id));
    await adminDb.insert(prescriptionItems).values({ tenantId, prescriptionId: rx.id, drugName: "Cetirizine" });
    const rows = await adminDb.select().from(prescriptionItems).where(eq(prescriptionItems.prescriptionId, rx.id));
    expect(rows.map((r) => r.drugName)).toEqual(["Cetirizine"]);
  });

  it("allows several drafts without an Rx number", async () => {
    await draftRx(null);
    await draftRx(null);
  });
});

describe("finalized records are immutable, even on the admin connection", () => {
  it("rejects changing, deleting, or adding to a finalized prescription", async () => {
    const { rx, visit, item } = await draftRx(101);
    await finalize(rx.id, visit.id);

    await expectCode(adminDb.update(prescriptions).set({ rxNo: 999 }).where(eq(prescriptions.id, rx.id)), "23000");
    await expectCode(adminDb.delete(prescriptions).where(eq(prescriptions.id, rx.id)), "23000");
    await expectCode(
      adminDb.insert(prescriptionItems).values({ tenantId, prescriptionId: rx.id, drugName: "Sneaky" }),
      "23000",
    );
    await expectCode(adminDb.update(prescriptionItems).set({ dose: "9" }).where(eq(prescriptionItems.id, item.id)), "23000");
    await expectCode(adminDb.delete(prescriptionItems).where(eq(prescriptionItems.id, item.id)), "23000");
    await expectCode(adminDb.update(visits).set({ advice: "changed" }).where(eq(visits.id, visit.id)), "23000");
    await expectCode(adminDb.delete(visits).where(eq(visits.id, visit.id)), "23000");

    const [unchanged] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, rx.id));
    expect(unchanged.rxNo).toBe(101);
  });

  it("allows only the finalized -> amended status flip and nothing else", async () => {
    const { rx, visit } = await draftRx(102);
    await finalize(rx.id, visit.id);

    await expectCode(
      adminDb.update(prescriptions).set({ status: "amended", rxNo: 555 }).where(eq(prescriptions.id, rx.id)),
      "23000",
    );
    await adminDb.update(prescriptions).set({ status: "amended" }).where(eq(prescriptions.id, rx.id));
    const [flipped] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, rx.id));
    expect(flipped.status).toBe("amended");

    // Once amended it is still frozen.
    await expectCode(adminDb.update(prescriptions).set({ status: "draft" }).where(eq(prescriptions.id, rx.id)), "23000");
  });
});

describe("one open amendment per prescription", () => {
  it("rejects a second draft amendment of the same parent", async () => {
    const { rx, visit, patient } = await draftRx(103);
    await finalize(rx.id, visit.id);

    const makeChild = async (version: number) => {
      const [v] = await adminDb.insert(visits).values({ tenantId, patientId: patient.id, status: "draft" }).returning();
      return adminDb.insert(prescriptions).values({
        tenantId,
        visitId: v.id,
        rxNo: 103,
        version,
        status: "draft",
        parentPrescriptionId: rx.id,
        amendmentReason: "Dose correction",
      });
    };
    await makeChild(2);
    await expectCode(makeChild(3), "23505");
  });
});

describe("tenant counters", () => {
  it("is invisible to other tenants (RLS)", async () => {
    await adminDb.insert(tenantCounters).values({ tenantId, name: "rx", lastNo: 7 }).onConflictDoNothing();
    const mine = await withTenant(tenantId, (tx) => tx.select().from(tenantCounters));
    expect(mine.some((r) => r.name === "rx")).toBe(true);
    const theirs = await withTenant(otherTenantId, (tx) => tx.select().from(tenantCounters));
    expect(theirs).toHaveLength(0);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import { patients, prescriptionItems, prescriptions, tenantCounters, tenants, visits } from "@/server/db/schema";
import { allocateNumber } from "@/server/services/numbering";

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
let T = "";
let nextRxNo = 700;

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").not.toBeNull();
  expect(pgErrorInfo(error).code).toBe(code);
}

/** A patient, a draft visit, a draft prescription and one item. */
async function draftRecords(rxNo: number | null = null) {
  const [patient] = await adminDb.insert(patients).values({ tenantId: T, name: "Integrity Patient" }).returning();
  const [visit] = await adminDb.insert(visits).values({ tenantId: T, patientId: patient.id, status: "draft" }).returning();
  const [rx] = await adminDb.insert(prescriptions).values({ tenantId: T, visitId: visit.id, rxNo, status: "draft" }).returning();
  await adminDb.insert(prescriptionItems).values({ tenantId: T, prescriptionId: rx.id, drugName: "Paracetamol" });
  return { patient, visit, rx };
}

/** Freeze the way the services do: the prescription first, then its visit. */
async function finalize(rxId: string, visitId: string) {
  await adminDb.update(prescriptions).set({ status: "finalized", finalizedAt: new Date() }).where(eq(prescriptions.id, rxId));
  await adminDb.update(visits).set({ status: "finalized", finalizedAt: new Date() }).where(eq(visits.id, visitId));
}

/** A finalized version 1 and an amendment draft (version 2) that points at it. */
async function versionOneWithAmendmentDraft() {
  nextRxNo += 1;
  const v1 = await draftRecords(nextRxNo);
  await finalize(v1.rx.id, v1.visit.id);
  const [childVisit] = await adminDb.insert(visits).values({ tenantId: T, patientId: v1.patient.id, status: "draft" }).returning();
  const [child] = await adminDb
    .insert(prescriptions)
    .values({ tenantId: T, visitId: childVisit.id, rxNo: nextRxNo, version: 2, status: "draft", parentPrescriptionId: v1.rx.id, amendmentReason: "Dose correction" })
    .returning();
  return { parent: v1.rx, child, childVisit };
}

beforeAll(async () => {
  const [t] = await adminDb.insert(tenants).values({ name: "Integrity 1D", slug: `integrity-${stamp}` }).returning();
  T = t.id;
});

afterAll(async () => {
  // Offboarding still erases frozen records with the new triggers in place.
  await adminDb.delete(tenants).where(eq(tenants.id, T));
  expect(await adminDb.select().from(prescriptions).where(eq(prescriptions.tenantId, T))).toHaveLength(0);
});

describe("tenant_counters", () => {
  it("lets the application role create and increment a counter", async () => {
    const first = await withTenant(T, (tx) => allocateNumber(tx, T, "patient"));
    const second = await withTenant(T, (tx) => allocateNumber(tx, T, "patient"));
    expect(second).toBe(first + 1);
  });

  it("refuses DELETE and TRUNCATE for the application role (42501)", async () => {
    await expectCode(withTenant(T, (tx) => tx.delete(tenantCounters)), "42501");
    await expectCode(withTenant(T, (tx) => tx.execute(sql`truncate tenant_counters`)), "42501");
    const [row] = await adminDb.select().from(tenantCounters).where(eq(tenantCounters.tenantId, T));
    expect(row.lastNo).toBeGreaterThan(0);
  });
});

describe("rows are born as drafts", () => {
  it.each(["finalized", "amended"])("refuses a prescription inserted as %s, on every connection (23000)", async (status) => {
    const { visit } = await draftRecords();
    await expectCode(adminDb.insert(prescriptions).values({ tenantId: T, visitId: visit.id, status }), "23000");
    await expectCode(withTenant(T, (tx) => tx.insert(prescriptions).values({ tenantId: T, visitId: visit.id, status })), "23000");
  });

  it("refuses a visit inserted as finalized (23000)", async () => {
    const { patient } = await draftRecords();
    await expectCode(adminDb.insert(visits).values({ tenantId: T, patientId: patient.id, status: "finalized" }), "23000");
    await expectCode(withTenant(T, (tx) => tx.insert(visits).values({ tenantId: T, patientId: patient.id, status: "finalized" })), "23000");
  });

  it("still accepts drafts, including an amendment draft that carries its parent's number", async () => {
    const { child } = await versionOneWithAmendmentDraft();
    expect(child.status).toBe("draft");
    expect(child.rxNo).toBe(nextRxNo);
  });
});

describe("status vocabularies", () => {
  it("refuses an unknown prescription or visit status (23514)", async () => {
    const { rx, visit } = await draftRecords();
    await expectCode(adminDb.update(prescriptions).set({ status: "void" }).where(eq(prescriptions.id, rx.id)), "23514");
    await expectCode(adminDb.update(visits).set({ status: "closed" }).where(eq(visits.id, visit.id)), "23514");
  });

  it("installs both constraints under their names", async () => {
    const rows = await adminDb.execute<{ conname: string }>(sql`
      select conname::text as conname from pg_constraint
       where connamespace = 'public'::regnamespace and conname in ('prescriptions_status_check', 'visits_status_check')
       order by 1`);
    expect(rows.map((r) => r.conname)).toEqual(["prescriptions_status_check", "visits_status_check"]);
  });
});

describe("a version is superseded only by a finalized successor", () => {
  it("refuses the finalized -> amended flip when no amendment exists (23000)", async () => {
    nextRxNo += 1;
    const { rx, visit } = await draftRecords(nextRxNo);
    await finalize(rx.id, visit.id);
    await expectCode(adminDb.update(prescriptions).set({ status: "amended" }).where(eq(prescriptions.id, rx.id)), "23000");
  });

  it("refuses it while the amendment is still a draft (23000)", async () => {
    const { parent } = await versionOneWithAmendmentDraft();
    await expectCode(adminDb.update(prescriptions).set({ status: "amended" }).where(eq(prescriptions.id, parent.id)), "23000");
    await expectCode(withTenant(T, (tx) => tx.update(prescriptions).set({ status: "amended" }).where(eq(prescriptions.id, parent.id))), "23000");
  });

  it("allows it once the amendment is finalized, in the same order finalizePrescription uses", async () => {
    const { parent, child, childVisit } = await versionOneWithAmendmentDraft();
    await finalize(child.id, childVisit.id);
    await adminDb.update(prescriptions).set({ status: "amended" }).where(eq(prescriptions.id, parent.id));
    const [row] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, parent.id));
    expect(row.status).toBe("amended");
  });

  it("does not count another prescription's finalized amendment", async () => {
    const other = await versionOneWithAmendmentDraft();
    await finalize(other.child.id, other.childVisit.id);
    nextRxNo += 1;
    const lonely = await draftRecords(nextRxNo);
    await finalize(lonely.rx.id, lonely.visit.id);
    await expectCode(adminDb.update(prescriptions).set({ status: "amended" }).where(eq(prescriptions.id, lonely.rx.id)), "23000");
  });
});

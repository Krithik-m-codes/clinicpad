import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import {
  patients,
  prescriptions,
  prescriptionItems,
  tenants,
  visits,
} from "@/server/db/schema";

let tenantId = "";

afterAll(async () => {
  if (tenantId) await adminDb.delete(tenants).where(eq(tenants.id, tenantId));
});

describe("clinical schema", () => {
  it("links patient → visit → prescription → items", async () => {
    const suffix = Date.now();
    const [tenant] = await adminDb
      .insert(tenants)
      .values({ name: "Clinical Test", slug: `clinical-${suffix}` })
      .returning();
    tenantId = tenant.id;

    const [patient] = await adminDb
      .insert(patients)
      .values({ tenantId, name: "Asha Rao", phone: `9${suffix}` })
      .returning();

    const [visit] = await adminDb
      .insert(visits)
      .values({ tenantId, patientId: patient.id, status: "draft" })
      .returning();

    const [rx] = await adminDb
      .insert(prescriptions)
      .values({ tenantId, visitId: visit.id, rxNo: 1, version: 1, status: "draft" })
      .returning();

    await adminDb.insert(prescriptionItems).values({
      tenantId,
      prescriptionId: rx.id,
      sortOrder: 0,
      drugName: "Paracetamol",
      dose: "500 mg",
    });

    const items = await adminDb
      .select()
      .from(prescriptionItems)
      .where(eq(prescriptionItems.prescriptionId, rx.id));

    expect(items).toHaveLength(1);
    expect(items[0].drugName).toBe("Paracetamol");
  });

  it("rejects duplicate rx number and version in a tenant", async () => {
    const suffix = Date.now();
    const [tenant] = await adminDb
      .insert(tenants)
      .values({ name: "Rx Unique", slug: `rx-${suffix}` })
      .returning();

    const [patient] = await adminDb
      .insert(patients)
      .values({ tenantId: tenant.id, name: "Test Patient" })
      .returning();
    const [visit] = await adminDb
      .insert(visits)
      .values({ tenantId: tenant.id, patientId: patient.id, status: "draft" })
      .returning();

    await adminDb.insert(prescriptions).values({
      tenantId: tenant.id,
      visitId: visit.id,
      rxNo: 41,
      version: 1,
      status: "draft",
    });

    await expect(
      adminDb.insert(prescriptions).values({
        tenantId: tenant.id,
        visitId: visit.id,
        rxNo: 41,
        version: 1,
        status: "draft",
      }),
    ).rejects.toThrow();

    await adminDb.delete(tenants).where(eq(tenants.id, tenant.id));
  });
});

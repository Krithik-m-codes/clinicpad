import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { clinics, memberships, tenants, users } from "@/server/db/schema";

const created: string[] = [];

afterAll(async () => {
  for (const id of created) {
    await adminDb.delete(tenants).where(eq(tenants.id, id));
  }
});

describe("tenancy schema", () => {
  it("persists non-India defaults per tenant", async () => {
    const [tenant] = await adminDb
      .insert(tenants)
      .values({
        name: "Berlin Clinic",
        slug: `berlin-${Date.now()}`,
        region: "eu-central-1",
        plan: "solo",
      })
      .returning();
    created.push(tenant.id);

    const [clinic] = await adminDb
      .insert(clinics)
      .values({
        tenantId: tenant.id,
        name: "Berlin Clinic",
        timezone: "Europe/Berlin",
        currency: "EUR",
        country: "DE",
      })
      .returning();

    expect(clinic.timezone).toBe("Europe/Berlin");
    expect(clinic.currency).toBe("EUR");
  });

  it("rejects a duplicate membership for the same tenant and user", async () => {
    const suffix = Date.now();
    const [tenant] = await adminDb
      .insert(tenants)
      .values({ name: "Dup Clinic", slug: `dup-${suffix}` })
      .returning();
    created.push(tenant.id);

    const [user] = await adminDb
      .insert(users)
      .values({ email: `dup-${suffix}@example.com`, name: "Dup User" })
      .returning();

    await adminDb.insert(memberships).values({
      tenantId: tenant.id,
      userId: user.id,
      role: "owner",
      status: "active",
    });

    await expect(
      adminDb.insert(memberships).values({
        tenantId: tenant.id,
        userId: user.id,
        role: "doctor",
        status: "active",
      }),
    ).rejects.toThrow();
  });
});

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { patients, tenants } from "@/server/db/schema";

let tenantA = "";
let tenantB = "";

afterAll(async () => {
  if (tenantA) await adminDb.delete(tenants).where(eq(tenants.id, tenantA));
  if (tenantB) await adminDb.delete(tenants).where(eq(tenants.id, tenantB));
});

describe("row level security", () => {
  it("isolates reads and writes by tenant", async () => {
    const suffix = Date.now();
    const [a] = await adminDb
      .insert(tenants)
      .values({ name: "A", slug: `rls-a-${suffix}` })
      .returning();
    const [b] = await adminDb
      .insert(tenants)
      .values({ name: "B", slug: `rls-b-${suffix}` })
      .returning();
    tenantA = a.id;
    tenantB = b.id;

    await withTenant(a.id, (tx) =>
      tx.insert(patients).values({ tenantId: a.id, name: "Patient A" }),
    );

    const bRows = await withTenant(b.id, (tx) => tx.select().from(patients));
    expect(bRows).toHaveLength(0);

    await expect(
      withTenant(b.id, (tx) => tx.insert(patients).values({ tenantId: a.id, name: "Leak" })),
    ).rejects.toThrow();

    const aRows = await withTenant(a.id, (tx) => tx.select().from(patients));
    expect(aRows.map((r) => r.name)).toEqual(["Patient A"]);
  });

  it("fails closed when no tenant is set", async () => {
    const { db } = await import("@/server/db/client");
    const rows = await db.select().from(patients);
    expect(rows).toHaveLength(0);
  });
});

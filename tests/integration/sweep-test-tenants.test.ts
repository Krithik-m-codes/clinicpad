import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { memberships, tenants, users } from "@/server/db/schema";
import { sweepTestTenants } from "@/server/db/sweep-test-tenants";

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const ids: string[] = [];
let realUser = "";

beforeAll(async () => {
  const old = new Date(Date.now() - 3 * 3_600_000);
  const [stale] = await adminDb.insert(tenants).values({ name: "Stale", slug: `sweep-stale-${stamp}`, createdAt: old }).returning();
  const [fresh] = await adminDb.insert(tenants).values({ name: "Fresh", slug: `sweep-fresh-${stamp}` }).returning();
  const [real] = await adminDb.insert(tenants).values({ name: "Real", slug: `sweep-real-${stamp}`, createdAt: old }).returning();
  ids.push(stale.id, fresh.id, real.id);
  const [user] = await adminDb.insert(users).values({ email: `owner-${stamp}@clinic.test`, name: "Real Owner" }).returning();
  realUser = user.id;
  await adminDb.insert(memberships).values({ tenantId: real.id, userId: user.id, role: "owner" });
});

afterAll(async () => {
  for (const id of ids) await adminDb.delete(tenants).where(eq(tenants.id, id));
  await adminDb.delete(users).where(eq(users.id, realUser));
});

describe("sweepTestTenants (dry run)", () => {
  it("lists an old memberless tenant, never a fresh one or one with a real member, and deletes nothing", async () => {
    const report = await sweepTestTenants({ apply: false, olderThanMinutes: 60 });
    const slugs = report.tenants.map((t) => t.slug);
    expect(slugs).toContain(`sweep-stale-${stamp}`);
    expect(slugs).not.toContain(`sweep-fresh-${stamp}`);
    expect(slugs).not.toContain(`sweep-real-${stamp}`);
    expect(slugs).not.toContain("demo-clinic");
    expect(report.applied).toBe(false);
    expect(await adminDb.select().from(tenants).where(eq(tenants.id, ids[0]))).toHaveLength(1);
  });
});

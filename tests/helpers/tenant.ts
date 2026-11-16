import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { doctors, tenants, users } from "@/server/db/schema";
import { newId } from "@/lib/domain/ids";
import type { ServiceContext } from "@/server/services/context";

export type TestTenant = {
  tenantId: string;
  /** A context for `role`. owner and doctor share one real user that has a doctor profile. */
  as: (role: string) => ServiceContext;
  cleanup: () => Promise<void>;
};

export async function createTestTenant(label: string): Promise<TestTenant> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [tenant] = await adminDb
    .insert(tenants)
    .values({ name: `Test ${label}`, slug: `t-${label}-${stamp}` })
    .returning();
  const [user] = await adminDb
    .insert(users)
    .values({ email: `${label}-${stamp}@example.com`, name: "Dr Test", passwordHash: "not-a-real-hash" })
    .returning();
  await adminDb.insert(doctors).values({ tenantId: tenant.id, userId: user.id });

  return {
    tenantId: tenant.id,
    as: (role) => ({
      tenantId: tenant.id,
      userId: role === "owner" || role === "doctor" ? user.id : newId(),
      role,
    }),
    cleanup: async () => {
      await adminDb.delete(tenants).where(eq(tenants.id, tenant.id));
      await adminDb.delete(users).where(eq(users.id, user.id));
    },
  };
}

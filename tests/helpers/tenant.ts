import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { clinics, doctors, memberships, tenants, users } from "@/server/db/schema";
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

  let userId: string | null = null;
  try {
    const [user] = await adminDb
      .insert(users)
      .values({ email: `${label}-${stamp}@example.com`, name: "Dr Test", passwordHash: "not-a-real-hash" })
      .returning();
    userId = user.id;
    await adminDb.insert(doctors).values({ tenantId: tenant.id, userId: user.id });
    // Real users act inside a clinic they belong to; keys such as tenant_medicines_created_by_fk rely on it.
    await adminDb.insert(memberships).values({ tenantId: tenant.id, userId: user.id, role: "owner" });
    // Every real tenant has a clinic profile (sign-up creates it); finalize refuses to freeze a pad without one.
    await adminDb.insert(clinics).values({ tenantId: tenant.id, name: `Test clinic ${label}` });
  } catch (error) {
    // Do not leak a half-built tenant: remove what was created, then report the original failure.
    await adminDb.delete(tenants).where(eq(tenants.id, tenant.id)).catch(() => undefined);
    if (userId) await adminDb.delete(users).where(eq(users.id, userId)).catch(() => undefined);
    throw error;
  }
  const doctorUserId = userId;

  return {
    tenantId: tenant.id,
    as: (role) => ({
      tenantId: tenant.id,
      userId: role === "owner" || role === "doctor" ? doctorUserId : newId(),
      role,
    }),
    cleanup: async () => {
      // Independent steps: a failed tenant delete must not leave the user behind.
      try {
        await adminDb.delete(tenants).where(eq(tenants.id, tenant.id));
      } finally {
        await adminDb.delete(users).where(eq(users.id, doctorUserId));
      }
    },
  };
}

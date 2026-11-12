import { describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import {
  doctors,
  memberships,
  patients,
  prescriptions,
  tenants,
  users,
} from "@/server/db/schema";
import { authenticateWithCredentials } from "@/server/auth/credentials";
import { seedDemo } from "@/server/db/seed";

describe("seedDemo", () => {
  it(
    "is idempotent: re-running replaces rather than duplicates",
    async () => {
      await seedDemo();
      await seedDemo();

      const demoTenants = await adminDb.select().from(tenants).where(eq(tenants.slug, "demo-clinic"));
      expect(demoTenants).toHaveLength(1);
      const tenantId = demoTenants[0].id;

      const patientRows = await adminDb.select().from(patients).where(eq(patients.tenantId, tenantId));
      expect(patientRows).toHaveLength(50);

      const rxRows = await adminDb
        .select()
        .from(prescriptions)
        .where(eq(prescriptions.tenantId, tenantId));
      expect(rxRows).toHaveLength(20);

      const memberRows = await adminDb
        .select()
        .from(memberships)
        .where(eq(memberships.tenantId, tenantId));
      expect(memberRows.map((m) => m.role).sort()).toEqual(["doctor", "owner", "reception"]);

      // Only clinicians get a doctor profile.
      const doctorRows = await adminDb.select().from(doctors).where(eq(doctors.tenantId, tenantId));
      expect(doctorRows).toHaveLength(2);

      const staff = await adminDb
        .select()
        .from(users)
        .where(
          inArray(users.email, [
            "owner@demo.clinicpad.app",
            "doctor@demo.clinicpad.app",
            "reception@demo.clinicpad.app",
          ]),
        );
      expect(staff).toHaveLength(3);
    },
    120_000,
  );

  it("creates a demo owner that can log in", async () => {
    await seedDemo();
    const user = await authenticateWithCredentials({
      email: "owner@demo.clinicpad.app",
      password: "ClinicPad!2026",
    });
    expect(user).toMatchObject({ role: "owner" });
  }, 120_000);

  it("refuses to run against production", async () => {
    const original = process.env.NODE_ENV;
    // NODE_ENV is typed read-only in Next's ambient types.
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    try {
      await expect(seedDemo()).rejects.toThrow("production");
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = original;
    }
  });
});

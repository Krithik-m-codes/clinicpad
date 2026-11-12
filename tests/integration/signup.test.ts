import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import {
  auditEvents,
  branches,
  clinics,
  doctors,
  memberships,
  tenants,
  users,
} from "@/server/db/schema";
import { createClinicAccount } from "@/server/auth/create-clinic";

const createdTenants: string[] = [];
const createdUsers: string[] = [];

afterAll(async () => {
  if (createdTenants.length) await adminDb.delete(tenants).where(inArray(tenants.id, createdTenants));
  if (createdUsers.length) await adminDb.delete(users).where(inArray(users.id, createdUsers));
});

let counter = 0;
function input(label: string) {
  // Unique per call: timestamp plus a counter so same-millisecond calls never collide.
  const suffix = `${Date.now()}${counter++}`;
  return {
    clinicName: `Sunrise Clinic ${label}`,
    doctorName: "Dr. Meera Shah",
    email: `meera-${suffix}@example.com`,
    // 10 digits built from the *tail* of the timestamp so calls in the same second differ.
    phone: `9${Date.now().toString().slice(-8)}${counter % 10}`,
    password: "ClinicPad!2026",
    city: "Pune",
    country: "IN",
    timezone: "Asia/Kolkata",
    currency: "INR" as const,
  };
}

describe("createClinicAccount", () => {
  it("creates tenant, clinic, branch, membership, doctor, and audit event atomically", async () => {
    const result = await createClinicAccount(input("a"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    createdTenants.push(result.tenantId);
    createdUsers.push(result.userId);

    const [membership] = await adminDb
      .select()
      .from(memberships)
      .where(eq(memberships.userId, result.userId));
    expect(membership.role).toBe("owner");
    expect(membership.tenantId).toBe(result.tenantId);

    const [clinic] = await adminDb.select().from(clinics).where(eq(clinics.tenantId, result.tenantId));
    expect(clinic.name).toContain("Sunrise Clinic");
    expect(clinic.timezone).toBe("Asia/Kolkata");

    const [branch] = await adminDb.select().from(branches).where(eq(branches.tenantId, result.tenantId));
    expect(branch).toMatchObject({ name: "Main Branch", isPrimary: true });

    const doctorRows = await adminDb.select().from(doctors).where(eq(doctors.tenantId, result.tenantId));
    expect(doctorRows).toHaveLength(1);
    expect(doctorRows[0].userId).toBe(result.userId);

    const audit = await adminDb
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.tenantId, result.tenantId));
    expect(audit.map((e) => e.action)).toContain("tenant.created");
  });

  it("returns a field error for a duplicate email and creates nothing", async () => {
    const data = input("b");
    const first = await createClinicAccount(data);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    createdTenants.push(first.tenantId);
    createdUsers.push(first.userId);

    const duplicate = await createClinicAccount({ ...input("b2"), email: data.email });
    expect(duplicate).toEqual({ ok: false, field: "email", error: expect.any(String) });

    const rows = await adminDb.select().from(users).where(eq(users.email, data.email));
    expect(rows).toHaveLength(1);
  });

  it("returns a field error for a duplicate phone", async () => {
    const data = input("c");
    const first = await createClinicAccount(data);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    createdTenants.push(first.tenantId);
    createdUsers.push(first.userId);

    const duplicate = await createClinicAccount({ ...input("c2"), phone: data.phone });
    expect(duplicate).toEqual({ ok: false, field: "phone", error: expect.any(String) });
  });

  it("stores the email lowercased", async () => {
    const data = input("d");
    const result = await createClinicAccount({ ...data, email: data.email.toUpperCase() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdTenants.push(result.tenantId);
    createdUsers.push(result.userId);

    const [user] = await adminDb.select().from(users).where(eq(users.id, result.userId));
    expect(user.email).toBe(data.email.toLowerCase());
  });

  it("rejects a short password before touching the database", async () => {
    const data = { ...input("e"), password: "short" };
    const result = await createClinicAccount(data);
    expect(result).toMatchObject({ ok: false, field: "password" });
    const rows = await adminDb.select().from(users).where(eq(users.email, data.email));
    expect(rows).toHaveLength(0);
  });
});

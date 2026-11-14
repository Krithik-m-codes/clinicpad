import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { authenticateWithCredentials } from "@/server/auth/credentials";
import { adminDb } from "@/server/db/admin";
import { memberships, tenants, users } from "@/server/db/schema";

const emails: string[] = [];
let tenantId = "";

afterAll(async () => {
  for (const email of emails) {
    await adminDb.delete(users).where(eq(users.email, email));
  }
  if (tenantId) await adminDb.delete(tenants).where(eq(tenants.id, tenantId));
});

async function seedMember(email: string, withMembership = true) {
  const [user] = await adminDb
    .insert(users)
    .values({
      email,
      name: "Dr Asha Rao",
      passwordHash: await hashPassword("ClinicPad!2026"),
    })
    .returning();
  emails.push(email);

  if (withMembership) {
    if (!tenantId) {
      const [tenant] = await adminDb
        .insert(tenants)
        .values({ name: "Auth Clinic", slug: `auth-${Date.now()}` })
        .returning();
      tenantId = tenant.id;
    }
    await adminDb.insert(memberships).values({
      tenantId,
      userId: user.id,
      role: "owner",
      status: "active",
    });
  }

  return user;
}

describe("password hashing", () => {
  it("verifies the correct password and rejects the wrong one", async () => {
    const hash = await hashPassword("ClinicPad!2026");
    expect(hash).not.toContain("ClinicPad!2026");
    expect(await verifyPassword("ClinicPad!2026", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("rejects short passwords", async () => {
    await expect(hashPassword("short")).rejects.toThrow("at least 8");
  });
});

describe("credentials login", () => {
  it("returns the tenant and role for a valid password", async () => {
    const email = `login-${Date.now()}@example.com`;
    const user = await seedMember(email);

    const result = await authenticateWithCredentials({
      email: email.toUpperCase(),
      password: "ClinicPad!2026",
    });

    expect(result).toMatchObject({
      id: user.id,
      email,
      tenantId,
      role: "owner",
    });
  });

  it("returns null for a wrong password", async () => {
    const email = `wrong-${Date.now()}@example.com`;
    await seedMember(email);

    await expect(
      authenticateWithCredentials({ email, password: "not-the-password" }),
    ).resolves.toBeNull();
  });

  it("returns null when the user has no active membership", async () => {
    const email = `nomember-${Date.now()}@example.com`;
    await seedMember(email, false);

    await expect(
      authenticateWithCredentials({ email, password: "ClinicPad!2026" }),
    ).resolves.toBeNull();
  });
});

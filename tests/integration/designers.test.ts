// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, gt } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { auditEvents, memberships, users } from "@/server/db/schema";
import { authenticateWithCredentials, getActiveMembership } from "@/server/auth/credentials";
import { extendDesigner, inviteDesigner, listDesigners, revokeDesigner } from "@/server/auth/designers";
import { newId } from "@/lib/domain/ids";
import { can } from "@/lib/domain/permissions";
import { searchPatients } from "@/server/services/patients";
import { listTemplates } from "@/server/services/template-views";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const DAY = 86_400_000;
let A: TestTenant;
let B: TestTenant;
const emails: string[] = [];
const email = (label: string) => {
  const value = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  emails.push(value);
  return value;
};

// Audit rows are append-only and ids are time-ordered uuidv7s: each test sees only the events written after it started.
let since = "";
beforeEach(() => {
  since = newId();
});
beforeAll(async () => {
  A = await createTestTenant("des-a");
  B = await createTestTenant("des-b");
});
afterEach(async () => {
  await adminDb.delete(memberships).where(and(eq(memberships.tenantId, A.tenantId), eq(memberships.role, "designer")));
  await adminDb.delete(memberships).where(and(eq(memberships.tenantId, B.tenantId), eq(memberships.role, "designer")));
});
afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
  for (const e of emails) await adminDb.delete(users).where(eq(users.email, e));
});

async function invite(ctx = A.as("owner"), days: unknown = 7, address = email("setup")) {
  const result = await inviteDesigner(ctx, { email: address, name: "ClinicPad setup", days });
  return { result, address };
}
const auditFor = (tenantId: string, action: string) =>
  adminDb.select().from(auditEvents).where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, action), gt(auditEvents.id, since)));

describe("inviteDesigner", () => {
  it("creates a user and an expiring designer membership, returns the password once, and audits without secrets", async () => {
    const before = Date.now();
    const { result, address } = await invite(A.as("owner"), 7);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.password.length).toBeGreaterThanOrEqual(20);
    expect(result.value.email).toBe(address);
    expect(Math.abs(result.value.expiresAt.getTime() - (before + 7 * DAY))).toBeLessThan(60_000);

    const [user] = await adminDb.select().from(users).where(eq(users.email, address));
    expect(user.passwordHash).toBeTruthy();
    expect(user.passwordHash).not.toContain(result.value.password);
    const [member] = await adminDb.select().from(memberships).where(eq(memberships.userId, user.id));
    expect(member).toMatchObject({ tenantId: A.tenantId, role: "designer", status: "active" });
    expect(member.expiresAt?.getTime()).toBe(result.value.expiresAt.getTime());

    const events = await auditFor(A.tenantId, "designer.invited");
    expect(events).toHaveLength(1);
    expect(events[0].entityType).toBe("membership");
    expect(events[0].entityId).toBe(member.id);
    const payload = JSON.stringify(events[0]);
    expect(payload).not.toContain(result.value.password);
    expect(payload).not.toContain(address);
    expect(payload).not.toContain(user.passwordHash!);
  });

  it("lets the designer sign in with the temporary password, into this clinic as a designer", async () => {
    const { result, address } = await invite();
    if (!result.ok) throw new Error("invite failed");
    const signedIn = await authenticateWithCredentials({ email: address, password: result.value.password });
    expect(signedIn).toMatchObject({ tenantId: A.tenantId, role: "designer" });
    expect(await authenticateWithCredentials({ email: address, password: "wrong-password-1" })).toBeNull();
  });

  it("defaults to seven days and refuses 0, 31 and junk", async () => {
    const ok = await inviteDesigner(A.as("owner"), { email: email("d"), name: "Setup" });
    expect(ok.ok && Math.round((ok.value.expiresAt.getTime() - Date.now()) / DAY)).toBe(7);
    for (const days of [0, 31, -3, 1.5, "abc", NaN]) {
      const refused = await inviteDesigner(A.as("owner"), { email: email("bad"), name: "Setup", days });
      expect(refused, String(days)).toMatchObject({ ok: false, code: "invalid", field: "days" });
    }
    const thirty = await inviteDesigner(A.as("owner"), { email: email("t"), name: "Setup", days: 30 });
    expect(thirty.ok).toBe(true);
  });

  it("refuses every role but the owner and creates nothing", async () => {
    for (const role of ["doctor", "reception", "nurse", "accountant", "pharmacist", "designer", "mystery"]) {
      const address = email(`role-${role}`);
      const result = await inviteDesigner(A.as(role), { email: address, name: "Setup", days: 7 });
      expect(result, role).toMatchObject({ ok: false, code: "forbidden" });
      expect(await adminDb.select().from(users).where(eq(users.email, address)), role).toHaveLength(0);
    }
    expect(can("designer", "designer.manage")).toBe(false);
  });

  it("validates the email and the name", async () => {
    expect(await inviteDesigner(A.as("owner"), { email: "nope", name: "Setup", days: 7 })).toMatchObject({ ok: false, field: "email" });
    expect(await inviteDesigner(A.as("owner"), { email: email("n"), name: "", days: 7 })).toMatchObject({ ok: false, field: "name" });
    expect(await inviteDesigner(A.as("owner"), { email: email("n"), name: "A\u0000B", days: 7 })).toMatchObject({ ok: false, field: "name" });
  });

  it("refuses an email that already has an account (owner, other clinic) and changes nothing about that account", async () => {
    const [ownerA] = await adminDb.select().from(users).where(eq(users.id, A.as("owner").userId));
    const [ownerB] = await adminDb.select().from(users).where(eq(users.id, B.as("owner").userId));
    for (const target of [ownerA, ownerB]) {
      const result = await inviteDesigner(A.as("owner"), { email: target.email, name: "Setup", days: 7 });
      expect(result).toMatchObject({ ok: false, code: "conflict", field: "email" });
      const [after] = await adminDb.select().from(users).where(eq(users.id, target.id));
      expect(after.passwordHash).toBe(target.passwordHash);
    }
    expect(await getActiveMembership(ownerB.id)).toEqual({ tenantId: B.tenantId, role: "owner" });
  });

  it("refuses a designer of another clinic (an account never moves between clinics)", async () => {
    const { result, address } = await invite(B.as("owner"));
    expect(result.ok).toBe(true);
    const again = await inviteDesigner(A.as("owner"), { email: address, name: "Setup", days: 7 });
    expect(again).toMatchObject({ ok: false, code: "conflict" });
    expect(await auditFor(A.tenantId, "designer.invited")).toHaveLength(0);
  });

  it("re-invites a former designer of the same clinic: new password, reactivated, new expiry, old password dead", async () => {
    const first = await invite();
    if (!first.result.ok) throw new Error("invite failed");
    expect((await revokeDesigner(A.as("owner"), first.result.value.membershipId)).ok).toBe(true);
    expect(await authenticateWithCredentials({ email: first.address, password: first.result.value.password })).toBeNull();

    const second = await inviteDesigner(A.as("owner"), { email: first.address, name: "ClinicPad setup", days: 3 });
    if (!second.ok) throw new Error("re-invite failed");
    expect(second.value.membershipId).toBe(first.result.value.membershipId);
    expect(second.value.reinvited).toBe(true);
    expect(second.value.password).not.toBe(first.result.value.password);
    expect(await authenticateWithCredentials({ email: first.address, password: first.result.value.password })).toBeNull();
    expect(await authenticateWithCredentials({ email: first.address, password: second.value.password })).toMatchObject({ role: "designer", tenantId: A.tenantId });
    expect(await auditFor(A.tenantId, "designer.invited")).toHaveLength(2);
  });

  it("re-inviting an active designer rotates the password and does not stack members", async () => {
    const first = await invite();
    if (!first.result.ok) throw new Error("invite failed");
    const second = await inviteDesigner(A.as("owner"), { email: first.address, name: "ClinicPad setup", days: 7 });
    expect(second.ok).toBe(true);
    const rows = await adminDb.select().from(memberships).where(and(eq(memberships.tenantId, A.tenantId), eq(memberships.role, "designer")));
    expect(rows).toHaveLength(1);
  });

  it("allows at most five unexpired designers per clinic", async () => {
    for (let i = 0; i < 5; i++) expect((await invite()).result.ok).toBe(true);
    const sixth = await invite();
    expect(sixth.result).toMatchObject({ ok: false, code: "conflict" });
    // The other clinic is unaffected.
    expect((await invite(B.as("owner"))).result.ok).toBe(true);
  });

  it("survives two simultaneous invites of the same new email without a duplicate account", async () => {
    const address = email("race");
    const results = await Promise.all([
      inviteDesigner(A.as("owner"), { email: address, name: "Setup", days: 7 }),
      inviteDesigner(A.as("owner"), { email: address, name: "Setup", days: 7 }),
    ]);
    expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
    expect(await adminDb.select().from(users).where(eq(users.email, address))).toHaveLength(1);
    const rows = await adminDb.select().from(memberships).where(and(eq(memberships.tenantId, A.tenantId), eq(memberships.role, "designer")));
    expect(rows).toHaveLength(1);
  });
});

describe("extendDesigner and revokeDesigner", () => {
  it("extends to now plus the chosen days, audits, and refuses a shorter or equal date", async () => {
    const { result } = await invite(A.as("owner"), 2);
    if (!result.ok) throw new Error("invite failed");
    const extended = await extendDesigner(A.as("owner"), result.value.membershipId, 10);
    expect(extended.ok && Math.round((extended.value.expiresAt.getTime() - Date.now()) / DAY)).toBe(10);
    expect(await extendDesigner(A.as("owner"), result.value.membershipId, 5)).toMatchObject({ ok: false, code: "invalid", field: "days" });
    expect(await extendDesigner(A.as("owner"), result.value.membershipId, 31)).toMatchObject({ ok: false, field: "days" });
    expect(await auditFor(A.tenantId, "designer.extended")).toHaveLength(1);
  });

  it("extends an expired designer back to life, but never a revoked one", async () => {
    const { result, address } = await invite();
    if (!result.ok) throw new Error("invite failed");
    await adminDb
      .update(memberships)
      .set({ createdAt: new Date(Date.now() - 3 * DAY), expiresAt: new Date(Date.now() - DAY) })
      .where(eq(memberships.id, result.value.membershipId));
    expect(await authenticateWithCredentials({ email: address, password: result.value.password })).toBeNull();
    expect((await extendDesigner(A.as("owner"), result.value.membershipId, 3)).ok).toBe(true);
    expect(await authenticateWithCredentials({ email: address, password: result.value.password })).not.toBeNull();

    await revokeDesigner(A.as("owner"), result.value.membershipId);
    expect(await extendDesigner(A.as("owner"), result.value.membershipId, 3)).toMatchObject({ ok: false, code: "conflict" });
  });

  it("revokes at once, audits, and refuses a second revoke", async () => {
    const { result, address } = await invite();
    if (!result.ok) throw new Error("invite failed");
    const [user] = await adminDb.select().from(users).where(eq(users.email, address));
    expect(await getActiveMembership(user.id)).not.toBeNull();
    expect((await revokeDesigner(A.as("owner"), result.value.membershipId)).ok).toBe(true);
    expect(await getActiveMembership(user.id)).toBeNull();
    expect(await authenticateWithCredentials({ email: address, password: result.value.password })).toBeNull();
    expect(await revokeDesigner(A.as("owner"), result.value.membershipId)).toMatchObject({ ok: false, code: "conflict" });
    expect(await auditFor(A.tenantId, "designer.revoked")).toHaveLength(1);
  });

  it("only the owner may extend or revoke", async () => {
    const { result } = await invite();
    if (!result.ok) throw new Error("invite failed");
    for (const role of ["doctor", "reception", "nurse", "accountant", "pharmacist", "designer"]) {
      expect(await extendDesigner(A.as(role), result.value.membershipId, 9), role).toMatchObject({ ok: false, code: "forbidden" });
      expect(await revokeDesigner(A.as(role), result.value.membershipId), role).toMatchObject({ ok: false, code: "forbidden" });
    }
    const [member] = await adminDb.select().from(memberships).where(eq(memberships.id, result.value.membershipId));
    expect(member.status).toBe("active");
  });

  it("never touches a non-designer membership, even with its id (the owner cannot revoke themselves or staff)", async () => {
    const [ownerMember] = await adminDb.select().from(memberships).where(and(eq(memberships.tenantId, A.tenantId), eq(memberships.role, "owner")));
    expect(await revokeDesigner(A.as("owner"), ownerMember.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await extendDesigner(A.as("owner"), ownerMember.id, 5)).toMatchObject({ ok: false, code: "not_found" });
    const [after] = await adminDb.select().from(memberships).where(eq(memberships.id, ownerMember.id));
    expect(after).toMatchObject({ status: "active", expiresAt: null });
  });

  it("answers not_found for junk ids", async () => {
    expect(await revokeDesigner(A.as("owner"), "not-a-uuid")).toMatchObject({ ok: false, code: "not_found" });
    expect(await extendDesigner(A.as("owner"), "", 3)).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("cross-tenant", () => {
  it("clinic A's owner cannot extend, revoke or list clinic B's designer", async () => {
    const inB = await invite(B.as("owner"));
    if (!inB.result.ok) throw new Error("invite failed");
    expect(await extendDesigner(A.as("owner"), inB.result.value.membershipId, 20)).toMatchObject({ ok: false, code: "not_found" });
    expect(await revokeDesigner(A.as("owner"), inB.result.value.membershipId)).toMatchObject({ ok: false, code: "not_found" });
    const listA = await listDesigners(A.as("owner"));
    expect(listA.ok && listA.value).toHaveLength(0);
    const [member] = await adminDb.select().from(memberships).where(eq(memberships.id, inB.result.value.membershipId));
    expect(member.status).toBe("active");
    expect(await auditFor(A.tenantId, "designer.revoked")).toHaveLength(0);
    const listB = await listDesigners(B.as("owner"));
    expect(listB.ok && listB.value.map((d) => d.email)).toEqual([inB.address]);
  });

  it("writes the audit event into the owner's own clinic only", async () => {
    await invite(A.as("owner"));
    expect(await auditFor(A.tenantId, "designer.invited")).toHaveLength(1);
    expect(await auditFor(B.tenantId, "designer.invited")).toHaveLength(0);
  });
});

describe("listDesigners", () => {
  it("shows each designer with status and expiry to the owner only, and never a secret", async () => {
    const one = await invite(A.as("owner"), 7);
    const two = await invite(A.as("owner"), 2);
    if (!one.result.ok || !two.result.ok) throw new Error("invite failed");
    await revokeDesigner(A.as("owner"), two.result.value.membershipId);
    const list = await listDesigners(A.as("owner"));
    if (!list.ok) throw new Error("list failed");
    expect(list.value).toHaveLength(2);
    const byEmail = Object.fromEntries(list.value.map((d) => [d.email, d]));
    expect(byEmail[one.address].status).toBe("active");
    expect(byEmail[two.address].status).toBe("revoked");
    expect(byEmail[one.address].expiresAt.getTime()).toBe(one.result.value.expiresAt.getTime());
    expect(JSON.stringify(list.value)).not.toMatch(/passwordHash|password_hash|\$2[aby]\$/);
    expect(JSON.stringify(list.value)).not.toContain(one.result.value.password);
    for (const role of ["doctor", "designer", "reception", "nurse"]) expect(await listDesigners(A.as(role)), role).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("a designer stays templates-only", () => {
  it("is refused by the patient service and allowed the template list", async () => {
    const { result } = await invite();
    if (!result.ok) throw new Error("invite failed");
    const [member] = await adminDb.select().from(memberships).where(eq(memberships.id, result.value.membershipId));
    expect(member.role).toBe("designer");
    const ctx = { tenantId: A.tenantId, userId: member.userId, role: member.role };
    expect(await searchPatients(ctx, { q: "" })).toMatchObject({ ok: false, code: "forbidden" });
    expect((await listTemplates(ctx)).ok).toBe(true);
  });
});

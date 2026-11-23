// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("@/server/auth/session", () => ({ requireSession: vi.fn(), getSessionContext: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requireSession } from "@/server/auth/session";
import { adminDb } from "@/server/db/admin";
import { auditEvents, memberships, users } from "@/server/db/schema";
import { extendDesignerAction, inviteDesignerAction, revokeDesignerAction } from "@/server/actions/designers";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const session = vi.mocked(requireSession);
let A: TestTenant;
const emails: string[] = [];

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

beforeAll(async () => {
  A = await createTestTenant("desact");
});
afterAll(async () => {
  await A.cleanup();
  for (const e of emails) await adminDb.delete(users).where(eq(users.email, e));
});
beforeEach(() => {
  session.mockReset();
  session.mockResolvedValue(A.as("owner"));
});

describe("designer actions", () => {
  it("invites, returns the hand-over note once, extends and revokes", async () => {
    const address = `act-${Date.now()}@example.com`;
    emails.push(address);
    const invited = await inviteDesignerAction({}, form({ email: address, name: "ClinicPad setup", days: "5" }));
    expect(invited.error).toBeUndefined();
    expect(invited.note).toContain(address);
    expect(invited.note).toMatch(/Temporary password: [A-Za-z0-9-]{20,}/);
    expect(invited.note).toContain("Test clinic desact");

    const [user] = await adminDb.select().from(users).where(eq(users.email, address));
    const [member] = await adminDb.select().from(memberships).where(and(eq(memberships.userId, user.id), eq(memberships.tenantId, A.tenantId)));
    const extended = await extendDesignerAction({}, form({ membershipId: member.id, days: "20" }));
    expect(extended).toMatchObject({ saved: true });
    const revoked = await revokeDesignerAction({}, form({ membershipId: member.id }));
    expect(revoked).toMatchObject({ saved: true });
    const actions = (await adminDb.select().from(auditEvents).where(eq(auditEvents.entityId, member.id))).map((e) => e.action).sort();
    expect(actions).toEqual(["designer.extended", "designer.invited", "designer.revoked"]);
  });

  it("answers typed errors, with no note", async () => {
    const bad = await inviteDesignerAction({}, form({ email: "x@example.com", name: "Setup", days: "99" }));
    expect(bad).toMatchObject({ field: "days" });
    expect(bad.note).toBeUndefined();
  });

  it("refuses a non-owner session and creates nothing", async () => {
    const address = `act-doc-${Date.now()}@example.com`;
    emails.push(address);
    for (const role of ["doctor", "reception", "designer"]) {
      session.mockResolvedValue(A.as(role));
      const result = await inviteDesignerAction({}, form({ email: address, name: "Setup", days: "7" }));
      expect(result.error, role).toBeTruthy();
      expect(result.note, role).toBeUndefined();
    }
    expect(await adminDb.select().from(users).where(eq(users.email, address))).toHaveLength(0);
  });
});

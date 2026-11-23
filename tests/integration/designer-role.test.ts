import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { pgErrorInfo } from "@/server/db/errors";
import { memberships, users } from "@/server/db/schema";
import { getActiveMembership } from "@/server/auth/credentials";
import { loadRxDocument } from "@/server/services/rx-documents";
import { searchPatients, getPatient } from "@/server/services/patients";
import { searchMedicines } from "@/server/services/catalogue";
import { getClinicPad, updateClinicPad } from "@/server/services/pad-settings";
import { getSharePanel } from "@/server/services/sharing";
import { listShareLinks } from "@/server/services/share-links";
import { newId } from "@/lib/domain/ids";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const DAY = 86_400_000;

let A: TestTenant;
let designer = "";

beforeAll(async () => {
  A = await createTestTenant("designer");
  const [user] = await adminDb
    .insert(users)
    .values({ email: `designer-${Date.now()}@example.com`, name: "ClinicPad setup", passwordHash: "x" })
    .returning();
  designer = user.id;
});
afterAll(async () => {
  await A.cleanup();
  await adminDb.delete(users).where(eq(users.id, designer));
});

describe("designer memberships", () => {
  it("must expire (23514)", async () => {
    const error = await adminDb
      .insert(memberships)
      .values({ tenantId: A.tenantId, userId: designer, role: "designer" })
      .then(() => null, (e: unknown) => e);
    expect(pgErrorInfo(error)).toMatchObject({ code: "23514", constraint: "memberships_designer_expiry_check" });
  });

  it("cannot expire before they were created (23514)", async () => {
    const error = await adminDb
      .insert(memberships)
      .values({ tenantId: A.tenantId, userId: designer, role: "designer", expiresAt: new Date(Date.now() - DAY) })
      .then(() => null, (e: unknown) => e);
    expect(pgErrorInfo(error)).toMatchObject({ code: "23514", constraint: "memberships_expiry_check" });
  });

  it("count while unexpired and stop counting the moment they expire", async () => {
    // Created a day ago so the later expiry update (to one second ago) still satisfies memberships_expiry_check.
    await adminDb.insert(memberships).values({
      tenantId: A.tenantId,
      userId: designer,
      role: "designer",
      createdAt: new Date(Date.now() - DAY),
      expiresAt: new Date(Date.now() + 7 * DAY),
    });
    expect(await getActiveMembership(designer)).toEqual({ tenantId: A.tenantId, role: "designer" });
    await adminDb.update(memberships).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(memberships.userId, designer));
    expect(await getActiveMembership(designer)).toBeNull();
  });

  it("an unexpiring member (owner) is unaffected by the expiry filter", async () => {
    const [owner] = await adminDb.select().from(memberships).where(eq(memberships.tenantId, A.tenantId));
    expect(owner.expiresAt).toBeNull();
    expect(await getActiveMembership(owner.userId)).toEqual({ tenantId: A.tenantId, role: "owner" });
  });

  it("a disabled designer is not active even before expiry", async () => {
    await adminDb
      .update(memberships)
      .set({ status: "disabled", expiresAt: new Date(Date.now() + DAY) })
      .where(eq(memberships.userId, designer));
    expect(await getActiveMembership(designer)).toBeNull();
  });
});

describe("designer access is templates only", () => {
  const ctx = () => ({ tenantId: A.tenantId, userId: newId(), role: "designer" });

  it("is refused by every patient, prescription, catalogue, settings and sharing service", async () => {
    expect(await loadRxDocument(ctx(), newId())).toMatchObject({ ok: false, code: "forbidden" });
    expect(await searchPatients(ctx())).toMatchObject({ ok: false, code: "forbidden" });
    expect(await getPatient(ctx(), newId())).toMatchObject({ ok: false, code: "forbidden" });
    expect(await searchMedicines(ctx(), { q: "x" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await getClinicPad(ctx())).toMatchObject({ ok: false, code: "forbidden" });
    expect(await updateClinicPad(ctx(), {})).toMatchObject({ ok: false, code: "forbidden" });
    expect(await getSharePanel(ctx(), newId())).toMatchObject({ ok: false, code: "forbidden" });
    expect(await listShareLinks(ctx(), newId())).toMatchObject({ ok: false, code: "forbidden" });
  });
});

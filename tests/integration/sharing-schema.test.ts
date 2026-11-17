import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import { clinics, patientConsents, prescriptionOutputs, prescriptionShares, shareLinks } from "@/server/db/schema";
import { createPatient } from "@/server/services/patients";
import { startPrescription } from "@/server/services/prescriptions";
import { finalizeNow, saveDraftNow } from "../helpers/rx";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
let patientA = "";
let finalizedA = "";
let draftA = "";
let finalizedB = "";
let consentA = "";
let consentB = "";

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").not.toBeNull();
  expect(pgErrorInfo(error).code).toBe(code);
}

const hash = () => createHash("sha256").update(randomBytes(32)).digest("hex");
const DAY = 86_400_000;

function linkValues(tenantId: string, prescriptionId: string, consentId: string, overrides: Partial<typeof shareLinks.$inferInsert> = {}) {
  const now = new Date();
  return { tenantId, prescriptionId, consentId, tokenHash: hash(), channel: "whatsapp", createdAt: now, expiresAt: new Date(now.getTime() + 7 * DAY), maxOpens: 10, ...overrides };
}

async function prescription(T: TestTenant, patientId: string, finalize: boolean): Promise<string> {
  const started = await startPrescription(T.as("doctor"), { patientId });
  if (!started.ok) throw new Error(started.message);
  const saved = await saveDraftNow(T.as("doctor"), started.value.prescriptionId, { items: [{ drugName: "Schema Drug" }] });
  if (!saved.ok) throw new Error(saved.message);
  if (finalize) {
    const done = await finalizeNow(T.as("doctor"), started.value.prescriptionId);
    if (!done.ok) throw new Error(done.message);
  }
  return started.value.prescriptionId;
}

beforeAll(async () => {
  A = await createTestTenant("sharing-a");
  B = await createTestTenant("sharing-b");
  const pa = await createPatient(A.as("owner"), { name: "Share Schema A" });
  const pb = await createPatient(B.as("owner"), { name: "Share Schema B" });
  if (!pa.ok || !pb.ok) throw new Error("patients");
  patientA = pa.value.id;
  finalizedA = await prescription(A, patientA, true);
  draftA = await prescription(A, patientA, false);
  finalizedB = await prescription(B, pb.value.id, true);
  const [ca] = await adminDb
    .insert(patientConsents)
    .values({ tenantId: A.tenantId, patientId: patientA, purpose: "sharing", version: "sharing-v1", granted: true, method: "verbal" })
    .returning();
  const [cb] = await adminDb
    .insert(patientConsents)
    .values({ tenantId: B.tenantId, patientId: pb.value.id, purpose: "sharing", version: "sharing-v1", granted: true, method: "verbal" })
    .returning();
  consentA = ca.id;
  consentB = cb.id;
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

describe("clinics.sharing_enabled", () => {
  it("is off by default", async () => {
    const [clinic] = await adminDb.select().from(clinics).where(eq(clinics.tenantId, A.tenantId));
    expect(clinic.sharingEnabled).toBe(false);
  });
});

describe("patient_consents", () => {
  it("is tenant-isolated and append-only for the application role, and immutable for the admin connection", async () => {
    const [row] = await withTenant(A.tenantId, (tx) =>
      tx.insert(patientConsents).values({ tenantId: A.tenantId, patientId: patientA, purpose: "sharing", version: "sharing-v1", granted: false, method: "written" }).returning(),
    );
    expect(await withTenant(B.tenantId, (tx) => tx.select().from(patientConsents).where(eq(patientConsents.id, row.id)))).toHaveLength(0);
    await expectCode(withTenant(A.tenantId, (tx) => tx.update(patientConsents).set({ granted: true }).where(eq(patientConsents.id, row.id))), "42501");
    await expectCode(withTenant(A.tenantId, (tx) => tx.delete(patientConsents).where(eq(patientConsents.id, row.id))), "42501");
    await expectCode(adminDb.update(patientConsents).set({ granted: true }).where(eq(patientConsents.id, row.id)), "23000");
    await expectCode(adminDb.delete(patientConsents).where(eq(patientConsents.id, row.id)), "23000");
  });

  it.each([
    ["an unknown purpose", { purpose: "marketing" }],
    ["an unknown method", { method: "sms" }],
    ["a malformed version", { version: "v1" }],
  ])("refuses %s (23514)", async (_label, overrides) => {
    await expectCode(
      adminDb.insert(patientConsents).values({ tenantId: A.tenantId, patientId: patientA, purpose: "sharing", version: "sharing-v1", granted: true, method: "verbal", ...overrides }),
      "23514",
    );
  });

  it("belongs to a patient of the same clinic (23503)", async () => {
    const [foreign] = await adminDb.select({ patientId: patientConsents.patientId }).from(patientConsents).where(eq(patientConsents.id, consentB));
    await expectCode(
      adminDb.insert(patientConsents).values({ tenantId: A.tenantId, patientId: foreign.patientId, purpose: "sharing", version: "sharing-v1", granted: true, method: "verbal" }),
      "23503",
    );
  });
});

describe("share_links", () => {
  it("accepts a link to a finalized prescription and refuses a draft (23000) or another clinic's prescription (23503)", async () => {
    await withTenant(A.tenantId, (tx) => tx.insert(shareLinks).values(linkValues(A.tenantId, finalizedA, consentA)));
    await expectCode(withTenant(A.tenantId, (tx) => tx.insert(shareLinks).values(linkValues(A.tenantId, draftA, consentA))), "23000");
    await expectCode(adminDb.insert(shareLinks).values(linkValues(A.tenantId, finalizedB, consentA)), "23503");
    await expectCode(adminDb.insert(shareLinks).values(linkValues(A.tenantId, finalizedA, consentB)), "23503");
  });

  it("lets only the open counter move up by one and a single revocation happen; never a delete", async () => {
    const [link] = await adminDb.insert(shareLinks).values(linkValues(A.tenantId, finalizedA, consentA)).returning();
    const where = eq(shareLinks.id, link.id);
    await withTenant(A.tenantId, (tx) => tx.update(shareLinks).set({ openCount: 1, lastOpenedAt: new Date() }).where(where));
    await expectCode(withTenant(A.tenantId, (tx) => tx.update(shareLinks).set({ openCount: 3 }).where(where)), "23000");
    await expectCode(adminDb.update(shareLinks).set({ tokenHash: hash() }).where(where), "23000");
    await expectCode(adminDb.update(shareLinks).set({ expiresAt: new Date(Date.now() + 9 * DAY) }).where(where), "23000");
    await withTenant(A.tenantId, (tx) => tx.update(shareLinks).set({ revokedAt: new Date(), revokeReason: "user" }).where(where));
    await expectCode(adminDb.update(shareLinks).set({ openCount: 2 }).where(where), "23000");
    await expectCode(adminDb.update(shareLinks).set({ revokedAt: null, revokeReason: null }).where(where), "23000");
    await expectCode(withTenant(A.tenantId, (tx) => tx.delete(shareLinks).where(where)), "42501");
    await expectCode(adminDb.delete(shareLinks).where(where), "23000");
  });

  it.each([
    ["an unknown channel", { channel: "sms" }],
    ["no allowed opens", { maxOpens: 0 }],
    ["an expiry before creation", { expiresAt: new Date(Date.now() - DAY) }],
    ["an expiry over 31 days away", { expiresAt: new Date(Date.now() + 40 * DAY) }],
    ["a malformed token hash", { tokenHash: "abc" }],
    ["a revocation without a reason", { revokedAt: new Date() }],
  ])("refuses %s (23514)", async (_label, overrides) => {
    await expectCode(adminDb.insert(shareLinks).values(linkValues(A.tenantId, finalizedA, consentA, overrides)), "23514");
  });

  it("keeps token hashes unique (23505)", async () => {
    const tokenHash = hash();
    await adminDb.insert(shareLinks).values(linkValues(A.tenantId, finalizedA, consentA, { tokenHash }));
    await expectCode(adminDb.insert(shareLinks).values(linkValues(A.tenantId, finalizedA, consentA, { tokenHash })), "23505");
  });
});

describe("the share-token policy", () => {
  it("lets a session with no tenant read exactly the link whose token hash it names, and nothing else", async () => {
    const tokenHash = hash();
    const [link] = await adminDb.insert(shareLinks).values(linkValues(B.tenantId, finalizedB, consentB, { tokenHash })).returning();
    const lookup = (value: string | null) =>
      db.transaction(async (tx) => {
        if (value !== null) await tx.execute(sql`select set_config('app.share_token_hash', ${value}, true)`);
        return tx.select({ id: shareLinks.id, tenantId: shareLinks.tenantId }).from(shareLinks);
      });
    expect(await lookup(tokenHash)).toEqual([{ id: link.id, tenantId: B.tenantId }]);
    expect(await lookup(hash())).toEqual([]);
    expect(await lookup(null)).toEqual([]);
    // An empty hash is "unset", not a wildcard.
    expect(await lookup("")).toEqual([]);
    // SELECT only: the same session cannot change the link.
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.share_token_hash', ${tokenHash}, true)`);
      return tx.update(shareLinks).set({ openCount: 1 }).where(eq(shareLinks.id, link.id)).returning({ id: shareLinks.id });
    });
    expect(updated).toEqual([]);
  });
});

describe("prescription_shares", () => {
  it("is append-only and refuses unknown values", async () => {
    const [link] = await adminDb.insert(shareLinks).values(linkValues(A.tenantId, finalizedA, consentA)).returning();
    const share = { tenantId: A.tenantId, prescriptionId: finalizedA, shareLinkId: link.id, channel: "whatsapp", recipientMasked: "+91******3210", provider: "wa_link", status: "prepared" };
    const [row] = await withTenant(A.tenantId, (tx) => tx.insert(prescriptionShares).values(share).returning());
    await expectCode(withTenant(A.tenantId, (tx) => tx.update(prescriptionShares).set({ status: "sent" }).where(eq(prescriptionShares.id, row.id))), "42501");
    await expectCode(adminDb.update(prescriptionShares).set({ status: "sent" }).where(eq(prescriptionShares.id, row.id)), "23000");
    await expectCode(adminDb.insert(prescriptionShares).values({ ...share, status: "delivered" }), "23514");
    await expectCode(adminDb.insert(prescriptionShares).values({ ...share, provider: "twilio" }), "23514");
    await expectCode(adminDb.insert(prescriptionShares).values({ ...share, errorCode: "Bad Things!" }), "23514");
  });
});

describe("prescription_outputs from a share link", () => {
  it("needs a link for kind shared_pdf, and only then", async () => {
    const [link] = await adminDb.insert(shareLinks).values(linkValues(A.tenantId, finalizedA, consentA)).returning();
    const output = { tenantId: A.tenantId, prescriptionId: finalizedA, templateKey: "general", paperSize: "A4", htmlSha256: "b".repeat(64) };
    await adminDb.insert(prescriptionOutputs).values({ ...output, kind: "shared_pdf", shareLinkId: link.id, actorUserId: null });
    await expectCode(adminDb.insert(prescriptionOutputs).values({ ...output, kind: "shared_pdf" }), "23514");
    await expectCode(adminDb.insert(prescriptionOutputs).values({ ...output, kind: "browser_print", shareLinkId: link.id }), "23514");
  });
});

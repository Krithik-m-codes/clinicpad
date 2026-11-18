import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import { clinics, patientConsents, prescriptionOutputs, prescriptionShares, shareLinks } from "@/server/db/schema";
import { createPatient } from "@/server/services/patients";
import { amendPrescription, startPrescription } from "@/server/services/prescriptions";
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

function consentRow(T: TestTenant, patientId: string, granted: boolean) {
  return { tenantId: T.tenantId, patientId, purpose: "sharing", version: "sharing-v1", granted, method: "verbal", capturedBy: T.as("owner").userId };
}

async function newPatient(T: TestTenant, name: string): Promise<string> {
  const created = await createPatient(T.as("owner"), { name });
  if (!created.ok) throw new Error(created.message);
  return created.value.id;
}

async function grant(T: TestTenant, patientId: string, granted = true): Promise<string> {
  const [row] = await adminDb.insert(patientConsents).values(consentRow(T, patientId, granted)).returning();
  return row.id;
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
    .values(consentRow(A, patientA, true))
    .returning();
  const [cb] = await adminDb
    .insert(patientConsents)
    .values(consentRow(B, pb.value.id, true))
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
    const other = await newPatient(A, "Consent Isolation");
    const [row] = await withTenant(A.tenantId, (tx) =>
      tx.insert(patientConsents).values({ ...consentRow(A, other, false), method: "written" }).returning(),
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
      adminDb.insert(patientConsents).values({ ...consentRow(A, patientA, true), ...overrides }),
      "23514",
    );
  });

  it("belongs to a patient of the same clinic (23503)", async () => {
    const [foreign] = await adminDb.select({ patientId: patientConsents.patientId }).from(patientConsents).where(eq(patientConsents.id, consentB));
    await expectCode(
      adminDb.insert(patientConsents).values(consentRow(A, foreign.patientId, true)),
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
  ])("refuses %s (23514)", async (_label, overrides) => {
    await expectCode(adminDb.insert(shareLinks).values(linkValues(A.tenantId, finalizedA, consentA, overrides)), "23514");
  });

  it("refuses a revocation without a reason (23514)", async () => {
    const [link] = await adminDb.insert(shareLinks).values(linkValues(A.tenantId, finalizedA, consentA)).returning();
    await expectCode(adminDb.update(shareLinks).set({ revokedAt: new Date() }).where(eq(shareLinks.id, link.id)), "23514");
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

describe("tightened rules from migration 0023", () => {
  it("refuses a consent captured by nobody (23502)", async () => {
    await expectCode(adminDb.insert(patientConsents).values({ ...consentRow(A, patientA, true), capturedBy: null as unknown as string }), "23502");
  });

  it("stamps consent rows with the statement clock, so two events in one transaction stay ordered", async () => {
    const id = await newPatient(A, "Consent Clock");
    const rows = await adminDb.transaction(async (tx) => {
      const first = await tx.insert(patientConsents).values(consentRow(A, id, true)).returning();
      const second = await tx.insert(patientConsents).values(consentRow(A, id, false)).returning();
      return [first[0], second[0]];
    });
    expect(rows[1].createdAt.getTime()).toBeGreaterThan(rows[0].createdAt.getTime());
    const forced = await adminDb.insert(patientConsents).values({ ...consentRow(A, id, false), createdAt: new Date("2020-01-01T00:00:00Z") }).returning();
    expect(forced[0].createdAt.getFullYear()).toBeGreaterThan(2024);
  });

  it("pins a new link to its initial state whatever the insert says", async () => {
    const pid = await newPatient(A, "Pinned Initial");
    const consent = await grant(A, pid);
    const rx = await prescription(A, pid, true);
    const [link] = await adminDb
      .insert(shareLinks)
      .values(
        linkValues(A.tenantId, rx, consent, {
          openCount: 4,
          lastOpenedAt: new Date(),
          revokedAt: new Date(),
          revokedBy: A.as("owner").userId,
          revokeReason: "user",
          createdAt: new Date(Date.now() - 3 * DAY),
          expiresAt: new Date(Date.now() + DAY),
        }),
      )
      .returning();
    expect(link).toMatchObject({ openCount: 0, lastOpenedAt: null, revokedAt: null, revokedBy: null, revokeReason: null });
    expect(Math.abs(link.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it("refuses revoked_by without a revocation, a cleared last-opened time and a backdated revocation", async () => {
    const pid = await newPatient(A, "Rules Tight");
    const consent = await grant(A, pid);
    const rx = await prescription(A, pid, true);
    const [link] = await adminDb.insert(shareLinks).values(linkValues(A.tenantId, rx, consent)).returning();
    const where = eq(shareLinks.id, link.id);
    await expectCode(adminDb.update(shareLinks).set({ revokedBy: A.as("owner").userId }).where(where), "23514");
    await adminDb.update(shareLinks).set({ openCount: 1, lastOpenedAt: new Date() }).where(where);
    await expectCode(adminDb.update(shareLinks).set({ lastOpenedAt: null }).where(where), "23000");
    await expectCode(adminDb.update(shareLinks).set({ revokedAt: new Date(link.createdAt.getTime() - DAY), revokeReason: "user" }).where(where), "23000");
    await adminDb.update(shareLinks).set({ revokedAt: new Date(), revokedBy: A.as("owner").userId, revokeReason: "user" }).where(where);
  });
});

describe("the consent a link cites (I1)", () => {
  async function fresh(name: string) {
    const pid = await newPatient(A, name);
    return { pid, rx: await prescription(A, pid, true) };
  }

  it("refuses another patient's consent, a withdrawal row and a grant that was later withdrawn (23000)", async () => {
    const mine = await fresh("Cite Mine");
    const other = await newPatient(A, "Cite Other");
    const otherGrant = await grant(A, other);
    await expectCode(adminDb.insert(shareLinks).values(linkValues(A.tenantId, mine.rx, otherGrant)), "23000");

    const oldGrant = await grant(A, mine.pid);
    const withdrawal = await grant(A, mine.pid, false);
    await expectCode(adminDb.insert(shareLinks).values(linkValues(A.tenantId, mine.rx, withdrawal)), "23000");
    await expectCode(adminDb.insert(shareLinks).values(linkValues(A.tenantId, mine.rx, oldGrant)), "23000");
  });

  it("accepts the new grant after a re-grant, and refuses the old one", async () => {
    const mine = await fresh("Cite Regrant");
    const first = await grant(A, mine.pid);
    await grant(A, mine.pid, false);
    const second = await grant(A, mine.pid);
    await expectCode(adminDb.insert(shareLinks).values(linkValues(A.tenantId, mine.rx, first)), "23000");
    await adminDb.insert(shareLinks).values(linkValues(A.tenantId, mine.rx, second));
  });

  it("refuses a consent id that does not exist (23503)", async () => {
    const mine = await fresh("Cite Missing");
    await expectCode(adminDb.insert(shareLinks).values(linkValues(A.tenantId, mine.rx, "00000000-0000-4000-8000-000000000000")), "23503");
  });

  it("refuses a superseded (amended) prescription (23000)", async () => {
    const mine = await fresh("Cite Amended");
    const consent = await grant(A, mine.pid);
    const amendment = await amendPrescription(A.as("doctor"), { prescriptionId: mine.rx, reason: "Dose correction" });
    if (!amendment.ok) throw new Error(amendment.message);
    const saved = await saveDraftNow(A.as("doctor"), amendment.value.prescriptionId, { items: [{ drugName: "Amended Drug" }] });
    if (!saved.ok) throw new Error(saved.message);
    const done = await finalizeNow(A.as("doctor"), amendment.value.prescriptionId);
    if (!done.ok) throw new Error(done.message);
    await expectCode(adminDb.insert(shareLinks).values(linkValues(A.tenantId, mine.rx, consent)), "23000");
    await adminDb.insert(shareLinks).values(linkValues(A.tenantId, amendment.value.prescriptionId, consent));
  });
});

describe("the share log rules from migration 0023", () => {
  async function linkAndLog() {
    const pid = await newPatient(A, "Log Rules");
    const consent = await grant(A, pid);
    const rx = await prescription(A, pid, true);
    const [link] = await adminDb.insert(shareLinks).values(linkValues(A.tenantId, rx, consent)).returning();
    return {
      share: { tenantId: A.tenantId, prescriptionId: rx, shareLinkId: link.id, channel: "whatsapp", recipientMasked: "+91******3210", provider: "wa_link", status: "prepared" },
    };
  }

  it("refuses a row whose prescription or channel does not match its link (23000)", async () => {
    const { share } = await linkAndLog();
    await expectCode(adminDb.insert(prescriptionShares).values({ ...share, prescriptionId: finalizedA }), "23000");
    await expectCode(
      adminDb.insert(prescriptionShares).values({ ...share, channel: "email", provider: "resend", status: "sent", recipientMasked: "a***@x.com" }),
      "23000",
    );
    await adminDb.insert(prescriptionShares).values(share);
  });

  it.each([
    ["a recipient without a mask", { recipientMasked: "+919876543210" }],
    ["a recipient with a long digit run", { recipientMasked: "+9198765*3210" }],
    ["an email provider on a WhatsApp row", { provider: "resend" }],
    ["a WhatsApp link marked sent", { status: "sent" }],
    ["an error code on a prepared row", { errorCode: "bad_thing" }],
  ])("refuses %s (23514)", async (_label, overrides) => {
    const { share } = await linkAndLog();
    await expectCode(adminDb.insert(prescriptionShares).values({ ...share, ...overrides }), "23514");
  });

  it("is isolated per clinic and cannot be deleted by the runtime role", async () => {
    const { share } = await linkAndLog();
    const [row] = await withTenant(A.tenantId, (tx) => tx.insert(prescriptionShares).values(share).returning());
    expect(await withTenant(B.tenantId, (tx) => tx.select().from(prescriptionShares).where(eq(prescriptionShares.id, row.id)))).toHaveLength(0);
    await expectCode(withTenant(B.tenantId, (tx) => tx.insert(prescriptionShares).values(share)), "23503");
    await expectCode(withTenant(A.tenantId, (tx) => tx.delete(prescriptionShares).where(eq(prescriptionShares.id, row.id))), "42501");
    await expectCode(adminDb.delete(prescriptionShares).where(eq(prescriptionShares.id, row.id)), "23000");
  });
});

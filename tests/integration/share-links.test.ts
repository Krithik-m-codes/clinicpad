// @vitest-environment node
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { auditEvents, clinics, patients, prescriptionOutputs, shareLinks } from "@/server/db/schema";
import { amendPrescription, startPrescription } from "@/server/services/prescriptions";
import { archivePatient } from "@/server/services/patients";
import { withdrawSharingConsent } from "@/server/services/consent";
import { listPrescriptionOutputs } from "@/server/services/rx-output";
import {
  createShareLinkIn,
  listShareLinks,
  openSharedPrescription,
  resolveShareLink,
  revokeShareLink,
  SHARE_LIMITS,
} from "@/server/services/share-links";
import { createLimiter } from "@/server/pdf/limiter";
import { createFakePdfEngine } from "../helpers/fake-pdf-engine";
import { finalizeNow } from "../helpers/rx";
import { finalizedPrescription, linkFor, shareablePrescription } from "../helpers/share";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
const DAY = 86_400_000;
const engine = createFakePdfEngine(1);
const open = (token: string, extra: Parameters<typeof openSharedPrescription>[1] = {}) =>
  openSharedPrescription(token, { engine, limiter: createLimiter({ concurrency: 2, maxQueue: 5 }), ...extra });
const create = (T: TestTenant, prescriptionId: string, role = "doctor") =>
  withTenant(T.tenantId, (tx) => createShareLinkIn(tx, T.as(role), { prescriptionId, channel: "whatsapp" }, new Date()));
const row = async (linkId: string) => (await adminDb.select().from(shareLinks).where(eq(shareLinks.id, linkId)))[0];

beforeAll(async () => {
  A = await createTestTenant("links-a");
  B = await createTestTenant("links-b");
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

describe("creating a link", () => {
  it("stores only the token's hash, expires in 7 days with 10 opens, and audits without the token", async () => {
    const s = await shareablePrescription(A, "Link Asha");
    const before = Date.now();
    const link = await linkFor(A, s.prescriptionId);
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await row(link.linkId);
    expect(stored.tokenHash).toBe(createHash("sha256").update(link.token).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(link.token);
    expect(stored).toMatchObject({ maxOpens: SHARE_LIMITS.maxOpens, openCount: 0, channel: "whatsapp", consentId: s.consentId });
    expect(stored.expiresAt.getTime() - before).toBeGreaterThanOrEqual(7 * DAY - 5_000);
    expect(stored.expiresAt.getTime() - before).toBeLessThanOrEqual(7 * DAY + 5_000);
    const [event] = await adminDb
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "prescription.share_link_created"), eq(auditEvents.entityId, s.prescriptionId)));
    expect(event.after).toMatchObject({ linkId: link.linkId, channel: "whatsapp", maxOpens: 10 });
    expect(JSON.stringify(event)).not.toContain(link.token);
  });

  it("is refused while sharing is off, without consent, or after withdrawal", async () => {
    const s = await shareablePrescription(A, "Link Refusals");
    await adminDb.update(clinics).set({ sharingEnabled: false }).where(eq(clinics.tenantId, A.tenantId));
    expect(await create(A, s.prescriptionId)).toMatchObject({ ok: false, code: "unavailable" });
    await adminDb.update(clinics).set({ sharingEnabled: true }).where(eq(clinics.tenantId, A.tenantId));
    await withdrawSharingConsent(A.as("owner"), s.patientId, { method: "verbal" });
    expect(await create(A, s.prescriptionId)).toMatchObject({ ok: false, code: "conflict", field: "consent" });
  });

  it("is refused for a draft, a superseded version, an archived patient, and another clinic's prescription", async () => {
    const s = await shareablePrescription(A, "Link States");
    const draft = await startPrescription(A.as("doctor"), { patientId: s.patientId });
    if (!draft.ok) throw new Error(draft.message);
    expect(await create(A, draft.value.prescriptionId)).toMatchObject({ ok: false, code: "conflict" });
    const amendment = await amendPrescription(A.as("doctor"), { prescriptionId: s.prescriptionId, reason: "Dose correction" });
    if (!amendment.ok) throw new Error(amendment.message);
    await finalizeNow(A.as("doctor"), amendment.value.prescriptionId);
    expect(await create(A, s.prescriptionId)).toMatchObject({ ok: false, code: "conflict", message: expect.stringMatching(/latest version/) });
    expect(await create(B, amendment.value.prescriptionId)).toMatchObject({ ok: false, code: "not_found" });
    await adminDb.update(patients).set({ deletedAt: new Date() }).where(eq(patients.id, s.patientId));
    expect(await create(A, amendment.value.prescriptionId)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("allows at most 10 active links per prescription, and a revoked one frees a place", async () => {
    const s = await shareablePrescription(A, "Link Active Cap");
    const links = [];
    for (let i = 0; i < SHARE_LIMITS.activeLinksPerPrescription; i += 1) links.push(await linkFor(A, s.prescriptionId));
    expect(await create(A, s.prescriptionId)).toMatchObject({ ok: false, code: "conflict" });
    expect(await revokeShareLink(A.as("reception"), links[0].linkId)).toEqual({ ok: true, value: null });
    expect(await create(A, s.prescriptionId)).toMatchObject({ ok: true });
  });

  it("allows at most 60 links per user per hour", async () => {
    const s = await shareablePrescription(A, "Link Hourly Cap");
    const other = await finalizedPrescription(A, s.patientId);
    // A user of its own (as("reception") is a fresh random user per call): the doctor's later links stay under the cap.
    const busy = A.as("reception");
    const now = new Date();
    await adminDb.insert(shareLinks).values(
      Array.from({ length: SHARE_LIMITS.linksPerUserPerHour }, () => ({
        tenantId: A.tenantId,
        prescriptionId: other,
        consentId: s.consentId,
        tokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
        channel: "whatsapp",
        createdBy: busy.userId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + DAY),
        maxOpens: 10,
        revokedAt: now,
        revokeReason: "user",
      })),
    );
    const capped = await withTenant(A.tenantId, (tx) => createShareLinkIn(tx, busy, { prescriptionId: s.prescriptionId, channel: "whatsapp" }, new Date()));
    expect(capped).toMatchObject({ ok: false, code: "unavailable" });
    expect(await create(A, s.prescriptionId)).toMatchObject({ ok: true });
  });
});

describe("listing and revoking", () => {
  it("lists links with their state and lets rx.share roles withdraw one, once", async () => {
    const s = await shareablePrescription(A, "Link List");
    const active = await linkFor(A, s.prescriptionId);
    const revoked = await linkFor(A, s.prescriptionId);
    await revokeShareLink(A.as("doctor"), revoked.linkId);
    expect(await revokeShareLink(A.as("doctor"), revoked.linkId)).toMatchObject({ ok: false, code: "conflict" });
    expect(await revokeShareLink(A.as("nurse"), active.linkId)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await revokeShareLink(B.as("owner"), active.linkId)).toMatchObject({ ok: false, code: "not_found" });
    const listed = await listShareLinks(A.as("reception"), s.prescriptionId);
    expect(listed.ok && listed.value.map((l) => [l.id, l.status])).toEqual(
      expect.arrayContaining([
        [active.linkId, "active"],
        [revoked.linkId, "revoked"],
      ]),
    );
    expect(await listShareLinks(A.as("pharmacist"), s.prescriptionId)).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("resolving and opening a link", () => {
  it("opens the frozen PDF, counts one open, logs an output with no actor, and audits it", async () => {
    const s = await shareablePrescription(A, "Link Open");
    const link = await linkFor(A, s.prescriptionId);
    const outputsBefore = await listPrescriptionOutputs(A.as("doctor"), s.prescriptionId);
    expect(await resolveShareLink(link.token)).toMatchObject({ ok: true, value: { remainingOpens: 10, timeZone: "Asia/Kolkata" } });
    const opened = await open(link.token);
    expect(opened).toMatchObject({ ok: true, value: { fileName: expect.stringMatching(/^Rx-\d+-v1\.pdf$/) } });
    expect((await row(link.linkId)).openCount).toBe(1);
    const [output] = await adminDb.select().from(prescriptionOutputs).where(eq(prescriptionOutputs.shareLinkId, link.linkId));
    expect(output).toMatchObject({ kind: "shared_pdf", actorUserId: null, prescriptionId: s.prescriptionId });
    const [event] = await adminDb
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "prescription.share_opened"), eq(auditEvents.entityId, s.prescriptionId)));
    expect(event).toMatchObject({ actorUserId: null, after: { linkId: link.linkId, outputId: output.id, openCount: 1 } });
    // Shared opens are not prints: the page's "printed N times" stays the same.
    expect(await listPrescriptionOutputs(A.as("doctor"), s.prescriptionId)).toEqual(outputsBefore);
  });

  it("stops after the last allowed open", async () => {
    const s = await shareablePrescription(A, "Link Used Up");
    const link = await linkFor(A, s.prescriptionId);
    for (let i = 0; i < SHARE_LIMITS.maxOpens; i += 1) expect((await open(link.token)).ok).toBe(true);
    expect(await open(link.token)).toMatchObject({ ok: false, code: "not_found" });
    expect(await resolveShareLink(link.token)).toMatchObject({ ok: false, code: "not_found" });
    expect((await row(link.linkId)).openCount).toBe(SHARE_LIMITS.maxOpens);
  });

  it("answers the same not_found for a malformed, unknown, expired, revoked or switched-off link", async () => {
    const s = await shareablePrescription(A, "Link Gone");
    const link = await linkFor(A, s.prescriptionId);
    const gone = { ok: false, code: "not_found", message: "This link is not valid." };
    expect(await resolveShareLink("not-a-token")).toEqual(gone);
    expect(await resolveShareLink("a".repeat(43))).toEqual(gone);
    expect(await resolveShareLink(link.token, new Date(Date.now() + 8 * DAY))).toEqual(gone);
    expect(await open(link.token, { now: new Date(Date.now() + 8 * DAY) })).toEqual(gone);
    await adminDb.update(clinics).set({ sharingEnabled: false }).where(eq(clinics.tenantId, A.tenantId));
    expect(await open(link.token)).toEqual(gone);
    await adminDb.update(clinics).set({ sharingEnabled: true }).where(eq(clinics.tenantId, A.tenantId));
    expect((await open(link.token)).ok).toBe(true);
    await revokeShareLink(A.as("owner"), link.linkId);
    expect(await open(link.token)).toEqual(gone);
  });

  it("does not burn an open when the PDF cannot be made, or when the request was already cancelled", async () => {
    const s = await shareablePrescription(A, "Link Engine Down");
    const link = await linkFor(A, s.prescriptionId);
    engine.failWith = "pdf_unavailable";
    try {
      expect(await open(link.token)).toMatchObject({ ok: false, code: "unavailable" });
    } finally {
      engine.failWith = null;
    }
    const controller = new AbortController();
    controller.abort();
    expect(await open(link.token, { signal: controller.signal })).toMatchObject({ ok: false, code: "unavailable" });
    expect((await row(link.linkId)).openCount).toBe(0);
    expect(await adminDb.select().from(prescriptionOutputs).where(eq(prescriptionOutputs.shareLinkId, link.linkId))).toHaveLength(0);
  });

  it("keeps opening a version that was superseded later, marked SUPERSEDED on the pad", async () => {
    const s = await shareablePrescription(A, "Link Superseded");
    const link = await linkFor(A, s.prescriptionId);
    const amendment = await amendPrescription(A.as("doctor"), { prescriptionId: s.prescriptionId, reason: "Dose correction" });
    if (!amendment.ok) throw new Error(amendment.message);
    await finalizeNow(A.as("doctor"), amendment.value.prescriptionId);
    const calls = engine.calls.length;
    expect((await open(link.token)).ok).toBe(true);
    expect(engine.calls[calls].html).toContain("SUPERSEDED");
  });

  it("stops every link of a patient who is archived or withdraws consent", async () => {
    const archivedCase = await shareablePrescription(A, "Link Archived");
    const archivedLink = await linkFor(A, archivedCase.prescriptionId);
    await archivePatient(A.as("owner"), archivedCase.patientId);
    expect(await open(archivedLink.token)).toMatchObject({ ok: false, code: "not_found" });
    expect((await row(archivedLink.linkId)).revokeReason).toBe("patient_archived");
    const [archivedEvent] = await adminDb
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "patient.archived"), eq(auditEvents.entityId, archivedCase.patientId)));
    expect(archivedEvent.after).toEqual({ revokedLinks: 1 });

    const withdrawn = await shareablePrescription(A, "Link Withdrawn");
    const withdrawnLink = await linkFor(A, withdrawn.prescriptionId);
    await withdrawSharingConsent(A.as("reception"), withdrawn.patientId, { method: "verbal" });
    expect(await open(withdrawnLink.token)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("allows one render at a time per link and burns one open for two simultaneous requests", async () => {
    const s = await shareablePrescription(A, "Link Concurrent");
    const link = await linkFor(A, s.prescriptionId);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = createFakePdfEngine(1);
    const original = slow.render.bind(slow);
    slow.render = async (doc, opts) => {
      await held;
      return original(doc, opts);
    };
    const first = open(link.token, { engine: slow });
    await new Promise((r) => setTimeout(r, 300));
    expect(await open(link.token, { engine: slow })).toMatchObject({ ok: false, code: "unavailable" });
    release();
    expect((await first).ok).toBe(true);
    expect((await row(link.linkId)).openCount).toBe(1);
  });

  it("re-checks the clinic switch and the cancellation signal after the PDF was made, burning nothing", async () => {
    const s = await shareablePrescription(A, "Link Recheck");
    const link = await linkFor(A, s.prescriptionId);
    const flipping = createFakePdfEngine(1);
    const original = flipping.render.bind(flipping);
    flipping.render = async (doc, opts) => {
      await adminDb.update(clinics).set({ sharingEnabled: false }).where(eq(clinics.tenantId, A.tenantId));
      return original(doc, opts);
    };
    try {
      expect(await open(link.token, { engine: flipping })).toMatchObject({ ok: false, code: "not_found" });
    } finally {
      await adminDb.update(clinics).set({ sharingEnabled: true }).where(eq(clinics.tenantId, A.tenantId));
    }
    const controller = new AbortController();
    const cancelling = createFakePdfEngine(1);
    const orig2 = cancelling.render.bind(cancelling);
    cancelling.render = async (doc, opts) => {
      controller.abort();
      return orig2(doc, opts);
    };
    expect(await open(link.token, { engine: cancelling, signal: controller.signal })).toMatchObject({ ok: false, code: "unavailable" });
    expect((await row(link.linkId)).openCount).toBe(0);
    expect(await adminDb.select().from(prescriptionOutputs).where(eq(prescriptionOutputs.shareLinkId, link.linkId))).toHaveLength(0);
  });
});

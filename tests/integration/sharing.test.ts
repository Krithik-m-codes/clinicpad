// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { auditEvents, clinics, prescriptionShares, shareLinks } from "@/server/db/schema";
import { archivePatient } from "@/server/services/patients";
import { withdrawSharingConsent } from "@/server/services/consent";
import { startPrescription } from "@/server/services/prescriptions";
import { getSharePanel, shareByEmail, shareByWhatsApp } from "@/server/services/sharing";
import { createFakeEmailProvider } from "../helpers/fake-email";
import { shareablePrescription } from "../helpers/share";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
const APP = "http://localhost:3000";
const NAME = "Sharing Patient Meena";

beforeAll(async () => {
  A = await createTestTenant("sharing-svc");
  await adminDb.update(clinics).set({ name: "Asha <b>Clinic</b>" }).where(eq(clinics.tenantId, A.tenantId));
});

afterAll(async () => {
  await A.cleanup();
});

const sharesOf = (prescriptionId: string) => adminDb.select().from(prescriptionShares).where(eq(prescriptionShares.prescriptionId, prescriptionId));

describe("shareByWhatsApp", () => {
  it("returns a wa.me link for the patient's number with the share URL, and logs a masked recipient", async () => {
    const s = await shareablePrescription(A, NAME, "098765-43210");
    const result = await shareByWhatsApp(A.as("reception"), { prescriptionId: s.prescriptionId, phone: "098765-43210" }, { appUrl: APP });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.waUrl.startsWith("https://wa.me/919876543210?text=")).toBe(true);
    const text = new URL(result.value.waUrl).searchParams.get("text") ?? "";
    expect(text).toContain(result.value.url);
    expect(result.value.url).toMatch(/^http:\/\/localhost:3000\/s\/[A-Za-z0-9_-]{43}$/);
    expect(text).toContain("Asha <b>Clinic</b>");
    expect(text).not.toContain("Meena");
    expect(result.value.recipientMasked).toBe("+91******3210");
    expect(result.value.recipientDisplay).toBe("+91 98765 43210");
    expect(result.value.patientName).toBe(NAME);

    const [share] = await sharesOf(s.prescriptionId);
    expect(share).toMatchObject({ channel: "whatsapp", recipientMasked: "+91******3210", provider: "wa_link", status: "prepared", shareLinkId: result.value.linkId });
    const stored = JSON.stringify([await sharesOf(s.prescriptionId), await adminDb.select().from(shareLinks).where(eq(shareLinks.id, result.value.linkId))]);
    expect(stored).not.toContain("9876543210");
    const events = await adminDb.select().from(auditEvents).where(and(eq(auditEvents.tenantId, A.tenantId), eq(auditEvents.entityId, s.prescriptionId)));
    const shared = events.find((e) => e.action === "prescription.shared");
    expect(shared?.after).toMatchObject({ linkId: result.value.linkId, channel: "whatsapp", status: "prepared" });
    expect(JSON.stringify(events)).not.toMatch(/9876543210|\/s\/|Meena/);
  });

  it("refuses a bad number, a missing app URL, a draft, and roles without rx.share, creating no link", async () => {
    const s = await shareablePrescription(A, NAME);
    expect(await shareByWhatsApp(A.as("doctor"), { prescriptionId: s.prescriptionId, phone: "4155550100" }, { appUrl: APP })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "phone",
    });
    expect(await shareByWhatsApp(A.as("doctor"), { prescriptionId: s.prescriptionId, phone: "98765 43210" }, { appUrl: null })).toMatchObject({
      ok: false,
      code: "unavailable",
    });
    for (const role of ["nurse", "pharmacist", "accountant"]) {
      expect(await shareByWhatsApp(A.as(role), { prescriptionId: s.prescriptionId, phone: "98765 43210" }, { appUrl: APP })).toMatchObject({ ok: false, code: "forbidden" });
    }
    const draft = await startPrescription(A.as("doctor"), { patientId: s.patientId });
    if (!draft.ok) throw new Error(draft.message);
    expect(await shareByWhatsApp(A.as("doctor"), { prescriptionId: draft.value.prescriptionId, phone: "98765 43210" }, { appUrl: APP })).toMatchObject({
      ok: false,
      code: "conflict",
    });
    expect(await adminDb.select().from(shareLinks).where(eq(shareLinks.prescriptionId, s.prescriptionId))).toHaveLength(0);
  });
});

describe("shareByEmail", () => {
  it("is unavailable when no provider is configured", async () => {
    const s = await shareablePrescription(A, NAME);
    expect(await shareByEmail(A.as("doctor"), { prescriptionId: s.prescriptionId, email: "a@example.com" }, { email: null, appUrl: APP })).toMatchObject({
      ok: false,
      code: "unavailable",
    });
  });

  it("sends the link through the provider, escapes the clinic name in HTML, and logs the result", async () => {
    const s = await shareablePrescription(A, NAME);
    const email = createFakeEmailProvider();
    const result = await shareByEmail(A.as("doctor"), { prescriptionId: s.prescriptionId, email: "Meena.R@Example.com" }, { email, appUrl: APP });
    expect(result).toMatchObject({ ok: true, value: { recipientMasked: "M***@example.com" } });
    expect(email.sent).toHaveLength(1);
    const [m] = email.sent;
    expect(m.to).toBe("Meena.R@example.com");
    expect(m.subject).toBe("Your prescription from Asha <b>Clinic</b>");
    expect(m.html).toContain("Asha &lt;b&gt;Clinic&lt;/b&gt;");
    expect(m.text).toMatch(/http:\/\/localhost:3000\/s\/[A-Za-z0-9_-]{43}/);
    expect(`${m.subject} ${m.text} ${m.html}`).not.toContain("Sharing Patient");
    const rows = (await sharesOf(s.prescriptionId)).sort((a, b) => (a.status === "prepared" ? -1 : b.status === "prepared" ? 1 : 0));
    expect(rows.map((r) => r.status)).toEqual(["prepared", "sent"]);
    expect(rows[0]).toMatchObject({ channel: "email", provider: "fake", recipientMasked: "M***@example.com", providerMessageId: null });
    expect(rows[1]).toMatchObject({ channel: "email", status: "sent", provider: "fake", providerMessageId: "fake-1", recipientMasked: "M***@example.com" });
  });

  it("logs a send to an address with a long digit run in its domain (the mask can never break the log)", async () => {
    const s = await shareablePrescription(A, NAME);
    const email = createFakeEmailProvider();
    const result = await shareByEmail(A.as("doctor"), { prescriptionId: s.prescriptionId, email: "ravi@clinic12345.in" }, { email, appUrl: APP });
    expect(result).toMatchObject({ ok: true, value: { recipientMasked: "r***@clinic*****.in" } });
    expect(email.sent).toHaveLength(1);
    expect((await sharesOf(s.prescriptionId)).map((r) => r.status).sort()).toEqual(["prepared", "sent"]);
  });

  it("writes the prepared row before the provider is called", async () => {
    const s = await shareablePrescription(A, NAME);
    const email = createFakeEmailProvider();
    let seen: string[] = [];
    const send = email.send.bind(email);
    email.send = async (message) => {
      seen = (await sharesOf(s.prescriptionId)).map((r) => r.status);
      return send(message);
    };
    await shareByEmail(A.as("doctor"), { prescriptionId: s.prescriptionId, email: "a@example.com" }, { email, appUrl: APP });
    expect(seen).toEqual(["prepared"]);
  });

  it("still reports success, with a prepared row kept, when the outcome cannot be logged after a real send", async () => {
    const s = await shareablePrescription(A, NAME);
    const email = createFakeEmailProvider();
    email.send = async (message) => {
      email.sent.push(message);
      // a provider id longer than the log allows makes the second transaction fail
      return { ok: true, providerMessageId: "x".repeat(201) };
    };
    const result = await shareByEmail(A.as("doctor"), { prescriptionId: s.prescriptionId, email: "a@example.com" }, { email, appUrl: APP });
    expect(result.ok).toBe(true);
    expect(email.sent).toHaveLength(1);
    expect((await sharesOf(s.prescriptionId)).map((r) => r.status)).toEqual(["prepared"]);
  });

  it("counts a send whose outcome was never logged against the daily cap", async () => {
    const s = await shareablePrescription(A, NAME);
    const email = createFakeEmailProvider();
    email.send = async (message) => {
      email.sent.push(message);
      return { ok: true, providerMessageId: "x".repeat(201) };
    };
    for (let i = 0; i < 5; i += 1) {
      expect((await shareByEmail(A.as("doctor"), { prescriptionId: s.prescriptionId, email: `q${i}@example.com` }, { email, appUrl: APP })).ok).toBe(true);
    }
    expect(await shareByEmail(A.as("doctor"), { prescriptionId: s.prescriptionId, email: "q5@example.com" }, { email, appUrl: APP })).toMatchObject({ ok: false, code: "unavailable" });
    expect(email.sent).toHaveLength(5);
  });

  it("treats a provider that throws as a failed send and withdraws the link", async () => {
    const s = await shareablePrescription(A, NAME);
    const email = createFakeEmailProvider();
    email.send = async () => {
      throw new Error("boom");
    };
    expect(await shareByEmail(A.as("doctor"), { prescriptionId: s.prescriptionId, email: "a@example.com" }, { email, appUrl: APP })).toMatchObject({ ok: false, code: "unavailable" });
    const rows = await sharesOf(s.prescriptionId);
    expect(rows.map((r) => r.status).sort()).toEqual(["failed", "prepared"]);
    const [link] = await adminDb.select().from(shareLinks).where(eq(shareLinks.prescriptionId, s.prescriptionId));
    expect(link.revokeReason).toBe("send_failed");
  });

  it("refuses a header-injection address before anything is created", async () => {
    const s = await shareablePrescription(A, NAME);
    const email = createFakeEmailProvider();
    expect(
      await shareByEmail(A.as("doctor"), { prescriptionId: s.prescriptionId, email: "a@example.com\r\nBcc: x@example.com" }, { email, appUrl: APP }),
    ).toMatchObject({ ok: false, code: "invalid", field: "email" });
    expect(email.sent).toHaveLength(0);
  });

  it("withdraws the link and logs the failure when the provider fails", async () => {
    const s = await shareablePrescription(A, NAME);
    const email = createFakeEmailProvider();
    email.failWith = "email_rejected";
    const result = await shareByEmail(A.as("doctor"), { prescriptionId: s.prescriptionId, email: "a@example.com" }, { email, appUrl: APP });
    expect(result).toMatchObject({ ok: false, code: "unavailable" });
    const rows = await sharesOf(s.prescriptionId);
    expect(rows.map((r) => r.status).sort()).toEqual(["failed", "prepared"]);
    const share = rows.find((r) => r.status === "failed");
    if (!share) throw new Error("no failed row");
    expect(share).toMatchObject({ status: "failed", errorCode: "email_rejected" });
    const [link] = await adminDb.select().from(shareLinks).where(eq(shareLinks.id, share.shareLinkId));
    expect(link.revokeReason).toBe("send_failed");
  });

  it("sends at most five emails per prescription a day", async () => {
    const s = await shareablePrescription(A, NAME);
    const email = createFakeEmailProvider();
    for (let i = 0; i < 5; i += 1) {
      expect((await shareByEmail(A.as("doctor"), { prescriptionId: s.prescriptionId, email: `p${i}@example.com` }, { email, appUrl: APP })).ok).toBe(true);
    }
    expect(await shareByEmail(A.as("doctor"), { prescriptionId: s.prescriptionId, email: "p5@example.com" }, { email, appUrl: APP })).toMatchObject({
      ok: false,
      code: "unavailable",
    });
    expect(email.sent).toHaveLength(5);
  });
});

describe("getSharePanel", () => {
  it("gives the panel what it shows, only for rx.share roles and signed versions", async () => {
    const s = await shareablePrescription(A, NAME, "98765 43210");
    await shareByWhatsApp(A.as("doctor"), { prescriptionId: s.prescriptionId, phone: "98765 43210" }, { appUrl: APP });
    const panel = await getSharePanel(A.as("reception"), s.prescriptionId, { email: null });
    expect(panel).toMatchObject({
      ok: true,
      value: { status: "finalized", enabled: true, emailAvailable: false, defaultPhone: "98765 43210", timeZone: "Asia/Kolkata", consent: { granted: true } },
    });
    expect(panel.ok && panel.value.links.map((l) => [l.status, l.recipientMasked])).toEqual([["active", "+91******3210"]]);
    expect(await getSharePanel(A.as("pharmacist"), s.prescriptionId)).toMatchObject({ ok: false, code: "forbidden" });
    const draft = await startPrescription(A.as("doctor"), { patientId: s.patientId });
    if (!draft.ok) throw new Error(draft.message);
    expect(await getSharePanel(A.as("doctor"), draft.value.prescriptionId)).toMatchObject({ ok: false, code: "not_found" });
    expect(await getSharePanel(A.as("doctor"), s.prescriptionId, { email: createFakeEmailProvider() })).toMatchObject({ ok: true, value: { emailAvailable: true } });
  });
});

describe("the service re-checks every gate itself (createShareLinkIn trusts its caller)", () => {
  it("refuses when the clinic switch is off, consent is withdrawn, or the patient is archived, for both channels", async () => {
    const email = createFakeEmailProvider();
    const off = await shareablePrescription(A, NAME);
    await adminDb.update(clinics).set({ sharingEnabled: false }).where(eq(clinics.tenantId, A.tenantId));
    expect(await shareByWhatsApp(A.as("doctor"), { prescriptionId: off.prescriptionId, phone: "98765 43210" }, { appUrl: APP })).toMatchObject({ ok: false, code: "unavailable" });
    expect(await shareByEmail(A.as("doctor"), { prescriptionId: off.prescriptionId, email: "a@example.com" }, { email, appUrl: APP })).toMatchObject({ ok: false, code: "unavailable" });
    const panelOff = await getSharePanel(A.as("doctor"), off.prescriptionId, { email: null });
    expect(panelOff).toMatchObject({ ok: true, value: { enabled: false } });

    const withdrawn = await shareablePrescription(A, NAME);
    const w = await withdrawSharingConsent(A.as("owner"), withdrawn.patientId, { method: "verbal" });
    expect(w.ok).toBe(true);
    expect(await shareByWhatsApp(A.as("doctor"), { prescriptionId: withdrawn.prescriptionId, phone: "98765 43210" }, { appUrl: APP })).toMatchObject({ ok: false, code: "conflict" });
    expect(await shareByEmail(A.as("doctor"), { prescriptionId: withdrawn.prescriptionId, email: "a@example.com" }, { email, appUrl: APP })).toMatchObject({ ok: false, code: "conflict" });

    const archived = await shareablePrescription(A, NAME);
    expect((await archivePatient(A.as("owner"), archived.patientId)).ok).toBe(true);
    expect(await shareByWhatsApp(A.as("doctor"), { prescriptionId: archived.prescriptionId, phone: "98765 43210" }, { appUrl: APP })).toMatchObject({ ok: false });
    expect(await shareByEmail(A.as("doctor"), { prescriptionId: archived.prescriptionId, email: "a@example.com" }, { email, appUrl: APP })).toMatchObject({ ok: false });
    const panelArchived = await getSharePanel(A.as("doctor"), archived.prescriptionId, { email: null });
    expect(panelArchived).toMatchObject({ ok: true, value: { archived: true } });
    expect(email.sent).toHaveLength(0);
    for (const id of [off.prescriptionId, withdrawn.prescriptionId, archived.prescriptionId]) {
      expect(await adminDb.select().from(shareLinks).where(eq(shareLinks.prescriptionId, id))).toHaveLength(0);
    }
    await adminDb.update(clinics).set({ sharingEnabled: true }).where(eq(clinics.tenantId, A.tenantId));
  });

  it("refuses a roles-without-permission email too, and a number that looks Indian but has a bare +", async () => {
    const s = await shareablePrescription(A, NAME);
    const email = createFakeEmailProvider();
    expect(await shareByEmail(A.as("nurse"), { prescriptionId: s.prescriptionId, email: "a@example.com" }, { email, appUrl: APP })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await shareByWhatsApp(A.as("doctor"), { prescriptionId: s.prescriptionId, phone: "+9876543210" }, { appUrl: APP })).toMatchObject({ ok: false, code: "invalid", field: "phone" });
    expect(email.sent).toHaveLength(0);
  });

  it("never puts an email address or a phone number in the audit trail or the share log", async () => {
    const s = await shareablePrescription(A, NAME);
    const email = createFakeEmailProvider();
    await shareByEmail(A.as("doctor"), { prescriptionId: s.prescriptionId, email: "unique.person@example.com" }, { email, appUrl: APP });
    const events = await adminDb.select().from(auditEvents).where(and(eq(auditEvents.tenantId, A.tenantId), eq(auditEvents.entityId, s.prescriptionId)));
    expect(JSON.stringify(events)).not.toContain("unique.person");
    expect(JSON.stringify(await sharesOf(s.prescriptionId))).not.toContain("unique.person");
  });
});

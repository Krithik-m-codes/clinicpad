import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { auditEvents, clinics, patientConsents, patients, shareLinks } from "@/server/db/schema";
import { createPatient } from "@/server/services/patients";
import { startPrescription } from "@/server/services/prescriptions";
import { getSharingConsent, recordSharingConsent, withdrawSharingConsent } from "@/server/services/consent";
import { getClinicSharing, setClinicSharing } from "@/server/services/clinic";
import { SHARING_CONSENT_VERSION } from "@/lib/domain/consent";
import { finalizeNow, saveDraftNow } from "../helpers/rx";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;

async function patient(name: string, T: TestTenant = A): Promise<string> {
  const created = await createPatient(T.as("reception"), { name });
  if (!created.ok) throw new Error(created.message);
  return created.value.id;
}

async function finalizedFor(patientId: string): Promise<string> {
  const started = await startPrescription(A.as("doctor"), { patientId });
  if (!started.ok) throw new Error(started.message);
  await saveDraftNow(A.as("doctor"), started.value.prescriptionId, { items: [{ drugName: "Consent Drug" }] });
  const done = await finalizeNow(A.as("doctor"), started.value.prescriptionId);
  if (!done.ok) throw new Error(done.message);
  return started.value.prescriptionId;
}

async function linkFor(prescriptionId: string, consentId: string): Promise<string> {
  const now = new Date();
  const [row] = await adminDb
    .insert(shareLinks)
    .values({
      tenantId: A.tenantId,
      prescriptionId,
      consentId,
      tokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
      channel: "whatsapp",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 7 * 86_400_000),
      maxOpens: 10,
    })
    .returning();
  return row.id;
}

beforeAll(async () => {
  A = await createTestTenant("consent-a");
  B = await createTestTenant("consent-b");
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

describe("recordSharingConsent", () => {
  it("records the current consent version, by whom and how, and audits ids only", async () => {
    const id = await patient("Consent Asha");
    // as("reception") returns a new random user id on every call: keep one context for the call and the assertion.
    const reception = A.as("reception");
    const recorded = await recordSharingConsent(reception, id, { method: "verbal", confirmed: true, version: SHARING_CONSENT_VERSION });
    expect(recorded).toMatchObject({ ok: true, value: { granted: true, version: SHARING_CONSENT_VERSION, method: "verbal" } });
    if (!recorded.ok) return;
    const [row] = await adminDb.select().from(patientConsents).where(eq(patientConsents.id, recorded.value.id));
    expect(row).toMatchObject({ purpose: "sharing", capturedBy: reception.userId });
    const [event] = await adminDb
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, A.tenantId), eq(auditEvents.action, "patient.consent_recorded"), eq(auditEvents.entityId, id)));
    expect(event.after).toEqual({ consentId: recorded.value.id, purpose: "sharing", version: SHARING_CONSENT_VERSION, method: "verbal" });
    expect(JSON.stringify(event)).not.toContain("Consent Asha");
  });

  it("does not write a second row while the same consent is already recorded", async () => {
    const id = await patient("Consent Twice");
    const first = await recordSharingConsent(A.as("doctor"), id, { method: "written", confirmed: true, version: SHARING_CONSENT_VERSION });
    const second = await recordSharingConsent(A.as("doctor"), id, { method: "written", confirmed: true, version: SHARING_CONSENT_VERSION });
    expect(first.ok && second.ok && second.value.id).toBe(first.ok ? first.value.id : "");
    expect(await adminDb.select().from(patientConsents).where(eq(patientConsents.patientId, id))).toHaveLength(1);
  });

  it.each([
    [{ method: "verbal", confirmed: false, version: SHARING_CONSENT_VERSION }, "confirmed"],
    [{ method: "verbal", version: SHARING_CONSENT_VERSION }, "confirmed"],
    [{ method: "sms", confirmed: true, version: SHARING_CONSENT_VERSION }, "method"],
    [{ method: "verbal", confirmed: true }, "version"],
    [{ method: "verbal", confirmed: true, version: "sharing-v99" }, "version"],
    [{ method: "verbal", confirmed: true, version: "x" }, "version"],
  ])("refuses %j (field %s)", async (raw, field) => {
    const id = await patient("Consent Invalid");
    expect(await recordSharingConsent(A.as("owner"), id, raw)).toMatchObject({ ok: false, code: "invalid", field });
  });

  it("is refused to nurses, pharmacists and accountants, and for unknown, archived or foreign patients", async () => {
    const id = await patient("Consent Roles");
    for (const role of ["nurse", "pharmacist", "accountant"]) {
      expect(await recordSharingConsent(A.as(role), id, { method: "verbal", confirmed: true, version: SHARING_CONSENT_VERSION })).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(await recordSharingConsent(A.as("owner"), "x", { method: "verbal", confirmed: true, version: SHARING_CONSENT_VERSION })).toMatchObject({ ok: false, code: "not_found" });
    expect(await recordSharingConsent(B.as("owner"), id, { method: "verbal", confirmed: true, version: SHARING_CONSENT_VERSION })).toMatchObject({ ok: false, code: "not_found" });
    await adminDb.update(patients).set({ deletedAt: new Date() }).where(eq(patients.id, id));
    expect(await recordSharingConsent(A.as("owner"), id, { method: "verbal", confirmed: true, version: SHARING_CONSENT_VERSION })).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("recording again after a withdrawal", () => {
  it("writes a new grant row and leaves the history intact", async () => {
    const id = await patient("Consent Regrant");
    const owner = A.as("owner");
    const raw = { method: "verbal", confirmed: true, version: SHARING_CONSENT_VERSION };
    const first = await recordSharingConsent(owner, id, raw);
    expect(await withdrawSharingConsent(owner, id, { method: "verbal" })).toMatchObject({ ok: true });
    const second = await recordSharingConsent(owner, id, raw);
    expect(first.ok && second.ok && second.value.id !== first.value.id).toBe(true);
    expect(await getSharingConsent(owner, id)).toMatchObject({ ok: true, value: { granted: true } });
    expect(await adminDb.select().from(patientConsents).where(eq(patientConsents.patientId, id))).toHaveLength(3);
  });
});

describe("getSharingConsent", () => {
  it("is null without a record, and the latest event otherwise", async () => {
    const id = await patient("Consent Latest");
    expect(await getSharingConsent(A.as("nurse"), id)).toEqual({ ok: true, value: null });
    await recordSharingConsent(A.as("owner"), id, { method: "verbal", confirmed: true, version: SHARING_CONSENT_VERSION });
    await withdrawSharingConsent(A.as("owner"), id, { method: "written" });
    expect(await getSharingConsent(A.as("nurse"), id)).toMatchObject({ ok: true, value: { granted: false, method: "written" } });
    expect(await getSharingConsent(A.as("accountant"), id)).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("withdrawSharingConsent", () => {
  it("records the withdrawal and revokes every open link of that patient, and only that patient", async () => {
    const id = await patient("Consent Withdraw");
    const other = await patient("Consent Other");
    const granted = await recordSharingConsent(A.as("owner"), id, { method: "verbal", confirmed: true, version: SHARING_CONSENT_VERSION });
    const otherGranted = await recordSharingConsent(A.as("owner"), other, { method: "verbal", confirmed: true, version: SHARING_CONSENT_VERSION });
    if (!granted.ok || !otherGranted.ok) throw new Error("consent");
    const rx = await finalizedFor(id);
    const otherRx = await finalizedFor(other);
    const mine = [await linkFor(rx, granted.value.id), await linkFor(rx, granted.value.id)];
    const theirs = await linkFor(otherRx, otherGranted.value.id);

    expect(await withdrawSharingConsent(A.as("reception"), id, { method: "verbal" })).toEqual({ ok: true, value: { revokedLinks: 2 } });
    const rows = await adminDb.select().from(shareLinks).where(eq(shareLinks.tenantId, A.tenantId));
    for (const linkId of mine) expect(rows.find((r) => r.id === linkId)).toMatchObject({ revokeReason: "consent_withdrawn" });
    expect(rows.find((r) => r.id === theirs)).toMatchObject({ revokedAt: null });
    const [event] = await adminDb
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "patient.consent_withdrawn"), eq(auditEvents.entityId, id)));
    expect(event.after).toMatchObject({ purpose: "sharing", revokedLinks: 2 });
  });

  it("is still possible for an archived patient, and revokes that patient's links", async () => {
    const id = await patient("Consent Archived");
    const granted = await recordSharingConsent(A.as("owner"), id, { method: "verbal", confirmed: true, version: SHARING_CONSENT_VERSION });
    if (!granted.ok) throw new Error("consent");
    const link = await linkFor(await finalizedFor(id), granted.value.id);
    await adminDb.update(patients).set({ deletedAt: new Date() }).where(eq(patients.id, id));
    expect(await withdrawSharingConsent(A.as("owner"), id, { method: "verbal" })).toEqual({ ok: true, value: { revokedLinks: 1 } });
    const [row] = await adminDb.select().from(shareLinks).where(eq(shareLinks.id, link));
    expect(row.revokeReason).toBe("consent_withdrawn");
  });

  it("answers conflict when no consent is on record", async () => {
    const id = await patient("Consent None");
    expect(await withdrawSharingConsent(A.as("owner"), id, { method: "verbal" })).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("the clinic sharing switch", () => {
  it("is owner-only, refuses non-booleans, and audits only a real change", async () => {
    expect(await getClinicSharing(A.as("owner"))).toEqual({ ok: true, value: { enabled: false } });
    expect(await setClinicSharing(A.as("doctor"), true)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await setClinicSharing(A.as("owner"), "yes")).toMatchObject({ ok: false, code: "invalid" });
    expect(await setClinicSharing(A.as("owner"), true)).toEqual({ ok: true, value: { enabled: true, changed: true } });
    expect(await setClinicSharing(A.as("owner"), true)).toEqual({ ok: true, value: { enabled: true, changed: false } });
    const [clinic] = await adminDb.select().from(clinics).where(eq(clinics.tenantId, A.tenantId));
    expect(clinic.sharingEnabled).toBe(true);
    const events = await adminDb
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, A.tenantId), eq(auditEvents.action, "clinic.sharing_changed")));
    expect(events.map((e) => e.after)).toEqual([{ enabled: true }]);
  });
});

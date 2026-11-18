// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { auditEvents } from "@/server/db/schema";
import { withdrawSharingConsent } from "@/server/services/consent";
import { archivePatient } from "@/server/services/patients";
import { shareByWhatsApp } from "@/server/services/sharing";
import { shareablePrescription } from "../helpers/share";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
const APP = "http://localhost:3000";

beforeAll(async () => {
  A = await createTestTenant("share-revoked");
});
afterAll(async () => {
  await A.cleanup();
});

const revokedEvents = (prescriptionId: string) =>
  adminDb
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.tenantId, A.tenantId), eq(auditEvents.entityId, prescriptionId), eq(auditEvents.action, "share.revoked")));

async function share(prescriptionId: string): Promise<string> {
  const result = await shareByWhatsApp(A.as("doctor"), { prescriptionId, phone: "98765 43210" }, { appUrl: APP });
  if (!result.ok) throw new Error(result.message);
  return result.value.linkId;
}

describe("share.revoked: each link a withdrawal or an archive ends is on its prescription's audit trail", () => {
  it("records one system event per link when consent is withdrawn, with ids and the reason only", async () => {
    const s = await shareablePrescription(A, "Revoked Audit Meena");
    const first = await share(s.prescriptionId);
    const second = await share(s.prescriptionId);
    expect(await withdrawSharingConsent(A.as("owner"), s.patientId, { method: "verbal" })).toEqual({ ok: true, value: { revokedLinks: 2 } });
    const events = await revokedEvents(s.prescriptionId);
    expect(events).toHaveLength(2);
    expect(events.map((e) => (e.after as { linkId: string }).linkId).sort()).toEqual([first, second].sort());
    for (const e of events) {
      expect(e).toMatchObject({ actorUserId: null, entityType: "prescription", after: { reason: "consent_withdrawn" } });
    }
    expect(JSON.stringify(events)).not.toMatch(/9876543210|Meena/);
  });

  it("records the reason patient_archived when the patient is archived", async () => {
    const s = await shareablePrescription(A, "Revoked Audit Archive");
    const link = await share(s.prescriptionId);
    expect((await archivePatient(A.as("owner"), s.patientId)).ok).toBe(true);
    const events = await revokedEvents(s.prescriptionId);
    expect(events).toHaveLength(1);
    expect(events[0].after).toEqual({ linkId: link, reason: "patient_archived" });
  });

  it("writes nothing when there was no link to revoke", async () => {
    const s = await shareablePrescription(A, "Revoked Audit None");
    expect((await withdrawSharingConsent(A.as("owner"), s.patientId, { method: "verbal" })).ok).toBe(true);
    expect(await revokedEvents(s.prescriptionId)).toHaveLength(0);
  });
});

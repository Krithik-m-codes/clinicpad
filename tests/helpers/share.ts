import { SHARING_CONSENT_VERSION } from "@/lib/domain/consent";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { clinics } from "@/server/db/schema";
import { withTenant } from "@/server/db/tenant";
import { recordSharingConsent } from "@/server/services/consent";
import { createPatient } from "@/server/services/patients";
import { startPrescription } from "@/server/services/prescriptions";
import { createShareLinkIn, type CreatedLink, type ShareChannel } from "@/server/services/share-links";
import { finalizeNow, saveDraftNow } from "./rx";
import type { TestTenant } from "./tenant";

/** Sharing switched on, a patient with consent on record, and one finalized prescription. */
export async function shareablePrescription(T: TestTenant, name: string, phone = "98765 43210") {
  await adminDb.update(clinics).set({ sharingEnabled: true }).where(eq(clinics.tenantId, T.tenantId));
  const patient = await createPatient(T.as("owner"), { name, phone }, { allowDuplicate: true });
  if (!patient.ok) throw new Error(patient.message);
  const consent = await recordSharingConsent(T.as("owner"), patient.value.id, { method: "verbal", confirmed: true, version: SHARING_CONSENT_VERSION });
  if (!consent.ok) throw new Error(consent.message);
  const prescriptionId = await finalizedPrescription(T, patient.value.id);
  return { patientId: patient.value.id, consentId: consent.value.id, prescriptionId };
}

export async function finalizedPrescription(T: TestTenant, patientId: string): Promise<string> {
  const started = await startPrescription(T.as("doctor"), { patientId });
  if (!started.ok) throw new Error(started.message);
  const saved = await saveDraftNow(T.as("doctor"), started.value.prescriptionId, { items: [{ drugName: "Share Drug", doseMorning: 1 }] });
  if (!saved.ok) throw new Error(saved.message);
  const done = await finalizeNow(T.as("doctor"), started.value.prescriptionId);
  if (!done.ok) throw new Error(done.message);
  return started.value.prescriptionId;
}

/** A link created the way the sharing service creates one (Task 10 adds the share log around it). */
export async function linkFor(T: TestTenant, prescriptionId: string, channel: ShareChannel = "whatsapp", role = "doctor"): Promise<CreatedLink> {
  const ctx = T.as(role);
  const created = await withTenant(T.tenantId, (tx) => createShareLinkIn(tx, ctx, { prescriptionId, channel }, new Date()));
  if (!created.ok) throw new Error(`${created.code}: ${created.message}`);
  return created.value;
}

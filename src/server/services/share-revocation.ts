import { and, eq, inArray, isNull } from "drizzle-orm";
import { prescriptions, shareLinks, visits } from "@/server/db/schema";
import type { TenantTx } from "@/server/db/tenant";

export type RevokeReason = "user" | "consent_withdrawn" | "patient_archived" | "send_failed";

/**
 * Withdraws every not-yet-withdrawn link to any prescription of the patient (expired and used-up ones too, so the
 * record says why each link ended). The caller must hold the patient row lock (Plan 1D decision 13), so a link
 * created concurrently either committed before (and is revoked here) or waits and then sees the new state.
 */
export async function revokeActiveLinksForPatient(
  tx: TenantTx,
  tenantId: string,
  patientId: string,
  reason: RevokeReason,
  actorUserId: string | null,
): Promise<number> {
  const ofPatient = tx
    .select({ id: prescriptions.id })
    .from(prescriptions)
    .innerJoin(visits, eq(visits.id, prescriptions.visitId))
    .where(and(eq(visits.tenantId, tenantId), eq(visits.patientId, patientId)));
  const revoked = await tx
    .update(shareLinks)
    .set({ revokedAt: new Date(), revokedBy: actorUserId, revokeReason: reason })
    .where(and(eq(shareLinks.tenantId, tenantId), isNull(shareLinks.revokedAt), inArray(shareLinks.prescriptionId, ofPatient)))
    .returning({ id: shareLinks.id });
  return revoked.length;
}

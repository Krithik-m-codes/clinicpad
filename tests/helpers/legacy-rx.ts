import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { doctors, prescriptionItems, prescriptions, visits } from "@/server/db/schema";
import type { TestTenant } from "./tenant";

let legacyRxNo = 9500;

/** A finalized prescription written the way rows were written before plan 1C: no snapshot, no finalized_by. */
export async function legacyFinalized(T: TestTenant, patientId: string, finalizedAt: Date, snapshot: unknown = null): Promise<string> {
  const [doc] = await adminDb.select({ id: doctors.id }).from(doctors).where(eq(doctors.userId, T.as("doctor").userId)).limit(1);
  const [visit] = await adminDb
    .insert(visits)
    .values({ tenantId: T.tenantId, patientId, doctorId: doc.id, status: "draft", diagnosis: ["Legacy"] })
    .returning();
  const [rx] = await adminDb
    .insert(prescriptions)
    .values({ tenantId: T.tenantId, visitId: visit.id, status: "draft", renderSnapshot: snapshot })
    .returning();
  await adminDb.insert(prescriptionItems).values({ tenantId: T.tenantId, prescriptionId: rx.id, drugName: "Legacy drug" });
  legacyRxNo += 1;
  await adminDb.update(prescriptions).set({ status: "finalized", rxNo: legacyRxNo, finalizedAt }).where(eq(prescriptions.id, rx.id));
  // The draft-visit guard (0008) accepts only the plain flip once the prescription is finalized.
  await adminDb.update(visits).set({ status: "finalized", finalizedAt }).where(eq(visits.id, visit.id));
  return rx.id;
}

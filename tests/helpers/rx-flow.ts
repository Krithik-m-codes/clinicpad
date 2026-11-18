import type { ServiceContext } from "@/server/services/context";
import { createPatient } from "@/server/services/patients";
import { finalizePrescription, saveDraft, startPrescription } from "@/server/services/prescriptions";

export async function newPatient(ctx: ServiceContext, name: string): Promise<string> {
  const created = await createPatient(ctx, { name }, { allowDuplicate: true });
  if (!created.ok) throw new Error(created.message);
  return created.value.id;
}

/** A draft with one medicine, saved the way the editor saves it. */
export async function savedDraft(ctx: ServiceContext, patientId: string): Promise<{ id: string; revision: number }> {
  const started = await startPrescription(ctx, { patientId });
  if (!started.ok) throw new Error(started.message);
  const saved = await saveDraft(ctx, started.value.prescriptionId, { items: [{ drugName: "Paracetamol", doseMorning: 1, doseNight: 1 }] }, { baseRevision: 0 });
  if (!saved.ok) throw new Error(saved.message);
  return { id: started.value.prescriptionId, revision: saved.value.revision };
}

/** Finalized exactly the way finalizeDraftAction does it. Throws on refusal (use savedDraft + finalizePrescription to test refusals). */
export async function finalized(ctx: ServiceContext, patientId: string): Promise<string> {
  const { id, revision } = await savedDraft(ctx, patientId);
  const done = await finalizePrescription(ctx, id, { expectedRevision: revision });
  if (!done.ok) throw new Error(`${done.code}: ${done.message}`);
  return id;
}

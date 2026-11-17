"use server";

import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { amendPrescription, repeatPrescription, startPrescription } from "@/server/services/prescriptions";

export type AmendFormState = { error?: string };
export type RepeatFormState = { error?: string };

export async function startPrescriptionAction(patientId: string): Promise<void> {
  const session = await requireSession();
  const result = await startPrescription(session, { patientId });
  if (!result.ok) redirect(`/patients/${encodeURIComponent(patientId)}?error=${result.code}`);
  redirect(`/prescriptions/${result.value.prescriptionId}`);
}

export async function amendAction(
  id: string,
  _prev: AmendFormState,
  formData: FormData,
): Promise<AmendFormState> {
  const session = await requireSession();
  const result = await amendPrescription(session, {
    prescriptionId: id,
    reason: String(formData.get("reason") ?? ""),
  });
  if (!result.ok) return { error: result.message };
  redirect(`/prescriptions/${result.value.prescriptionId}`);
}

export async function repeatAction(id: string): Promise<RepeatFormState> {
  const session = await requireSession();
  const result = await repeatPrescription(session, id);
  if (!result.ok) return { error: result.message };
  redirect(`/prescriptions/${result.value.prescriptionId}`);
}

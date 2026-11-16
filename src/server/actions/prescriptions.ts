"use server";

import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import {
  amendPrescription,
  finalizePrescription,
  repeatPrescription,
  saveDraft,
  startPrescription,
} from "@/server/services/prescriptions";

export type DraftFormState = { error?: string; field?: string; savedAt?: string };
export type AmendFormState = { error?: string };
export type RepeatFormState = { error?: string };

export async function startPrescriptionAction(patientId: string): Promise<void> {
  const session = await requireSession();
  const result = await startPrescription(session, { patientId });
  if (!result.ok) redirect(`/patients/${encodeURIComponent(patientId)}?error=${result.code}`);
  redirect(`/prescriptions/${result.value.prescriptionId}`);
}

/**
 * Saves the draft and, when the form was submitted with intent=finalize, finalizes it.
 * The save always runs first, so finalizing can never drop edits that were not saved yet.
 */
export async function saveDraftAction(
  id: string,
  _prev: DraftFormState,
  formData: FormData,
): Promise<DraftFormState> {
  const session = await requireSession();

  let payload: unknown;
  try {
    payload = JSON.parse(String(formData.get("payload") ?? "{}"));
  } catch {
    return { error: "Could not read the form. Reload the page and try again." };
  }

  const saved = await saveDraft(session, id, payload);
  if (!saved.ok) return { error: saved.message, field: saved.field };
  const savedAt = saved.value.savedAt.toISOString();

  if (formData.get("intent") === "finalize") {
    const done = await finalizePrescription(session, id);
    // The edits above are already saved; say so, so the doctor knows nothing was lost.
    if (!done.ok) return { error: done.message, field: done.field, savedAt };
    redirect(`/prescriptions/${id}`);
  }
  return { savedAt };
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

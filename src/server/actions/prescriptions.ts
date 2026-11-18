"use server";

import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import {
  amendPrescription,
  discardDraft,
  repeatPrescription,
  startPrescription,
} from "@/server/services/prescriptions";

export type AmendFormState = { error?: string };
export type DiscardFormState = { error?: string };
export type RepeatFormState = { error?: string };

// A "use server" module may only export async functions and types, so this stays private.
const DISCARD_GONE = "This draft was changed or discarded elsewhere.";

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

/** Discards a draft or withdraws an open amendment after the user confirmed it in the form. */
export async function discardDraftAction(id: string, _prev: DiscardFormState): Promise<DiscardFormState> {
  void _prev; // useActionState passes the previous state first; it is not needed here.
  const session = await requireSession();
  const result = await discardDraft(session, id);
  if (!result.ok) {
    // The draft is gone: finalized or discarded from another window (the form then refreshes the page).
    return { error: result.code === "not_found" ? DISCARD_GONE : result.message };
  }
  // Outside any try/catch: redirect() works by throwing.
  redirect(
    result.value.parentPrescriptionId
      ? `/prescriptions/${result.value.parentPrescriptionId}`
      : `/patients/${result.value.patientId}`,
  );
}

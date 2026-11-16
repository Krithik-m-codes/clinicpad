"use server";

import { getSessionContext } from "@/server/auth/session";
import { finalizePrescription, saveDraft } from "@/server/services/prescriptions";

export type ActionFailure = {
  ok: false;
  code: string;
  message: string;
  field?: string;
  currentRevision?: number;
};
export type AutosaveResponse = { ok: true; revision: number; savedAt: string } | ActionFailure;
export type FinalizeResponse = { ok: true; rxNo: number } | (ActionFailure & { revision?: number; savedAt?: string });

const SIGNED_OUT: ActionFailure = { ok: false, code: "unauthenticated", message: "You were signed out." };

function failure(result: { code: string; message: string; field?: string; currentRevision?: number }): ActionFailure {
  const out: ActionFailure = { ok: false, code: result.code, message: result.message };
  if (result.field) out.field = result.field;
  if (typeof result.currentRevision === "number") out.currentRevision = result.currentRevision;
  return out;
}

/** Saves a full draft snapshot based on `baseRevision`. Never redirects. */
export async function autosaveDraftAction(
  prescriptionId: string,
  payload: unknown,
  baseRevision: number,
): Promise<AutosaveResponse> {
  const session = await getSessionContext();
  if (!session) return SIGNED_OUT;
  const result = await saveDraft(session, prescriptionId, payload, { baseRevision });
  if (!result.ok) return failure(result);
  return { ok: true, revision: result.value.revision, savedAt: result.value.savedAt.toISOString() };
}

/**
 * Saves the snapshot the doctor is looking at, then finalizes exactly that revision, so a
 * save from another window in between makes finalize fail instead of finalizing unseen
 * content. Never redirects; the client refreshes the page on success.
 */
export async function finalizeDraftAction(
  prescriptionId: string,
  payload: unknown,
  baseRevision: number,
): Promise<FinalizeResponse> {
  const session = await getSessionContext();
  if (!session) return SIGNED_OUT;
  const saved = await saveDraft(session, prescriptionId, payload, { baseRevision });
  if (!saved.ok) return failure(saved);
  const done = await finalizePrescription(session, prescriptionId, { expectedRevision: saved.value.revision });
  if (!done.ok) {
    return { ...failure(done), revision: saved.value.revision, savedAt: saved.value.savedAt.toISOString() };
  }
  return { ok: true, rxNo: done.value.rxNo };
}

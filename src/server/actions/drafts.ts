"use server";

import { getSessionContext } from "@/server/auth/session";
import { finalizePrescription, saveDraft } from "@/server/services/prescriptions";

export type ActionFailure = {
  ok: false;
  code: string;
  message: string;
  field?: string;
  path?: string;
  currentRevision?: number;
};
export type AutosaveResponse = { ok: true; revision: number; savedAt: string } | ActionFailure;
export type FinalizeResponse = { ok: true; rxNo: number } | (ActionFailure & { revision?: number; savedAt?: string });

const SIGNED_OUT: ActionFailure = { ok: false, code: "unauthenticated", message: "You were signed out." };
const INTERNAL: ActionFailure = {
  ok: false,
  code: "internal",
  message: "Something went wrong. Your changes are kept; trying again.",
};
const BAD_REVISION: ActionFailure = {
  ok: false,
  code: "invalid",
  message: "The draft revision is missing or invalid. Reload the page.",
  field: "baseRevision",
};

function failure(result: { code: string; message: string; field?: string; path?: string; currentRevision?: number }): ActionFailure {
  const out: ActionFailure = { ok: false, code: result.code, message: result.message };
  if (result.field) out.field = result.field;
  if (result.path) out.path = result.path;
  if (typeof result.currentRevision === "number") out.currentRevision = result.currentRevision;
  return out;
}

/**
 * Arrives from the client over the wire, so the TypeScript type proves nothing. A missing
 * revision must not reach saveDraft, which would then skip its optimistic-concurrency check.
 */
function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Logs the error class only: exception messages can carry row values. */
function logInternal(action: string, error: unknown): void {
  console.error(`${action} failed`, error instanceof Error ? error.name : typeof error);
}

/** Saves a full draft snapshot based on `baseRevision`. Never redirects and never throws. */
export async function autosaveDraftAction(
  prescriptionId: string,
  payload: unknown,
  baseRevision: number,
): Promise<AutosaveResponse> {
  try {
    const session = await getSessionContext();
    if (!session) return SIGNED_OUT;
    if (!isRevision(baseRevision)) return BAD_REVISION;
    const result = await saveDraft(session, prescriptionId, payload, { baseRevision });
    if (!result.ok) return failure(result);
    return { ok: true, revision: result.value.revision, savedAt: result.value.savedAt.toISOString() };
  } catch (error) {
    logInternal("autosaveDraftAction", error);
    return INTERNAL;
  }
}

/**
 * Saves the snapshot the doctor is looking at, then finalizes exactly that revision, so a
 * save from another window in between makes finalize fail instead of finalizing unseen
 * content. Never redirects and never throws; the client refreshes the page on success.
 */
export async function finalizeDraftAction(
  prescriptionId: string,
  payload: unknown,
  baseRevision: number,
): Promise<FinalizeResponse> {
  let saved: { revision: number; savedAt: string } | null = null;
  try {
    const session = await getSessionContext();
    if (!session) return SIGNED_OUT;
    if (!isRevision(baseRevision)) return BAD_REVISION;
    const result = await saveDraft(session, prescriptionId, payload, { baseRevision });
    if (!result.ok) return failure(result);
    saved = { revision: result.value.revision, savedAt: result.value.savedAt.toISOString() };
    const done = await finalizePrescription(session, prescriptionId, { expectedRevision: saved.revision });
    if (!done.ok) return { ...failure(done), ...saved };
    return { ok: true, rxNo: done.value.rxNo };
  } catch (error) {
    logInternal("finalizeDraftAction", error);
    // The snapshot may already be saved; tell the client so its next attempt uses that revision.
    return saved ? { ...INTERNAL, ...saved } : INTERNAL;
  }
}

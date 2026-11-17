"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createAutosaver, outcomeFromResponse, type Autosaver, type AutosaveStatus } from "@/lib/rx/autosave";
import { toDraftPayload, type EditorState } from "@/lib/rx/editor-state";
import { autosaveDraftAction, finalizeDraftAction, type FinalizeResponse } from "@/server/actions/drafts";

/** A finalize that has not answered after this long is treated as an unknown outcome. */
export const FINALIZE_TIMEOUT_MS = 45_000;
/** The server may have finalized even though no answer arrived, so never claim it did not. */
export const COULD_NOT_CONFIRM_MESSAGE =
  "Could not confirm that the prescription was finalized. Reloading its current state; if it is still a draft, try again.";

/** Failure codes after which the prescription may or may not have been finalized. */
export function isUnknownOutcome(code: string): boolean {
  return code === "internal" || code === "unreachable";
}

/** Rejects with `Error("timeout")` when the call does not settle in time; a late answer is ignored. */
function withTimeout<T>(promise: Promise<T>, ms: number, timers: Set<ReturnType<typeof setTimeout>>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    timers.add(timer);
    promise.then(
      (value) => {
        clearTimeout(timer);
        timers.delete(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        timers.delete(timer);
        reject(error);
      },
    );
  });
}

/**
 * Connects the pure autosaver to React and the server actions. The saver is created in an
 * effect (not during render) so React Strict Mode's mount/unmount/mount cycle cannot leave
 * a disposed saver in use.
 */
export function useAutosave(prescriptionId: string, initial: EditorState, initialRevision: number) {
  const [status, setStatus] = useState<AutosaveStatus>({ state: "saved", savedAt: null });
  // False on the server and until the saver exists; the editor stays disabled until then, so
  // nothing can be typed into server-rendered inputs before hydration (it would be lost).
  const [ready, setReady] = useState(false);
  const saverRef = useRef<Autosaver<EditorState> | null>(null);
  const seed = useRef({ initial, initialRevision });
  // Pending finalize timers; cleared on unmount so none fires after the editor is gone.
  const finalizeTimers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const saver = createAutosaver<EditorState>({
      initial: seed.current.initial,
      initialRevision: seed.current.initialRevision,
      save: async (snapshot, baseRevision) =>
        outcomeFromResponse(await autosaveDraftAction(prescriptionId, toDraftPayload(snapshot), baseRevision)),
      onStatus: setStatus,
    });
    saverRef.current = saver;
    setReady(true);

    const onOnline = () => saver.retryNow();
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!saver.hasUnsavedChanges()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      for (const timer of finalizeTimers.current) clearTimeout(timer);
      finalizeTimers.current.clear();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("beforeunload", onBeforeUnload);
      // Keep-safe teardown: one last best-effort save when edits are unsaved.
      saver.dispose();
      if (saverRef.current === saver) saverRef.current = null;
    };
  }, [prescriptionId]);

  const update = useCallback((state: EditorState) => saverRef.current?.update(state), []);
  const flush = useCallback(() => saverRef.current?.flush() ?? Promise.resolve(), []);
  const retryNow = useCallback(() => saverRef.current?.retryNow(), []);
  const overwrite = useCallback(() => saverRef.current?.overwrite(), []);
  /** Drops local edits and sends nothing: only after the doctor chose the server's version, or after finalizing. */
  const stop = useCallback(() => saverRef.current?.discard(), []);
  const hasUnsavedChanges = useCallback(() => saverRef.current?.hasUnsavedChanges() ?? false, []);

  /**
   * Saves the latest snapshot and finalizes exactly that revision, after any in-flight save.
   * Never rejects: a lost or late answer is `unreachable` (outcome unknown) and an engine refusal
   * (saving stopped, editor closed) is `not_run`.
   */
  const finalize = useCallback(async (): Promise<FinalizeResponse> => {
    const saver = saverRef.current;
    if (!saver) return { ok: false, code: "not_run", message: "The editor is still loading. Try again." };
    try {
      return await saver.exclusive<FinalizeResponse>(async (snapshot, baseRevision) => {
        let res: FinalizeResponse;
        try {
          res = await withTimeout(finalizeDraftAction(prescriptionId, toDraftPayload(snapshot), baseRevision), FINALIZE_TIMEOUT_MS, finalizeTimers.current);
        } catch {
          res = { ok: false, code: "unreachable", message: COULD_NOT_CONFIRM_MESSAGE };
        }
        return res.ok
          ? { revision: null, value: res }
          : { revision: typeof res.revision === "number" ? res.revision : null, savedAt: res.savedAt, value: res };
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message.replace(/\.$/, "") : "unknown reason";
      return { ok: false, code: "not_run", message: `Finalize did not run: ${reason}. See the save status above.` };
    }
  }, [prescriptionId]);

  return { status, ready, update, flush, retryNow, overwrite, stop, hasUnsavedChanges, finalize };
}

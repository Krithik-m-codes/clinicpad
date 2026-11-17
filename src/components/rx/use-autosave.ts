"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createAutosaver, outcomeFromResponse, type Autosaver, type AutosaveStatus } from "@/lib/rx/autosave";
import { toDraftPayload, type EditorState } from "@/lib/rx/editor-state";
import { autosaveDraftAction, finalizeDraftAction, type FinalizeResponse } from "@/server/actions/drafts";

export const FINALIZE_OFFLINE_MESSAGE = "Could not reach the server. Nothing was finalized; your draft is still here.";

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

  /** Saves the latest snapshot and finalizes exactly that revision, after any in-flight save. */
  const finalize = useCallback(async (): Promise<FinalizeResponse> => {
    const saver = saverRef.current;
    if (!saver) return { ok: false, code: "not_ready", message: "The editor is still loading. Try again." };
    return saver.exclusive<FinalizeResponse>(async (snapshot, baseRevision) => {
      const res = await finalizeDraftAction(prescriptionId, toDraftPayload(snapshot), baseRevision);
      return res.ok
        ? { revision: null, value: res }
        : { revision: typeof res.revision === "number" ? res.revision : null, savedAt: res.savedAt, value: res };
    });
  }, [prescriptionId]);

  return { status, ready, update, flush, retryNow, overwrite, stop, hasUnsavedChanges, finalize };
}

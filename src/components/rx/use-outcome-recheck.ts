"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { CHECK_LATER_MESSAGE, COULD_NOT_CONFIRM_MESSAGE } from "./use-autosave";

type Deps = {
  flush: () => Promise<void>;
  hasUnsavedChanges: () => boolean;
  /** Re-reads the server's state (router.refresh). */
  refresh: () => void;
  setMessage: (message: string) => void;
  mounted: MutableRefObject<boolean>;
};

/**
 * After a finalize whose outcome is unknown: save what is left, then re-read the page. A refresh that
 * cannot reach the server becomes a full browser reload (and a "Leave site?" prompt), so it only runs
 * when the browser is online and nothing is left unsaved; otherwise the check waits for the next
 * `online` event (the listener is removed on unmount).
 */
export function useOutcomeRecheck(deps: Deps): () => Promise<void> {
  const [waiting, setWaiting] = useState(false);

  async function recheck(): Promise<void> {
    await deps.flush();
    if (!deps.mounted.current) return;
    if (navigator.onLine !== false && !deps.hasUnsavedChanges()) {
      setWaiting(false);
      deps.setMessage(COULD_NOT_CONFIRM_MESSAGE);
      deps.refresh();
      return;
    }
    deps.setMessage(CHECK_LATER_MESSAGE);
    setWaiting(true);
  }

  const latest = useRef(recheck);
  useEffect(() => {
    latest.current = recheck;
  });
  useEffect(() => {
    if (!waiting) return;
    const onOnline = () => {
      setWaiting(false);
      void latest.current();
    };
    window.addEventListener("online", onOnline, { once: true });
    return () => window.removeEventListener("online", onOnline);
  }, [waiting]);

  return recheck;
}

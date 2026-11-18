"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { CHECK_LATER_MESSAGE, COULD_NOT_CONFIRM_MESSAGE, COULD_NOT_CONFIRM_RELOAD_MESSAGE } from "./use-autosave";

type Deps = {
  flush: () => Promise<void>;
  hasUnsavedChanges: () => boolean;
  /** True when the server refused further saves because the draft is no longer editable. */
  isLocked: () => boolean;
  /** Re-reads the server's state (router.refresh). */
  refresh: () => void;
  setMessage: (message: string) => void;
  mounted: MutableRefObject<boolean>;
};

/**
 * After a finalize whose outcome is unknown: save what is left, then re-read the page. A refresh that
 * cannot reach the server becomes a full browser reload (and a "Leave site?" prompt), so it only runs
 * when the browser is online and either nothing is left unsaved or the draft is locked (a lost-answer
 * finalize did commit, and a locked draft cannot take the edits anyway). While the browser is offline
 * the check waits for the next `online` event (the listener is removed on unmount). Online but unable
 * to read the outcome, it says so and does not promise a re-check that will not come.
 */
export function useOutcomeRecheck(deps: Deps): () => Promise<void> {
  // Incremented every time the check is armed, so arming again always re-adds the one-shot listener.
  const [armed, setArmed] = useState(0);

  async function recheck(): Promise<void> {
    await deps.flush();
    if (!deps.mounted.current) return;
    const online = navigator.onLine !== false;
    if (online && (!deps.hasUnsavedChanges() || deps.isLocked())) {
      deps.setMessage(COULD_NOT_CONFIRM_MESSAGE);
      deps.refresh();
      return;
    }
    if (online) {
      deps.setMessage(COULD_NOT_CONFIRM_RELOAD_MESSAGE);
      return;
    }
    deps.setMessage(CHECK_LATER_MESSAGE);
    setArmed((n) => n + 1);
  }

  const latest = useRef(recheck);
  useEffect(() => {
    latest.current = recheck;
  });
  useEffect(() => {
    if (armed === 0) return;
    const onOnline = () => {
      void latest.current();
    };
    window.addEventListener("online", onOnline, { once: true });
    return () => window.removeEventListener("online", onOnline);
  }, [armed]);

  return recheck;
}

export type SaveOutcome =
  | { kind: "saved"; revision: number; savedAt: string }
  | { kind: "conflict"; currentRevision: number; message: string }
  | { kind: "invalid"; message: string; field?: string }
  | { kind: "locked"; message: string };

export type AutosaveStatus =
  | { state: "saved"; savedAt: string | null }
  | { state: "pending" }
  | { state: "saving" }
  | { state: "retrying"; message: string; retryInMs: number }
  | { state: "invalid"; message: string; field?: string }
  | { state: "conflict"; message: string; currentRevision: number }
  | { state: "locked"; message: string };

type HaltStatus = Extract<AutosaveStatus, { state: "invalid" | "conflict" | "locked" }>;

/** Thrown by a save function for failures that should be retried (for example a signed-out session). */
export class RetryableSaveError extends Error {}

export const OFFLINE_MESSAGE =
  "Not saved yet: no connection. Your changes are kept on this page and will be retried.";
export const SIGNED_OUT_MESSAGE = "You were signed out. Sign in again in another tab; saving will resume.";

export type AutosaverOptions<T> = {
  initial: T;
  initialRevision: number;
  /** Resolves with the server's answer; rejects (throws) on network failure. */
  save: (snapshot: T, baseRevision: number) => Promise<SaveOutcome>;
  onStatus: (status: AutosaveStatus) => void;
  debounceMs?: number;
  maxWaitMs?: number;
  maxRetryMs?: number;
};

export type Autosaver<T> = {
  update(snapshot: T): void;
  flush(): Promise<void>;
  retryNow(): void;
  /** After a conflict: save the local copy over the newer server version (an explicit user choice). */
  overwrite(): void;
  /** Runs fn with the latest snapshot while automatic saving is paused (finalize uses this). */
  exclusive<R>(fn: (snapshot: T, baseRevision: number) => Promise<{ revision: number | null; savedAt?: string; value: R }>): Promise<R>;
  hasUnsavedChanges(): boolean;
  dispose(): void;
};

/**
 * Debounced, strictly sequential autosave of full snapshots with optimistic revisions.
 * Invariants: at most one save in flight; every save is based on the revision returned by
 * the previous successful save; an edit is never reported as saved until a save that
 * included it succeeded; failures never discard the latest snapshot.
 */
export function createAutosaver<T>(options: AutosaverOptions<T>): Autosaver<T> {
  const debounceMs = options.debounceMs ?? 800;
  const maxWaitMs = options.maxWaitMs ?? 5_000;
  const maxRetryMs = options.maxRetryMs ?? 30_000;

  let latest = options.initial;
  let revision = options.initialRevision;
  let editSeq = 0;
  let savedSeq = 0;
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirtySince: number | null = null;
  let retryMs = 0;
  let halt: HaltStatus | null = null;
  let paused = 0;
  let disposed = false;

  const emit = (status: AutosaveStatus) => {
    if (!disposed) options.onStatus(status);
  };
  const unsaved = () => savedSeq !== editSeq;
  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const schedule = (delayMs: number) => {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void attempt();
    }, delayMs);
  };
  const debounceDelay = () => {
    const waited = dirtySince === null ? 0 : Date.now() - dirtySince;
    return Math.max(0, Math.min(debounceMs, maxWaitMs - waited));
  };

  function update(snapshot: T): void {
    if (disposed) return;
    latest = snapshot;
    editSeq += 1;
    if (halt?.state === "invalid") halt = null; // the new edit may fix the problem
    if (halt) return; // conflict or locked: keep the edit locally, never save it automatically
    if (dirtySince === null) dirtySince = Date.now();
    if (retryMs > 0) return; // keep showing "retrying"; the retry sends the latest snapshot
    emit({ state: "pending" });
    if (inFlight !== null || paused > 0) return; // re-checked when the current save finishes
    schedule(debounceDelay());
  }

  function apply(outcome: SaveOutcome, seq: number): void {
    switch (outcome.kind) {
      case "saved":
        revision = outcome.revision;
        savedSeq = seq;
        emit(unsaved() ? { state: "pending" } : { state: "saved", savedAt: outcome.savedAt });
        return;
      case "invalid":
        if (seq !== editSeq) {
          emit({ state: "pending" }); // a newer snapshot is waiting and may be fine
          return;
        }
        halt = outcome.field
          ? { state: "invalid", message: outcome.message, field: outcome.field }
          : { state: "invalid", message: outcome.message };
        emit(halt);
        return;
      case "conflict":
        halt = { state: "conflict", message: outcome.message, currentRevision: outcome.currentRevision };
        emit(halt);
        return;
      case "locked":
        halt = { state: "locked", message: outcome.message };
        emit(halt);
        return;
    }
  }

  async function send(snapshot: T, seq: number): Promise<void> {
    try {
      const outcome = await options.save(snapshot, revision);
      retryMs = 0;
      apply(outcome, seq);
    } catch (error) {
      retryMs = retryMs === 0 ? 1_000 : Math.min(retryMs * 2, maxRetryMs);
      const message = error instanceof RetryableSaveError && error.message ? error.message : OFFLINE_MESSAGE;
      emit({ state: "retrying", message, retryInMs: retryMs });
    }
  }

  async function attempt(): Promise<void> {
    if (disposed || halt || paused > 0 || inFlight !== null || !unsaved()) return;
    clearTimer();
    const snapshot = latest;
    const seq = editSeq;
    dirtySince = null;
    emit({ state: "saving" });
    const run = send(snapshot, seq);
    inFlight = run;
    try {
      await run;
    } finally {
      inFlight = null;
    }
    if (disposed || halt || paused > 0) return;
    if (retryMs > 0) schedule(retryMs);
    else if (unsaved()) schedule(debounceDelay());
  }

  async function flush(): Promise<void> {
    for (let round = 0; round < 5; round += 1) {
      if (inFlight !== null) await inFlight;
      if (disposed || halt || paused > 0 || !unsaved()) return;
      retryMs = 0;
      await attempt();
      if (retryMs > 0) return; // still failing; the status already says so
    }
  }

  function retryNow(): void {
    if (disposed || halt || paused > 0 || inFlight !== null || !unsaved()) return;
    retryMs = 0;
    void attempt();
  }

  function overwrite(): void {
    if (disposed || halt?.state !== "conflict") return;
    revision = halt.currentRevision;
    halt = null;
    savedSeq = -1; // force a save of the local copy even if nothing changed since the conflict
    void attempt();
  }

  async function exclusive<R>(
    fn: (snapshot: T, baseRevision: number) => Promise<{ revision: number | null; savedAt?: string; value: R }>,
  ): Promise<R> {
    paused += 1;
    clearTimer();
    try {
      if (inFlight !== null) await inFlight;
      const seq = editSeq;
      const result = await fn(latest, revision);
      if (result.revision !== null) {
        revision = result.revision;
        savedSeq = seq;
        retryMs = 0;
        halt = null;
        emit(unsaved() ? { state: "pending" } : { state: "saved", savedAt: result.savedAt ?? new Date().toISOString() });
      }
      return result.value;
    } finally {
      paused -= 1;
      if (!disposed && paused === 0 && !halt && unsaved()) schedule(retryMs > 0 ? retryMs : debounceDelay());
    }
  }

  return {
    update,
    flush,
    retryNow,
    overwrite,
    exclusive,
    hasUnsavedChanges: () => !disposed && (unsaved() || inFlight !== null),
    dispose: () => {
      disposed = true;
      clearTimer();
    },
  };
}

/** Matches Task 7's AutosaveResponse without importing server code. */
export type SaveResponseLike =
  | { ok: true; revision: number; savedAt: string }
  | { ok: false; code: string; message: string; field?: string; currentRevision?: number };

export function outcomeFromResponse(res: SaveResponseLike): SaveOutcome {
  if (res.ok) return { kind: "saved", revision: res.revision, savedAt: res.savedAt };
  if (res.code === "unauthenticated") throw new RetryableSaveError(SIGNED_OUT_MESSAGE);
  if (res.code === "conflict" && typeof res.currentRevision === "number") {
    return { kind: "conflict", currentRevision: res.currentRevision, message: res.message };
  }
  if (res.code === "invalid") {
    return res.field ? { kind: "invalid", message: res.message, field: res.field } : { kind: "invalid", message: res.message };
  }
  // immutable, forbidden, not_found, or a conflict without a revision (already finalized).
  return { kind: "locked", message: res.message };
}

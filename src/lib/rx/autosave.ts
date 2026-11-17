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

/** Internal: a save that did not settle within `saveTimeoutMs`. Treated as a retryable, ambiguous failure. */
class SaveTimeoutError extends Error {}

export const OFFLINE_MESSAGE =
  "Not saved yet: no connection. Your changes are kept on this page and will be retried.";
export const TIMEOUT_MESSAGE =
  "Not saved yet: the server did not answer. Your changes are kept on this page and will be retried.";
export const SIGNED_OUT_MESSAGE = "You were signed out. Sign in again in another tab; saving will resume.";
/** Shown instead of the server's conflict text when a conflict follows a timeout or network error. */
export const AMBIGUOUS_CONFLICT_MESSAGE =
  "Your last save may have gone through. Keep your version or load the saved one.";

export type AutosaverOptions<T> = {
  initial: T;
  initialRevision: number;
  /** Resolves with the server's answer; rejects (throws) on network failure. */
  save: (snapshot: T, baseRevision: number) => Promise<SaveOutcome>;
  onStatus: (status: AutosaveStatus) => void;
  debounceMs?: number;
  maxWaitMs?: number;
  maxRetryMs?: number;
  /** A save that has not settled after this long counts as a retryable failure (default 30 000 ms). */
  saveTimeoutMs?: number;
};

export type Autosaver<T> = {
  /** Records the latest snapshot. Snapshots must be treated as immutable after this call. */
  update(snapshot: T): void;
  /**
   * Waits for the in-flight save and then saves what is left. It can resolve while changes are
   * still unsaved: when the engine is halted (conflict, locked, invalid), held, retrying after a
   * failure, paused by `exclusive`, or after its 5-round cap. Check `hasUnsavedChanges()`.
   */
  flush(): Promise<void>;
  retryNow(): void;
  /** After a conflict: save the local copy over the newer server version (an explicit user choice). */
  overwrite(): void;
  /**
   * Runs fn with the latest snapshot while automatic saving is paused (finalize uses this). Only one
   * exclusive call may run at a time: a second call rejects with an Error ("already running").
   * If fn returns `revision: null` nothing is marked saved and automatic saving stays held (no timer
   * fires, new edits are only recorded) until the caller resumes it with `retryNow()`, `flush()` or
   * `overwrite()`.
   */
  exclusive<R>(fn: (snapshot: T, baseRevision: number) => Promise<{ revision: number | null; savedAt?: string; value: R }>): Promise<R>;
  hasUnsavedChanges(): boolean;
  /**
   * Teardown that keeps edits safe: stops timers, never emits a status again, and, unless halted
   * (conflict, locked, invalid) or held, sends ONE final best-effort save of the latest snapshot
   * (after the in-flight save if there is one). Its outcome is ignored. `hasUnsavedChanges()` stays
   * truthful until that save settles.
   */
  dispose(): void;
  /** Teardown that drops everything: nothing more is sent and nothing counts as unsaved. */
  discard(): void;
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
  const saveTimeoutMs = options.saveTimeoutMs ?? 30_000;

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
  let exclusiveActive = false;
  let held = false; // an exclusive call returned no revision: wait for the caller
  let ambiguous = false; // the last failure may still have committed on the server
  let disposed = false;
  let discarded = false;

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
    if (held || inFlight !== null || paused > 0) return; // re-checked when the current save finishes
    schedule(debounceDelay());
  }

  function apply(outcome: SaveOutcome, seq: number, doubt: boolean): void {
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
        halt = {
          state: "conflict",
          message: doubt ? AMBIGUOUS_CONFLICT_MESSAGE : outcome.message,
          currentRevision: outcome.currentRevision,
        };
        emit(halt);
        return;
      case "locked":
        halt = { state: "locked", message: outcome.message };
        emit(halt);
        return;
    }
  }

  /** Runs one save call, failing it if it has not settled in time. A late answer is ignored. */
  function saveWithTimeout(snapshot: T, base: number): Promise<SaveOutcome> {
    return new Promise<SaveOutcome>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new SaveTimeoutError()), saveTimeoutMs);
      let call: Promise<SaveOutcome>;
      try {
        call = options.save(snapshot, base);
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
        return;
      }
      call.then(
        (outcome) => {
          clearTimeout(timeout);
          resolve(outcome);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
  }

  async function send(snapshot: T, seq: number): Promise<void> {
    const doubt = ambiguous;
    try {
      const outcome = await saveWithTimeout(snapshot, revision);
      retryMs = 0;
      ambiguous = false; // the server answered, so we know where we stand
      apply(outcome, seq, doubt);
    } catch (error) {
      retryMs = retryMs === 0 ? 1_000 : Math.min(retryMs * 2, maxRetryMs);
      // A RetryableSaveError is an answer from the server; a timeout or network error is not.
      if (!(error instanceof RetryableSaveError)) ambiguous = true;
      const message =
        error instanceof RetryableSaveError && error.message
          ? error.message
          : error instanceof SaveTimeoutError
            ? TIMEOUT_MESSAGE
            : OFFLINE_MESSAGE;
      emit({ state: "retrying", message, retryInMs: retryMs });
    }
  }

  /** Marks a save in flight BEFORE announcing it, so a status handler that flushes cannot start a second one. */
  async function runSave(announce: boolean): Promise<void> {
    const snapshot = latest;
    const seq = editSeq;
    dirtySince = null;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    inFlight = gate;
    if (announce) emit({ state: "saving" });
    try {
      await send(snapshot, seq);
    } finally {
      if (inFlight === gate) inFlight = null;
      release();
    }
  }

  async function attempt(): Promise<void> {
    if (disposed || halt || paused > 0 || inFlight !== null || !unsaved()) return;
    clearTimer();
    await runSave(true);
    if (disposed || halt || paused > 0 || held) return;
    if (retryMs > 0) schedule(retryMs);
    else if (unsaved()) schedule(debounceDelay());
  }

  async function flush(): Promise<void> {
    held = false;
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
    held = false;
    retryMs = 0;
    void attempt();
  }

  function overwrite(): void {
    if (disposed || halt?.state !== "conflict") return;
    revision = halt.currentRevision;
    halt = null;
    held = false;
    savedSeq = -1; // force a save of the local copy even if nothing changed since the conflict
    void attempt();
  }

  async function exclusive<R>(
    fn: (snapshot: T, baseRevision: number) => Promise<{ revision: number | null; savedAt?: string; value: R }>,
  ): Promise<R> {
    if (exclusiveActive) throw new Error("An exclusive save is already running.");
    exclusiveActive = true;
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
        ambiguous = false;
        halt = null;
        held = false;
        emit(unsaved() ? { state: "pending" } : { state: "saved", savedAt: result.savedAt ?? new Date().toISOString() });
      } else {
        held = true; // do not let autosave fire against a draft that may now be finalized
      }
      return result.value;
    } finally {
      paused -= 1;
      exclusiveActive = false;
      if (!disposed && paused === 0 && !halt && !held && unsaved()) schedule(retryMs > 0 ? retryMs : debounceDelay());
    }
  }

  async function finalSave(): Promise<void> {
    if (inFlight !== null) await inFlight;
    if (discarded || halt || held || paused > 0 || !unsaved()) return;
    await runSave(false);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clearTimer();
    if (halt || held || paused > 0 || !unsaved()) return;
    void finalSave();
  }

  function discard(): void {
    discarded = true;
    disposed = true;
    clearTimer();
  }

  return {
    update,
    flush,
    retryNow,
    overwrite,
    exclusive,
    hasUnsavedChanges: () => !discarded && (unsaved() || inFlight !== null),
    dispose,
    discard,
  };
}

/** Matches Task 7's AutosaveResponse without importing server code. */
export type SaveResponseLike =
  | { ok: true; revision: number; savedAt: string }
  | { ok: false; code: string; message: string; field?: string; currentRevision?: number };

/**
 * Only the codes that can never succeed on a retry stop saving (`locked`, `conflict`, `invalid`).
 * Everything else (`unauthenticated`, `internal`, and any code this client does not know) is
 * retryable: an unknown code must never end saving or count as saved.
 */
export function outcomeFromResponse(res: SaveResponseLike): SaveOutcome {
  if (res.ok) return { kind: "saved", revision: res.revision, savedAt: res.savedAt };
  if (res.code === "unauthenticated") throw new RetryableSaveError(SIGNED_OUT_MESSAGE);
  if (res.code === "conflict") {
    return typeof res.currentRevision === "number"
      ? { kind: "conflict", currentRevision: res.currentRevision, message: res.message }
      : { kind: "locked", message: res.message }; // a conflict without a revision: already finalized
  }
  if (res.code === "invalid") {
    return res.field ? { kind: "invalid", message: res.message, field: res.field } : { kind: "invalid", message: res.message };
  }
  if (res.code === "immutable" || res.code === "forbidden" || res.code === "not_found") {
    return { kind: "locked", message: res.message };
  }
  throw new RetryableSaveError(res.message);
}

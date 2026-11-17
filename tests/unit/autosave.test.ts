import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AMBIGUOUS_CONFLICT_MESSAGE,
  createAutosaver,
  OFFLINE_MESSAGE,
  TIMEOUT_MESSAGE,
  outcomeFromResponse,
  RetryableSaveError,
  SIGNED_OUT_MESSAGE,
  type AutosaveStatus,
  type SaveOutcome,
} from "@/lib/rx/autosave";

type Snap = { text: string };
type Call = { snapshot: Snap; base: number; resolve: (o: SaveOutcome) => void; reject: (e: unknown) => void };

function harness(initialRevision = 0) {
  const calls: Call[] = [];
  const statuses: AutosaveStatus[] = [];
  const saver = createAutosaver<Snap>({
    initial: { text: "" },
    initialRevision,
    save: (snapshot, base) =>
      new Promise<SaveOutcome>((resolve, reject) => {
        calls.push({ snapshot, base, resolve, reject });
      }),
    onStatus: (s) => statuses.push(s),
  });
  return { saver, calls, statuses, last: () => statuses[statuses.length - 1] };
}

const saved = (revision: number): SaveOutcome => ({ kind: "saved", revision, savedAt: `2026-11-12T10:00:0${revision}.000Z` });

/** Lets promise callbacks run (fake timers do not fake microtasks). */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createAutosaver", () => {
  it("waits for a pause in typing, then saves the latest snapshot once", async () => {
    const h = harness();
    h.saver.update({ text: "a" });
    await vi.advanceTimersByTimeAsync(300);
    h.saver.update({ text: "ab" });
    await vi.advanceTimersByTimeAsync(300);
    h.saver.update({ text: "abc" });
    expect(h.last()).toEqual({ state: "pending" });

    await vi.advanceTimersByTimeAsync(799);
    expect(h.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ snapshot: { text: "abc" }, base: 0 });
    expect(h.last()).toEqual({ state: "saving" });
    expect(h.saver.hasUnsavedChanges()).toBe(true);

    h.calls[0].resolve(saved(1));
    await settle();
    expect(h.last()).toEqual({ state: "saved", savedAt: "2026-11-12T10:00:01.000Z" });
    expect(h.saver.hasUnsavedChanges()).toBe(false);
  });

  it("saves at least every 5 seconds during continuous typing", async () => {
    const h = harness();
    for (let i = 0; i < 20; i += 1) {
      h.saver.update({ text: `t${i}` });
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(h.calls.length).toBeGreaterThanOrEqual(1);
    expect(h.calls[0].snapshot.text).toMatch(/^t1[0-9]$|^t[0-9]$/);
  });

  it("never runs two saves at once and sends newer edits next, in order, on the new revision", async () => {
    const h = harness();
    h.saver.update({ text: "one" });
    await vi.advanceTimersByTimeAsync(800);
    expect(h.calls).toHaveLength(1);

    h.saver.update({ text: "two" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls).toHaveLength(1); // still in flight: no overlap

    h.calls[0].resolve(saved(1));
    await settle();
    await vi.advanceTimersByTimeAsync(800);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toMatchObject({ snapshot: { text: "two" }, base: 1 });

    h.calls[1].resolve(saved(2));
    await settle();
    expect(h.last()).toMatchObject({ state: "saved" });
    expect(h.calls.map((c) => [c.snapshot.text, c.base])).toEqual([
      ["one", 0],
      ["two", 1],
    ]);
  });

  it("keeps edits through a network failure, backs off, and saves the latest snapshot when back", async () => {
    const h = harness();
    h.saver.update({ text: "offline 1" });
    await vi.advanceTimersByTimeAsync(800);
    h.calls[0].reject(new TypeError("Failed to fetch"));
    await settle();
    expect(h.last()).toEqual({ state: "retrying", message: OFFLINE_MESSAGE, retryInMs: 1000 });
    expect(h.saver.hasUnsavedChanges()).toBe(true);

    h.saver.update({ text: "offline 2" });
    expect(h.last()).toMatchObject({ state: "retrying" }); // still clearly not saved

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].snapshot).toEqual({ text: "offline 2" });
    h.calls[1].reject(new TypeError("Failed to fetch"));
    await settle();
    expect(h.last()).toMatchObject({ state: "retrying", retryInMs: 2000 });

    await vi.advanceTimersByTimeAsync(1999);
    expect(h.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(3);
    h.calls[2].resolve(saved(1));
    await settle();
    expect(h.last()).toMatchObject({ state: "saved" });
    expect(h.calls.every((c) => c.base === 0)).toBe(true);
  });

  it("caps the retry delay at 30 seconds", async () => {
    const h = harness();
    h.saver.update({ text: "x" });
    await vi.advanceTimersByTimeAsync(800);
    const delays: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      h.calls[i].reject(new TypeError("Failed to fetch"));
      await settle();
      const status = h.last();
      if (status.state !== "retrying") throw new Error("expected retrying");
      delays.push(status.retryInMs);
      await vi.advanceTimersByTimeAsync(status.retryInMs);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it("retries at once when asked (the browser came back online)", async () => {
    const h = harness();
    h.saver.update({ text: "x" });
    await vi.advanceTimersByTimeAsync(800);
    h.calls[0].reject(new TypeError("Failed to fetch"));
    await settle();
    h.saver.retryNow();
    expect(h.calls).toHaveLength(2);
  });

  it("shows the message of a retryable server error", async () => {
    const h = harness();
    h.saver.update({ text: "x" });
    await vi.advanceTimersByTimeAsync(800);
    h.calls[0].reject(new RetryableSaveError("Signed out, retrying"));
    await settle();
    expect(h.last()).toMatchObject({ state: "retrying", message: "Signed out, retrying" });
  });

  it("stops on a conflict, keeps the local copy, and overwrites only when asked", async () => {
    const h = harness();
    h.saver.update({ text: "mine" });
    await vi.advanceTimersByTimeAsync(800);
    h.calls[0].resolve({ kind: "conflict", currentRevision: 7, message: "Changed elsewhere" });
    await settle();
    expect(h.last()).toEqual({ state: "conflict", message: "Changed elsewhere", currentRevision: 7 });

    h.saver.update({ text: "mine 2" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls).toHaveLength(1);
    expect(h.saver.hasUnsavedChanges()).toBe(true);

    h.saver.overwrite();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toMatchObject({ snapshot: { text: "mine 2" }, base: 7 });
  });

  it("waits for the next edit after the server rejects the latest snapshot", async () => {
    const h = harness();
    h.saver.update({ text: "bad" });
    await vi.advanceTimersByTimeAsync(800);
    h.calls[0].resolve({ kind: "invalid", message: "Pulse must be at most 250", field: "vitals" });
    await settle();
    expect(h.last()).toEqual({ state: "invalid", message: "Pulse must be at most 250", field: "vitals" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls).toHaveLength(1);

    h.saver.update({ text: "fixed" });
    await vi.advanceTimersByTimeAsync(800);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].snapshot).toEqual({ text: "fixed" });
  });

  it("keeps going when an older snapshot is rejected but a newer one is waiting", async () => {
    const h = harness();
    h.saver.update({ text: "bad" });
    await vi.advanceTimersByTimeAsync(800);
    h.saver.update({ text: "fixed" });
    h.calls[0].resolve({ kind: "invalid", message: "Bad value" });
    await settle();
    expect(h.last()).toEqual({ state: "pending" });
    await vi.advanceTimersByTimeAsync(800);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].snapshot).toEqual({ text: "fixed" });
  });

  it("stops for good when the prescription is locked", async () => {
    const h = harness();
    h.saver.update({ text: "late" });
    await vi.advanceTimersByTimeAsync(800);
    h.calls[0].resolve({ kind: "locked", message: "Finalized elsewhere" });
    await settle();
    h.saver.update({ text: "later" });
    h.saver.retryNow();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(1);
    expect(h.last()).toEqual({ state: "locked", message: "Finalized elsewhere" });
  });

  it("saves immediately on flush", async () => {
    const h = harness();
    h.saver.update({ text: "now" });
    const flushed = h.saver.flush();
    expect(h.calls).toHaveLength(1);
    h.calls[0].resolve(saved(1));
    await settle();
    await flushed;
    expect(h.last()).toMatchObject({ state: "saved" });
  });

  it("runs finalize exclusively after the in-flight save, with the latest snapshot and revision", async () => {
    const h = harness();
    h.saver.update({ text: "a" });
    await vi.advanceTimersByTimeAsync(800);
    h.saver.update({ text: "b" });

    const fn = vi.fn(async (snapshot: Snap, base: number) => ({ revision: 5, value: `${snapshot.text}@${base}` }));
    const result = h.saver.exclusive(fn);
    await settle();
    expect(fn).not.toHaveBeenCalled();

    h.calls[0].resolve(saved(1));
    await settle();
    expect(await result).toBe("b@1");
    expect(h.calls).toHaveLength(1); // "b" went with the exclusive call, not a separate autosave
    expect(h.last()).toMatchObject({ state: "saved" });
    expect(h.saver.hasUnsavedChanges()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls).toHaveLength(1);
  });

  it("discard drops everything: nothing is sent and nothing is unsaved", async () => {
    const h = harness();
    h.saver.update({ text: "x" });
    h.saver.discard();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls).toHaveLength(0);
    expect(h.saver.hasUnsavedChanges()).toBe(false);
  });

  it("discard also stops a pending retry", async () => {
    const h = harness();
    h.saver.update({ text: "x" });
    await vi.advanceTimersByTimeAsync(800);
    h.calls[0].reject(new TypeError("Failed to fetch"));
    await settle();
    const count = h.statuses.length;
    h.saver.discard();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(1);
    expect(h.statuses).toHaveLength(count);
    expect(h.saver.hasUnsavedChanges()).toBe(false);
  });
});

describe("dispose keeps edits safe", () => {
  it("sends one final save of the latest snapshot when disposed inside the debounce window", async () => {
    const h = harness();
    h.saver.update({ text: "typed" });
    await vi.advanceTimersByTimeAsync(300);
    const count = h.statuses.length;
    h.saver.dispose();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ snapshot: { text: "typed" }, base: 0 });
    expect(h.saver.hasUnsavedChanges()).toBe(true); // truthful until the final save settles

    h.calls[0].resolve(saved(1));
    await settle();
    expect(h.saver.hasUnsavedChanges()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(1);
    expect(h.statuses).toHaveLength(count); // no status after dispose (no setState after unmount)
  });

  it("sends the newer snapshot once after the in-flight save, on its revision", async () => {
    const h = harness();
    h.saver.update({ text: "one" });
    await vi.advanceTimersByTimeAsync(800);
    h.saver.update({ text: "two" });
    h.saver.dispose();
    expect(h.calls).toHaveLength(1); // the in-flight save is not overlapped

    h.calls[0].resolve(saved(1));
    await settle();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toMatchObject({ snapshot: { text: "two" }, base: 1 });
    h.calls[1].resolve(saved(2));
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(2);
    expect(h.saver.hasUnsavedChanges()).toBe(false);
  });

  it("sends nothing extra when the in-flight save already covers every edit", async () => {
    const h = harness();
    h.saver.update({ text: "one" });
    await vi.advanceTimersByTimeAsync(800);
    h.saver.dispose();
    h.calls[0].resolve(saved(1));
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(1);
    expect(h.saver.hasUnsavedChanges()).toBe(false);
  });

  it("makes a last attempt when disposed while offline, and then stops retrying", async () => {
    const h = harness();
    h.saver.update({ text: "offline" });
    await vi.advanceTimersByTimeAsync(800);
    h.calls[0].reject(new TypeError("Failed to fetch"));
    await settle();
    h.saver.update({ text: "offline 2" });
    h.saver.dispose();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].snapshot).toEqual({ text: "offline 2" });
    h.calls[1].reject(new TypeError("Failed to fetch"));
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.calls).toHaveLength(2);
    expect(h.saver.hasUnsavedChanges()).toBe(true); // still truthful: it was never saved
  });

  it("sends nothing when disposed while conflicted, locked or invalid", async () => {
    const outcomes: SaveOutcome[] = [
      { kind: "conflict", currentRevision: 3, message: "m" },
      { kind: "locked", message: "m" },
      { kind: "invalid", message: "m" },
    ];
    for (const outcome of outcomes) {
      const h = harness();
      h.saver.update({ text: "a" });
      await vi.advanceTimersByTimeAsync(800);
      h.calls[0].resolve(outcome);
      await settle();
      if (outcome.kind !== "invalid") h.saver.update({ text: "b" }); // an edit after invalid would clear the halt
      h.saver.dispose();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.calls).toHaveLength(1);
    }
  });

  it("does nothing when nothing is unsaved", async () => {
    const h = harness();
    h.saver.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(0);
    expect(h.statuses).toHaveLength(0);
  });
});

describe("save timeout", () => {
  it("treats a save that never settles as a retryable failure after 30 seconds", async () => {
    const h = harness();
    h.saver.update({ text: "x" });
    await vi.advanceTimersByTimeAsync(800);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.last()).toEqual({ state: "saving" });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.last()).toEqual({ state: "retrying", message: TIMEOUT_MESSAGE, retryInMs: 1000 });
    expect(h.saver.hasUnsavedChanges()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].snapshot).toEqual({ text: "x" });
  });

  it("lets flush wait for the timed-out attempt, retry once, and resolve when that settles", async () => {
    const h = harness();
    h.saver.update({ text: "x" });
    await vi.advanceTimersByTimeAsync(800);
    let done = false;
    const flushed = h.saver.flush().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(done).toBe(false); // retried at once; waiting for that attempt
    expect(h.calls).toHaveLength(2);
    h.calls[1].resolve(saved(1));
    await flushed;
    expect(done).toBe(true);
    expect(h.last()).toMatchObject({ state: "saved" });
  });

  it("resolves flush when the retry also times out, instead of hanging", async () => {
    const h = harness();
    h.saver.update({ text: "x" });
    const flushed = h.saver.flush();
    await vi.advanceTimersByTimeAsync(30_000);
    await flushed;
    expect(h.last()).toMatchObject({ state: "retrying" });
  });

  it("ignores a late success of a timed-out attempt", async () => {
    const h = harness();
    h.saver.update({ text: "x" });
    await vi.advanceTimersByTimeAsync(800);
    await vi.advanceTimersByTimeAsync(30_000); // attempt 0 times out; retry timer pending
    await vi.advanceTimersByTimeAsync(1000); // attempt 1 starts
    expect(h.calls).toHaveLength(2);
    h.calls[0].resolve(saved(9)); // the first request finally answers
    await settle();
    expect(h.last()).toEqual({ state: "saving" });
    h.calls[1].resolve(saved(1));
    await settle();
    expect(h.last()).toEqual({ state: "saved", savedAt: "2026-11-12T10:00:01.000Z" });
    h.saver.update({ text: "y" });
    await vi.advanceTimersByTimeAsync(800);
    expect(h.calls[2]).toMatchObject({ snapshot: { text: "y" }, base: 1 });
  });

  it("says the last save may have gone through when a conflict follows a timeout", async () => {
    const h = harness();
    h.saver.update({ text: "mine" });
    await vi.advanceTimersByTimeAsync(800);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(1000);
    h.calls[1].resolve({ kind: "conflict", currentRevision: 3, message: "Changed in another window" });
    await settle();
    expect(h.last()).toEqual({ state: "conflict", message: AMBIGUOUS_CONFLICT_MESSAGE, currentRevision: 3 });
    h.saver.overwrite();
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]).toMatchObject({ snapshot: { text: "mine" }, base: 3 });
  });

  it("uses the same message when a conflict follows a network error, but not after a clean answer", async () => {
    const h = harness();
    h.saver.update({ text: "a" });
    await vi.advanceTimersByTimeAsync(800);
    h.calls[0].reject(new TypeError("Failed to fetch"));
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    h.calls[1].resolve({ kind: "conflict", currentRevision: 2, message: "Changed in another window" });
    await settle();
    expect(h.last()).toMatchObject({ state: "conflict", message: AMBIGUOUS_CONFLICT_MESSAGE });

    const g = harness();
    g.saver.update({ text: "a" });
    await vi.advanceTimersByTimeAsync(800);
    g.calls[0].reject(new RetryableSaveError("Something went wrong"));
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    g.calls[1].resolve({ kind: "conflict", currentRevision: 2, message: "Changed in another window" });
    await settle();
    expect(g.last()).toMatchObject({ state: "conflict", message: "Changed in another window" });
  });

  it("forgets the doubt after a successful save", async () => {
    const h = harness();
    h.saver.update({ text: "a" });
    await vi.advanceTimersByTimeAsync(800);
    h.calls[0].reject(new TypeError("Failed to fetch"));
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    h.calls[1].resolve(saved(1));
    await settle();
    h.saver.update({ text: "b" });
    await vi.advanceTimersByTimeAsync(800);
    h.calls[2].resolve({ kind: "conflict", currentRevision: 5, message: "Changed in another window" });
    await settle();
    expect(h.last()).toMatchObject({ message: "Changed in another window" });
  });
});

describe("server errors that are not permanent", () => {
  const rejectWith = (call: Call, response: Parameters<typeof outcomeFromResponse>[0]) => {
    try {
      call.resolve(outcomeFromResponse(response));
    } catch (error) {
      call.reject(error);
    }
  };

  it("retries an internal error with the latest snapshot instead of halting", async () => {
    const h = harness();
    h.saver.update({ text: "one" });
    await vi.advanceTimersByTimeAsync(800);
    rejectWith(h.calls[0], { ok: false, code: "internal", message: "Something went wrong. Your changes are kept; trying again." });
    await settle();
    expect(h.last()).toEqual({
      state: "retrying",
      message: "Something went wrong. Your changes are kept; trying again.",
      retryInMs: 1000,
    });
    h.saver.update({ text: "two" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toMatchObject({ snapshot: { text: "two" }, base: 0 });
    h.calls[1].resolve(saved(1));
    await settle();
    expect(h.last()).toMatchObject({ state: "saved" });
  });

  it("treats an unknown code as retryable, never as locked or saved", async () => {
    const h = harness();
    h.saver.update({ text: "one" });
    await vi.advanceTimersByTimeAsync(800);
    rejectWith(h.calls[0], { ok: false, code: "some_new_code", message: "Hmm" });
    await settle();
    expect(h.last()).toMatchObject({ state: "retrying", message: "Hmm" });
    h.saver.retryNow();
    expect(h.calls).toHaveLength(2);
  });
});

describe("rules pinned by review", () => {
  it("never reports saved while a newer edit is waiting", async () => {
    const h = harness();
    h.saver.update({ text: "one" });
    await vi.advanceTimersByTimeAsync(800);
    h.saver.update({ text: "two" });
    h.calls[0].resolve(saved(1));
    await settle();
    expect(h.statuses.some((s) => s.state === "saved")).toBe(false);
    expect(h.last()).toEqual({ state: "pending" });
  });

  it("keeps edits typed during finalize unsaved when finalize saved an older snapshot", async () => {
    const h = harness();
    h.saver.update({ text: "a" });
    let release!: () => void;
    const done = h.saver.exclusive(
      (snapshot, base) =>
        new Promise<{ revision: number | null; savedAt?: string; value: string }>((r) => {
          release = () => r({ revision: 1, savedAt: "2026-11-12T10:00:01.000Z", value: `${snapshot.text}@${base}` });
        }),
    );
    await settle();
    h.saver.update({ text: "typed during finalize" });
    release();
    expect(await done).toBe("a@0");
    expect(h.saver.hasUnsavedChanges()).toBe(true);
    await vi.advanceTimersByTimeAsync(800);
    expect(h.calls.map((c) => [c.snapshot.text, c.base])).toEqual([["typed during finalize", 1]]);
  });

  it("flush during an in-flight save waits for it, then sends the newer edit on the new revision", async () => {
    const h = harness();
    h.saver.update({ text: "a" });
    await vi.advanceTimersByTimeAsync(800);
    h.saver.update({ text: "b" });
    let done = false;
    const flushed = h.saver.flush().then(() => {
      done = true;
    });
    await settle();
    expect(done).toBe(false);
    h.calls[0].resolve(saved(1));
    await settle();
    expect(h.calls[1]).toMatchObject({ snapshot: { text: "b" }, base: 1 });
    expect(done).toBe(false);
    h.calls[1].resolve(saved(2));
    await flushed;
    expect(h.last()).toMatchObject({ state: "saved" });
  });

  it("flush does nothing while conflicted", async () => {
    const h = harness();
    h.saver.update({ text: "mine" });
    await vi.advanceTimersByTimeAsync(800);
    h.calls[0].resolve({ kind: "conflict", currentRevision: 7, message: "m" });
    await settle();
    h.saver.update({ text: "mine 2" });
    await h.saver.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.last()).toMatchObject({ state: "conflict" });
  });

  it("restarts the backoff at 1 s after a success and after retryNow", async () => {
    const h = harness();
    h.saver.update({ text: "x" });
    await vi.advanceTimersByTimeAsync(800);
    h.calls[0].reject(new TypeError("Failed to fetch"));
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    h.calls[1].reject(new TypeError("Failed to fetch"));
    await settle();
    h.saver.retryNow();
    h.calls[2].reject(new TypeError("Failed to fetch"));
    await settle();
    expect(h.last()).toMatchObject({ state: "retrying", retryInMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    h.calls[3].resolve(saved(1));
    await settle();
    h.saver.update({ text: "y" });
    await vi.advanceTimersByTimeAsync(800);
    h.calls[4].reject(new TypeError("Failed to fetch"));
    await settle();
    expect(h.last()).toMatchObject({ state: "retrying", retryInMs: 1000 });
  });

  it("marks a save in flight before announcing it, so a status handler that flushes cannot start a second save", async () => {
    const calls: Call[] = [];
    const ref: { saver?: ReturnType<typeof createAutosaver<Snap>> } = {};
    const saver = createAutosaver<Snap>({
      initial: { text: "" },
      initialRevision: 0,
      save: (snapshot, base) =>
        new Promise<SaveOutcome>((resolve, reject) => {
          calls.push({ snapshot, base, resolve, reject });
        }),
      onStatus: (s) => {
        if (s.state === "saving") void ref.saver?.flush();
      },
    });
    ref.saver = saver;
    saver.update({ text: "x" });
    await vi.advanceTimersByTimeAsync(800);
    expect(calls).toHaveLength(1);
    calls[0].resolve(saved(1));
    await settle();
    expect(calls).toHaveLength(1);
  });

  it("allows only one exclusive callback at a time (the second call rejects)", async () => {
    const h = harness();
    let release!: () => void;
    const fn = vi.fn(
      () =>
        new Promise<{ revision: number | null; value: string }>((r) => {
          release = () => r({ revision: 1, value: "first" });
        }),
    );
    const first = h.saver.exclusive(fn);
    await settle();
    await expect(h.saver.exclusive(async () => ({ revision: 2, value: "second" }))).rejects.toThrow(/already running/);
    release();
    expect(await first).toBe("first");
    expect(fn).toHaveBeenCalledTimes(1);
    // and the lock is released afterwards
    await expect(h.saver.exclusive(async () => ({ revision: 2, value: "third" }))).resolves.toBe("third");
  });

  it("keeps autosave quiet after an exclusive call that returned no revision, until the caller resumes it", async () => {
    const h = harness();
    h.saver.update({ text: "a" });
    await vi.advanceTimersByTimeAsync(300);
    await h.saver.exclusive(async () => ({ revision: null, value: "finalize failed or unknown" }));
    h.saver.update({ text: "b" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(0);
    expect(h.saver.hasUnsavedChanges()).toBe(true);

    h.saver.retryNow(); // the caller decides to carry on
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ snapshot: { text: "b" }, base: 0 });
  });
});

describe("outcomeFromResponse", () => {
  it("maps server responses to outcomes", () => {
    expect(outcomeFromResponse({ ok: true, revision: 3, savedAt: "t" })).toEqual({ kind: "saved", revision: 3, savedAt: "t" });
    expect(outcomeFromResponse({ ok: false, code: "conflict", message: "m", currentRevision: 4 })).toEqual({
      kind: "conflict",
      currentRevision: 4,
      message: "m",
    });
    expect(outcomeFromResponse({ ok: false, code: "conflict", message: "m" })).toEqual({ kind: "locked", message: "m" });
    expect(outcomeFromResponse({ ok: false, code: "invalid", message: "m", field: "vitals" })).toEqual({
      kind: "invalid",
      message: "m",
      field: "vitals",
    });
    expect(outcomeFromResponse({ ok: false, code: "immutable", message: "m" })).toEqual({ kind: "locked", message: "m" });
    expect(outcomeFromResponse({ ok: false, code: "forbidden", message: "m" })).toEqual({ kind: "locked", message: "m" });
  });

  it("treats internal and unknown codes as retryable and keeps not_found permanent", () => {
    expect(() => outcomeFromResponse({ ok: false, code: "internal", message: "Try again" })).toThrow(RetryableSaveError);
    expect(() => outcomeFromResponse({ ok: false, code: "internal", message: "Try again" })).toThrow("Try again");
    expect(() => outcomeFromResponse({ ok: false, code: "brand_new", message: "m" })).toThrow(RetryableSaveError);
    expect(outcomeFromResponse({ ok: false, code: "not_found", message: "m" })).toEqual({ kind: "locked", message: "m" });
  });

  it("treats a signed-out user as retryable", () => {
    expect(() => outcomeFromResponse({ ok: false, code: "unauthenticated", message: "m" })).toThrow(RetryableSaveError);
    expect(() => outcomeFromResponse({ ok: false, code: "unauthenticated", message: "m" })).toThrow(SIGNED_OUT_MESSAGE);
  });
});

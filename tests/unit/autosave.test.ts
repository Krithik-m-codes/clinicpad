import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAutosaver,
  OFFLINE_MESSAGE,
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

  it("does nothing after dispose", async () => {
    const h = harness();
    h.saver.update({ text: "x" });
    h.saver.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls).toHaveLength(0);
    expect(h.saver.hasUnsavedChanges()).toBe(false);
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

  it("treats a signed-out user as retryable", () => {
    expect(() => outcomeFromResponse({ ok: false, code: "unauthenticated", message: "m" })).toThrow(RetryableSaveError);
    expect(() => outcomeFromResponse({ ok: false, code: "unauthenticated", message: "m" })).toThrow(SIGNED_OUT_MESSAGE);
  });
});

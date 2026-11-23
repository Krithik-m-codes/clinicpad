import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rasterizePdfPage } from "@/lib/templates/pdf-frame-client";

const jpeg = () => {
  const bytes = new Uint8Array(32);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes.buffer;
};
const imageReply = () => ({ type: "image", bytes: jpeg(), width: 1654, height: 2339, pageCount: 3, pageSizePt: [595, 842], nonWhitePercent: 9 });

const frame = () => document.querySelector("iframe") as HTMLIFrameElement | null;
const send = (data: unknown, over: { source?: Window | null; origin?: string } = {}) =>
  window.dispatchEvent(new MessageEvent("message", { data, origin: over.origin ?? "null", source: over.source === undefined ? frame()?.contentWindow ?? null : over.source }));

/** Replaces the frame window's postMessage so the render request can be inspected. */
function spyPost() {
  const post = vi.fn();
  (frame()?.contentWindow as unknown as { postMessage: unknown }).postMessage = post;
  return post;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("rasterizePdfPage (parent side of the sandboxed frame)", () => {
  it("creates the frame with sandbox exactly allow-scripts and the frame route as its source", () => {
    void rasterizePdfPage(new ArrayBuffer(8), { page: 1, dpi: 200 });
    const f = frame();
    expect(f?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(f?.getAttribute("src")).toBe("/pdf-frame/frame.html");
    expect(f?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("answers 'ready' with a transferred COPY, so the caller's buffer stays usable for another page", async () => {
    const original = new ArrayBuffer(8);
    const done = rasterizePdfPage(original, { page: 2, dpi: 200 });
    const post = spyPost();
    send({ type: "ready" });
    expect(post).toHaveBeenCalledTimes(1);
    const [message, target, transfer] = post.mock.calls[0] as [{ type: string; bytes: ArrayBuffer; page: number; dpi: number }, string, ArrayBuffer[]];
    expect(message).toMatchObject({ type: "render", page: 2, dpi: 200 });
    expect(message.bytes).not.toBe(original);
    expect(transfer).toEqual([message.bytes]);
    expect(original.byteLength).toBe(8); // not detached
    expect(target).toBe("*"); // an opaque-origin frame can only be addressed with "*"
    send(imageReply());
    const result = await done;
    expect(result).toMatchObject({ ok: true, pageCount: 3, width: 1654 });
    expect(frame()).toBeNull();
  });

  it("ignores messages from another window and from any origin other than the opaque \"null\"", async () => {
    const done = rasterizePdfPage(new ArrayBuffer(8), { page: 1, dpi: 200 });
    const post = spyPost();
    send({ type: "ready" }, { source: window });
    send({ type: "ready" }, { origin: "https://evil.example" });
    send({ type: "ready" }, { origin: window.location.origin });
    send({ type: "ready" }, { source: null });
    expect(post).not.toHaveBeenCalled();
    expect(frame()).not.toBeNull();
    send({ type: "ready" });
    send({ type: "error", code: "encrypted" }, { source: window }); // still ignored
    expect(frame()).not.toBeNull();
    send({ type: "error", code: "encrypted" });
    expect(await done).toEqual({ ok: false, code: "encrypted" });
  });

  it("fails closed on a malformed reply and removes the frame and the listener", async () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const done = rasterizePdfPage(new ArrayBuffer(8), { page: 1, dpi: 200 });
    spyPost();
    send({ type: "ready" });
    send({ type: "image", bytes: "<script>", width: 1 });
    expect(await done).toEqual({ ok: false, code: "unreadable" });
    expect(frame()).toBeNull();
    expect(remove).toHaveBeenCalledWith("message", expect.any(Function));
    remove.mockRestore();
  });

  it("times out, removes the frame and the listener, and ignores a late reply", async () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const done = rasterizePdfPage(new ArrayBuffer(8), { page: 1, dpi: 200, timeoutMs: 1000 });
    const post = spyPost();
    send({ type: "ready" });
    await vi.advanceTimersByTimeAsync(1001);
    expect(await done).toEqual({ ok: false, code: "timeout" });
    expect(frame()).toBeNull();
    expect(remove).toHaveBeenCalledWith("message", expect.any(Function));
    send(imageReply());
    expect(post).toHaveBeenCalledTimes(1);
    remove.mockRestore();
  });

  it("accepts 'ready' once: a second 'ready' does not post the PDF again", () => {
    void rasterizePdfPage(new ArrayBuffer(8), { page: 1, dpi: 200 });
    const post = spyPost();
    send({ type: "ready" });
    send({ type: "ready" });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("treats an image or error that arrives before the render request was sent as unreadable", async () => {
    const early = rasterizePdfPage(new ArrayBuffer(8), { page: 1, dpi: 200 });
    send(imageReply());
    expect(await early).toEqual({ ok: false, code: "unreadable" });
    const earlyError = rasterizePdfPage(new ArrayBuffer(8), { page: 1, dpi: 200 });
    send({ type: "error", code: "encrypted" });
    expect(await earlyError).toEqual({ ok: false, code: "unreadable" });
  });

  it("fails fast when the frame never says 'ready' (blocked or broken frame), well before the render timeout", async () => {
    const done = rasterizePdfPage(new ArrayBuffer(8), { page: 1, dpi: 200, readyTimeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(501);
    expect(await done).toEqual({ ok: false, code: "timeout" });
    expect(frame()).toBeNull();
  });

  it("refuses an empty or oversized PDF without creating a frame", async () => {
    expect(await rasterizePdfPage(new ArrayBuffer(0), { page: 1, dpi: 200 })).toEqual({ ok: false, code: "too_large" });
    expect(await rasterizePdfPage(new ArrayBuffer(10 * 1024 * 1024 + 1), { page: 1, dpi: 200 })).toEqual({ ok: false, code: "too_large" });
    expect(frame()).toBeNull();
  });
});

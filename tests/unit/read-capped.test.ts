// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readCapped } from "@/server/http/read-capped";

function stream(chunks: number, size: number) {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === chunks) return controller.close();
      pulled += 1;
      controller.enqueue(new Uint8Array(size).fill(pulled));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, pulled: () => pulled, cancelled: () => cancelled };
}

describe("readCapped", () => {
  it("returns every byte up to and including the cap", async () => {
    const s = stream(4, 256);
    const out = await readCapped(s.body, 1024);
    expect(out).toBeInstanceOf(ArrayBuffer);
    expect((out as ArrayBuffer).byteLength).toBe(1024);
    expect(new Uint8Array(out as ArrayBuffer)[1023]).toBe(4);
  });

  it("stops reading and cancels the stream once the cap is exceeded", async () => {
    const s = stream(1000, 64 * 1024);
    expect(await readCapped(s.body, 1024 * 1024)).toBe("too_large");
    expect(s.pulled()).toBeLessThan(40);
    expect(s.cancelled()).toBe(true);
  });

  it("reads a missing body as empty", async () => {
    expect(((await readCapped(null, 10)) as ArrayBuffer).byteLength).toBe(0);
  });
});

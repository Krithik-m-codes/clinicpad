import { describe, expect, it } from "vitest";
import { parseFrameReply } from "@/lib/templates/pdf-frame-client";

const jpeg = (n = 16) => {
  const bytes = new Uint8Array(n);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes.buffer;
};
const image = (over: Record<string, unknown> = {}) => ({ type: "image", bytes: jpeg(), width: 1654, height: 2339, pageCount: 1, pageSizePt: [595, 842], nonWhitePercent: 12, ...over });

describe("parseFrameReply (the frame is untrusted)", () => {
  it("accepts the three exact shapes", () => {
    expect(parseFrameReply({ type: "ready" })).toEqual({ type: "ready" });
    expect(parseFrameReply({ type: "error", code: "encrypted" })).toEqual({ type: "error", code: "encrypted" });
    expect(parseFrameReply(image())?.type).toBe("image");
  });

  it("refuses anything else", () => {
    for (const bad of [
      null,
      "ready",
      { type: "ready", extra: 1 },
      { type: "error", code: "<script>" },
      image({ bytes: new Uint8Array(16).buffer }), // not a JPEG
      image({ bytes: new Uint8Array(2).buffer }),
      image({ bytes: new ArrayBuffer(9 * 1024 * 1024) }),
      image({ bytes: "not bytes" }),
      image({ width: 99999 }),
      image({ width: 1.5 }),
      image({ pageCount: 51 }),
      image({ pageSizePt: [0, 842] }),
      image({ pageSizePt: [1e9, 842] }),
      image({ nonWhitePercent: -1 }),
      { ...image(), unexpected: true },
    ]) {
      expect(parseFrameReply(bad)).toBeNull();
    }
  });
});

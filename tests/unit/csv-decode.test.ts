// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DECODE_MESSAGES, decodeCsvBytes } from "@/lib/import/decode";

const utf8 = (text: string) => new TextEncoder().encode(text);
function utf16(text: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    out[2 * i + (littleEndian ? 0 : 1)] = unit & 0xff;
    out[2 * i + (littleEndian ? 1 : 0)] = unit >> 8;
  }
  return out;
}
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const NAME = "आशा देवी";

describe("decodeCsvBytes", () => {
  it("reads UTF-8 with or without a BOM", () => {
    expect(decodeCsvBytes(join(new Uint8Array([0xef, 0xbb, 0xbf]), utf8(`name\n${NAME}`)))).toEqual({ ok: true, text: `name\n${NAME}`, encoding: "utf-8" });
    expect(decodeCsvBytes(utf8(`name\n${NAME}`))).toEqual({ ok: true, text: `name\n${NAME}`, encoding: "utf-8" });
  });

  it("reads Excel's Unicode Text (UTF-16 little-endian with a BOM, tab-separated) and big-endian UTF-16", () => {
    expect(decodeCsvBytes(join(new Uint8Array([0xff, 0xfe]), utf16(`name\tphone\n${NAME}\t1`, true)))).toEqual({
      ok: true,
      text: `name\tphone\n${NAME}\t1`,
      encoding: "utf-16le",
    });
    expect(decodeCsvBytes(join(new Uint8Array([0xfe, 0xff]), utf16(`name\n${NAME}`, false)))).toEqual({ ok: true, text: `name\n${NAME}`, encoding: "utf-16be" });
  });

  it("refuses an Excel workbook, new (.xlsx, a zip) or old (.xls)", () => {
    expect(decodeCsvBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toEqual({ ok: false, message: DECODE_MESSAGES.workbook });
    expect(decodeCsvBytes(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]))).toEqual({ ok: false, message: DECODE_MESSAGES.workbook });
  });

  it("refuses Windows-1252 text instead of garbling names", () => {
    // "José" saved by Excel as ANSI: 0xE9 is not valid UTF-8 on its own.
    expect(decodeCsvBytes(new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x4a, 0x6f, 0x73, 0xe9]))).toEqual({ ok: false, message: DECODE_MESSAGES.notUtf8 });
  });

  it("refuses UTF-16 without a BOM and other binary data", () => {
    expect(decodeCsvBytes(utf16("name\nAsha Rao\n", true))).toEqual({ ok: false, message: DECODE_MESSAGES.unreadable });
    expect(decodeCsvBytes(new Uint8Array(64))).toEqual({ ok: false, message: DECODE_MESSAGES.unreadable });
  });

  it("refuses an empty file", () => {
    expect(decodeCsvBytes(new Uint8Array())).toEqual({ ok: false, message: DECODE_MESSAGES.empty });
  });

  it("refuses a truncated UTF-16 file (odd byte count) and a lone surrogate", () => {
    expect(decodeCsvBytes(join(new Uint8Array([0xff, 0xfe]), utf16("ab", true), new Uint8Array([0x61])))).toEqual({ ok: false, message: DECODE_MESSAGES.unreadable });
    expect(decodeCsvBytes(join(new Uint8Array([0xff, 0xfe]), new Uint8Array([0x00, 0xd8])))).toEqual({ ok: false, message: DECODE_MESSAGES.unreadable });
  });

  it("refuses UTF-8 with a BOM whose body is not UTF-8", () => {
    expect(decodeCsvBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x4a, 0xe9]))).toEqual({ ok: false, message: DECODE_MESSAGES.unreadable });
  });

  it("refuses overlong or surrogate UTF-8 sequences", () => {
    expect(decodeCsvBytes(new Uint8Array([0x61, 0xc0, 0x80]))).toEqual({ ok: false, message: DECODE_MESSAGES.notUtf8 });
    expect(decodeCsvBytes(new Uint8Array([0x61, 0xed, 0xa0, 0x80]))).toEqual({ ok: false, message: DECODE_MESSAGES.notUtf8 });
  });

  it("passes a lone NUL inside otherwise valid text through, for the row check to refuse", () => {
    const result = decodeCsvBytes(utf8(`name\nAs\u0000ha ${"x".repeat(200)}`));
    expect(result.ok && result.text.codePointAt(7)).toBe(0);
  });
});

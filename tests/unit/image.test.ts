import { describe, expect, it } from "vitest";
import { IMAGE_LIMITS, inspectImage } from "@/lib/domain/image";
import { JPEG_SOS, makeJpegCustom, makeJpegHeader, makePng } from "../helpers/images";

const bytes = (b: Buffer) => new Uint8Array(b);

describe("inspectImage", () => {
  it("reads PNG and JPEG dimensions from the bytes", () => {
    expect(inspectImage(bytes(makePng(120, 60)))).toEqual({ ok: true, info: { mime: "image/png", width: 120, height: 60 } });
    expect(inspectImage(bytes(makeJpegHeader(800, 300)))).toEqual({ ok: true, info: { mime: "image/jpeg", width: 800, height: 300 } });
  });

  it.each([
    ["an empty file", Buffer.alloc(0), /empty/],
    ["an SVG with a script", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), /PNG or JPEG/],
    ["a renamed executable", Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]), /PNG or JPEG/],
    ["a GIF", Buffer.from("GIF89a\u0001\u0000\u0001\u0000", "latin1"), /PNG or JPEG/],
    ["a PNG with data after IEND", Buffer.concat([makePng(64, 32), Buffer.from("<script>alert(1)</script>")]), /extra data/],
    ["a truncated PNG", makePng(64, 32).subarray(0, 60), /damaged/],
    ["a PNG wider than 2000 px", makePng(5000, 16), /too large/],
    ["a PNG smaller than 16 px", makePng(8, 8), /too small/],
    ["a JPEG without its end marker", makeJpegHeader(100, 100).subarray(0, 30), /incomplete/],
    ["a JPEG whose scan starts before its frame header", Buffer.concat([Buffer.from([0xff, 0xd8]), JPEG_SOS, Buffer.from([0xff, 0xd9])]), /damaged/],
  ])("rejects %s", (_label, input, message) => {
    const result = inspectImage(bytes(input));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(message);
  });

  it("rejects anything above 512 KB before parsing it", () => {
    const big = Buffer.concat([makePng(64, 32), Buffer.alloc(IMAGE_LIMITS.maxBytes)]);
    const result = inspectImage(bytes(big));
    expect(result).toEqual({ ok: false, message: "The image is larger than 512 KB." });
  });

  it("accepts a file of exactly the size limit but not one byte more", () => {
    const small = makeJpegHeader(100, 100);
    // Pad inside the scan data so the file still ends with EOI.
    const pad = IMAGE_LIMITS.maxBytes - small.length;
    const exact = Buffer.concat([small.subarray(0, small.length - 2), Buffer.alloc(pad, 0x11), Buffer.from([0xff, 0xd9])]);
    expect(exact.length).toBe(IMAGE_LIMITS.maxBytes);
    expect(inspectImage(bytes(exact)).ok).toBe(true);
    const over = Buffer.concat([exact, Buffer.from([0x00])]);
    expect(inspectImage(bytes(over)).ok).toBe(false);
  });

  it("accepts the boundary sizes 16 and 2000 and rejects 15 and 2001", () => {
    expect(inspectImage(bytes(makeJpegHeader(16, 16))).ok).toBe(true);
    expect(inspectImage(bytes(makeJpegHeader(2000, 2000))).ok).toBe(true);
    expect(inspectImage(bytes(makeJpegHeader(15, 100))).ok).toBe(false);
    expect(inspectImage(bytes(makeJpegHeader(100, 15))).ok).toBe(false);
    expect(inspectImage(bytes(makeJpegHeader(2001, 100))).ok).toBe(false);
    expect(inspectImage(bytes(makeJpegHeader(100, 2001))).ok).toBe(false);
  });

  it("rejects a tiny PNG that declares a decompression-bomb size", () => {
    const bomb = makePng(16, 16);
    bomb.writeUInt32BE(0x7fffffff, 16);
    bomb.writeUInt32BE(0x7fffffff, 20);
    const result = inspectImage(bytes(bomb));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/too large/);
  });

  it("rejects a PNG chunk whose length runs past the end of the file", () => {
    const png = makePng(64, 32);
    const lengthOfFirstChunkAfterIhdr = 8 + 12 + 13; // signature + IHDR chunk
    png.writeUInt32BE(0xffffffff, lengthOfFirstChunkAfterIhdr);
    const result = inspectImage(bytes(png));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/damaged/);
  });

  it("rejects a PNG with a non-letter chunk type and a PNG without IEND", () => {
    const png = makePng(64, 32);
    const noIend = png.subarray(0, png.length - 12);
    const result = inspectImage(bytes(noIend));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/damaged/);
    const garbled = Buffer.from(png);
    garbled[8 + 12 + 13 + 4] = 0x00;
    const garbledResult = inspectImage(bytes(garbled));
    expect(garbledResult.ok).toBe(false);
  });

  it("rejects a PNG whose IHDR length is wrong", () => {
    const png = makePng(64, 32);
    png.writeUInt32BE(12, 8);
    const result = inspectImage(bytes(png));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/damaged/);
  });

  it("rejects PNG and JPEG signatures that are too short to hold anything", () => {
    expect(inspectImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).ok).toBe(false);
    expect(inspectImage(new Uint8Array([0xff, 0xd8, 0xff])).ok).toBe(false);
    expect(inspectImage(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])).ok).toBe(false);
  });

  it("rejects a JPEG with a segment length that runs past the end", () => {
    const jpeg = makeJpegHeader(100, 100);
    jpeg[4] = 0xff;
    jpeg[5] = 0xff;
    const result = inspectImage(bytes(jpeg));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/damaged/);
  });

  it("rejects a JPEG with a zero segment length (no infinite loop) and a non-marker byte", () => {
    const zero = makeJpegHeader(100, 100);
    zero[4] = 0x00;
    zero[5] = 0x00;
    expect(inspectImage(bytes(zero)).ok).toBe(false);
    const nonMarker = makeJpegHeader(100, 100);
    nonMarker[2 + 18] = 0x00; // first byte of the SOF0 marker
    expect(inspectImage(bytes(nonMarker)).ok).toBe(false);
  });

  describe("JPEG structure", () => {
    const EOI = Buffer.from([0xff, 0xd9]);
    const refused = (input: Buffer, message?: RegExp) => {
      const result = inspectImage(bytes(input));
      expect(result.ok).toBe(false);
      if (!result.ok && message) expect(result.message).toMatch(message);
    };

    it("accepts a progressive JPEG (SOF2) with several scans", () => {
      const jpeg = makeJpegCustom(640, 480, { progressive: true, scans: [Buffer.from([1, 2, 3]), Buffer.from([4, 5])] });
      expect(inspectImage(bytes(jpeg))).toEqual({ ok: true, info: { mime: "image/jpeg", width: 640, height: 480 } });
    });

    it("accepts stuffed FF00 bytes and RSTn markers inside scan data", () => {
      const scan = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd7, 0xff, 0xff, 0xd3, 0x78]);
      expect(inspectImage(bytes(makeJpegCustom(100, 100, { scans: [scan] }))).ok).toBe(true);
    });

    it("refuses HTML after the real EOI even when the file ends in another FFD9", () => {
      const jpeg = Buffer.concat([makeJpegHeader(100, 100), Buffer.from("<script>alert(1)</script>"), EOI]);
      expect(jpeg.subarray(-2).equals(EOI)).toBe(true);
      refused(jpeg, /extra data/);
    });

    it("refuses a duplicate EOI and trailing junk", () => {
      refused(Buffer.concat([makeJpegHeader(100, 100), EOI]), /extra data/);
      refused(Buffer.concat([makeJpegHeader(100, 100), Buffer.from("junk")]), /incomplete/);
      refused(Buffer.concat([makeJpegHeader(100, 100), Buffer.from([0x00])]), /incomplete/);
    });

    it("refuses a JPEG cut off inside its scan or after its last scan", () => {
      const jpeg = makeJpegCustom(100, 100);
      refused(jpeg.subarray(0, jpeg.length - 2), /incomplete/);
      refused(jpeg.subarray(0, jpeg.length - 4), /incomplete/);
    });

    it("refuses entropy-only markers (FF00, SOI, RSTn) between segments, even when a length follows", () => {
      const valid = makeJpegHeader(100, 100);
      for (const marker of [0x00, 0xd8, 0xd0, 0xd7]) {
        // A plausible two-byte length after the marker would let a lenient parser skip it as a segment.
        const jpeg = Buffer.concat([valid.subarray(0, 20), Buffer.from([0xff, marker, 0x00, 0x02]), valid.subarray(20)]);
        refused(jpeg, /damaged/);
      }
    });

    it("refuses a scan that starts before the frame header, even when a second scan follows it", () => {
      const valid = makeJpegHeader(100, 100);
      const sof = valid.subarray(20, 39);
      expect(sof[1]).toBe(0xc0);
      const scanFirst = Buffer.concat([Buffer.from([0xff, 0xd8]), JPEG_SOS, Buffer.from([0x12]), sof, JPEG_SOS, Buffer.from([0x34]), EOI]);
      refused(scanFirst, /damaged/);
    });

    it("tells the user how to fix extra data without internals", () => {
      const message = "The image has extra data after its end. Save the image as a plain JPEG or PNG and try again.";
      expect(inspectImage(bytes(Buffer.concat([makeJpegHeader(100, 100), EOI])))).toEqual({ ok: false, message });
      expect(inspectImage(bytes(Buffer.concat([makePng(64, 32), Buffer.from("x")])))).toEqual({ ok: false, message });
    });

    it("refuses a second frame header, a missing scan, and a bogus marker inside scan data", () => {
      const sof0 = makeJpegHeader(100, 100).subarray(20, 39);
      expect(sof0[1]).toBe(0xc0);
      const twoFrames = Buffer.concat([makeJpegHeader(100, 100).subarray(0, 39), sof0, JPEG_SOS, EOI]);
      refused(twoFrames, /damaged/);
      const noScan = Buffer.concat([makeJpegHeader(100, 100).subarray(0, 39), EOI]);
      refused(noScan, /damaged/);
      refused(makeJpegCustom(100, 100, { scans: [Buffer.from([0x12, 0xff, 0xe0, 0xff, 0xff])] }), /damaged/);
    });
  });

  it("decides by the bytes, not by any name or declared type", () => {
    // A PNG header followed by HTML is still judged as a PNG and refused.
    const result = inspectImage(bytes(Buffer.concat([makePng(64, 32).subarray(0, 8), Buffer.from("<html><script>x()</script></html>")])));
    expect(result.ok).toBe(false);
  });
});

export type ImageMime = "image/png" | "image/jpeg";
export type ImageInfo = { mime: ImageMime; width: number; height: number };
export type ImageCheck = { ok: true; info: ImageInfo } | { ok: false; message: string };

/** Logos and signatures. maxSide also stops decompression bombs (a tiny file that decodes to gigabytes). */
export const IMAGE_LIMITS = { maxBytes: 512 * 1024, minSide: 16, maxSide: 2000 } as const;

const NOT_AN_IMAGE = "Upload a PNG or JPEG image.";
const DAMAGED = "The image file is damaged. Export it again as a PNG or JPEG.";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const fail = (message: string): ImageCheck => ({ ok: false, message });

function u32(b: Uint8Array, offset: number): number {
  return ((b[offset] << 24) | (b[offset + 1] << 16) | (b[offset + 2] << 8) | b[offset + 3]) >>> 0;
}

function u16(b: Uint8Array, offset: number): number {
  return (b[offset] << 8) | b[offset + 1];
}

function ascii(b: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...b.subarray(offset, offset + length));
}

function withSize(mime: ImageMime, width: number, height: number): ImageCheck {
  const { minSide, maxSide } = IMAGE_LIMITS;
  if (width < minSide || height < minSide) return fail(`The image is too small: use at least ${minSide} × ${minSide} pixels.`);
  if (width > maxSide || height > maxSide) {
    return fail(`The image is too large: use at most ${maxSide} × ${maxSide} pixels. Resize it and try again.`);
  }
  return { ok: true, info: { mime, width, height } };
}

/** Walks every chunk; the file must end exactly at IEND, so nothing can hide after it. */
function inspectPng(b: Uint8Array): ImageCheck {
  if (b.length < 8 + 25 + 12 || u32(b, 8) !== 13 || ascii(b, 12, 4) !== "IHDR") return fail(DAMAGED);
  const width = u32(b, 16);
  const height = u32(b, 20);
  let offset = 8;
  while (offset + 12 <= b.length) {
    const length = u32(b, offset);
    const type = ascii(b, offset + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) return fail(DAMAGED);
    const next = offset + 12 + length;
    if (next > b.length) return fail(DAMAGED);
    if (type === "IEND") {
      if (next !== b.length) return fail("The image has extra data after its end. Save the image as a plain JPEG or PNG and try again.");
      return withSize("image/png", width, height);
    }
    offset = next;
  }
  return fail(DAMAGED);
}

/**
 * Walks the segment structure to the first real EOI: marker segments with lengths, then each
 * scan's entropy-coded data (stuffed FF00 and RSTn skipped) up to the next real marker. The file
 * must end exactly at that EOI, so nothing can hide after it, and it needs one frame and a scan.
 */
function inspectJpeg(b: Uint8Array): ImageCheck {
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return fail("The image file is incomplete. Export it again.");
  let offset = 2;
  let frame: { width: number; height: number } | null = null;
  let scans = 0;
  while (offset + 2 <= b.length) {
    if (b[offset] !== 0xff) return fail(DAMAGED);
    const marker = b[offset + 1];
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (marker === 0xd9) {
      if (!frame || scans === 0) return fail(DAMAGED);
      if (offset + 2 !== b.length) return fail("The image has extra data after its end. Save the image as a plain JPEG or PNG and try again.");
      return withSize("image/jpeg", frame.width, frame.height);
    }
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return fail(DAMAGED);
    if (marker === 0x01) {
      offset += 2; // TEM has no length
      continue;
    }
    if (offset + 4 > b.length) return fail(DAMAGED);
    const length = u16(b, offset + 2);
    if (length < 2 || offset + 2 + length > b.length) return fail(DAMAGED);
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (frame || length < 7) return fail(DAMAGED);
      frame = { width: u16(b, offset + 7), height: u16(b, offset + 5) };
    }
    offset += 2 + length;
    if (marker !== 0xda) continue;
    if (!frame) return fail(DAMAGED); // scan before any frame header
    scans += 1;
    // Entropy-coded data: runs until a marker that is neither FF00 (stuffed) nor RSTn.
    while (offset < b.length) {
      if (b[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const next = b[offset + 1];
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) offset += 2;
      else if (next === 0xff) offset += 1;
      else break;
    }
    if (offset + 2 > b.length) return fail("The image file is incomplete. Export it again.");
  }
  return fail(DAMAGED);
}

/**
 * Identifies an uploaded image from its bytes (never from the file name or declared type)
 * and checks the size limits. Only PNG and JPEG are accepted: SVG can carry scripts and
 * external references, and other formats are not needed for logos or signatures.
 */
export function inspectImage(bytes: Uint8Array): ImageCheck {
  if (bytes.length === 0) return fail("The file is empty.");
  if (bytes.length > IMAGE_LIMITS.maxBytes) return fail(`The image is larger than ${IMAGE_LIMITS.maxBytes / 1024} KB.`);
  if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return inspectPng(bytes);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return inspectJpeg(bytes);
  return fail(NOT_AN_IMAGE);
}

/** PNG chunks kept: what decoding needs plus colour and density hints. Text, EXIF, time and everything unknown is dropped. */
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "pHYs"]);

function stripPng(b: Uint8Array): Uint8Array | null {
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= b.length) {
    const next = offset + 12 + u32(b, offset);
    if (next > b.length) return null;
    if (PNG_KEEP.has(ascii(b, offset + 4, 4))) parts.push(b.subarray(offset, next));
    offset = next;
  }
  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Marker segments that carry no pixels but may carry metadata: APP1..APP15 (EXIF, XMP, ICC, ...), COM; APP0 only as plain JFIF, APP14 only as Adobe. */
function jpegSegmentKept(b: Uint8Array, marker: number, offset: number, length: number): boolean {
  if (marker === 0xfe) return false;
  const payload = offset + 4;
  if (marker === 0xe0) return length >= 7 && ascii(b, payload, 5) === "JFIF\0";
  if (marker === 0xee) return length >= 7 && ascii(b, payload, 5) === "Adobe";
  return !(marker >= 0xe1 && marker <= 0xef);
}

function stripJpeg(b: Uint8Array): Uint8Array | null {
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let offset = 2;
  while (offset + 2 <= b.length) {
    if (b[offset] !== 0xff) return null;
    const marker = b[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd9) {
      parts.push(b.subarray(offset, offset + 2));
      return concat(parts);
    }
    if (marker === 0x01) {
      parts.push(b.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || offset + 4 > b.length) return null;
    const length = u16(b, offset + 2);
    if (length < 2 || offset + 2 + length > b.length) return null;
    const end = offset + 2 + length;
    if (jpegSegmentKept(b, marker, offset, length)) parts.push(b.subarray(offset, end));
    offset = end;
    if (marker !== 0xda) continue;
    // Entropy-coded data is copied as is, up to the next real marker.
    const start = offset;
    while (offset < b.length) {
      if (b[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const next = b[offset + 1];
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) offset += 2;
      else if (next === 0xff) offset += 1;
      else break;
    }
    parts.push(b.subarray(start, offset));
  }
  return null;
}

/**
 * Removes metadata (EXIF/GPS, XMP, comments, text chunks, timestamps) from an image that
 * inspectImage accepted, keeping every byte that is needed to decode it. The caller must store and
 * hash the RETURNED bytes and run inspectImage on them again. Returns null for anything that is
 * not a well-formed PNG or JPEG. Pure: never re-encodes pixels.
 */
export function stripImageMetadata(bytes: Uint8Array): Uint8Array | null {
  if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return stripPng(bytes);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return stripJpeg(bytes);
  return null;
}

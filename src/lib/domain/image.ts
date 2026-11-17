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
      if (next !== b.length) return fail("The image has extra data after its end. Export it again as a plain PNG or JPEG.");
      return withSize("image/png", width, height);
    }
    offset = next;
  }
  return fail(DAMAGED);
}

/** Reads markers up to the first frame header (SOF); the file must end with EOI. */
function inspectJpeg(b: Uint8Array): ImageCheck {
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return fail("The image file is incomplete. Export it again.");
  let offset = 2;
  while (offset + 4 <= b.length) {
    if (b[offset] !== 0xff) return fail(DAMAGED);
    const marker = b[offset + 1];
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2; // markers without a length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return fail(DAMAGED); // end or scan before any frame header
    const length = u16(b, offset + 2);
    if (length < 2 || offset + 2 + length > b.length) return fail(DAMAGED);
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (length < 7) return fail(DAMAGED);
      return withSize("image/jpeg", u16(b, offset + 7), u16(b, offset + 5));
    }
    offset += 2 + length;
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

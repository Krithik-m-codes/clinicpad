import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real, decodable 8-bit RGB PNG filled with one colour. */
export function makePng(width: number, height: number, rgb: [number, number, number] = [30, 64, 175]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const row = Buffer.alloc(1 + width * 3); // filter byte 0, then pixels
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** SOI, APP0 (JFIF), SOF0 with the given size, SOS, a few scan bytes, EOI. Valid markers, not decodable pixels. */
export function makeJpegHeader(width: number, height: number): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof0 = [
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ];
  const sos = [0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof0, ...sos, 0x12, 0x34, 0x56, 0xff, 0xd9]);
}

/** A minimal DHT segment (one table, one symbol). */
const JPEG_DHT = Buffer.from([0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x05]);

/**
 * A structurally valid JPEG with the given entropy-coded scans (bytes after each SOS header),
 * baseline (SOF0) or progressive (SOF2). Stuffed FF00 and RSTn markers may appear in the scans.
 */
export function makeJpegCustom(
  width: number,
  height: number,
  options: { progressive?: boolean; scans?: Buffer[] } = {},
): Buffer {
  const scans = options.scans ?? [Buffer.from([0x12, 0x34, 0x56])];
  const sof = [
    0xff, options.progressive ? 0xc2 : 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ];
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8]), Buffer.from(sof)];
  for (const scan of scans) parts.push(JPEG_DHT, JPEG_SOS, scan);
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/** The scan segment alone, for building malformed JPEGs. */
export const JPEG_SOS = Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]);

/** Inserts extra chunks right after IHDR (text, EXIF, time, ...). */
export function pngWithChunks(png: Buffer, extra: Array<{ type: string; data: Buffer }>): Buffer {
  const afterIhdr = 8 + 12 + 13;
  return Buffer.concat([png.subarray(0, afterIhdr), ...extra.map((c) => chunk(c.type, c.data)), png.subarray(afterIhdr)]);
}

/** A segment with a marker and a payload (the 2-byte length is added). */
export function jpegSegment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
  return Buffer.concat([header, payload]);
}

/** Inserts segments right after SOI (before the JFIF segment). */
export function jpegWithSegments(jpeg: Buffer, segments: Buffer[]): Buffer {
  return Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);
}

/** An APP1 EXIF segment that carries a GPS-looking payload. */
export const JPEG_EXIF_GPS = jpegSegment(0xe1, Buffer.from("Exif\0\0MM\0*GPSLatitude 12.9716 GPSLongitude 77.5946", "latin1"));

/** A letterhead-like PNG (blue header band, green footer band, a light 10 mm grid) for overlay visual tests. */
export function makeLetterheadPng(width: number, height: number, paperHeightMm: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pxPerMm = height / paperHeightMm;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3, 255);
    row[0] = 0;
    const mm = y / pxPerMm;
    const band = mm < 40 ? [30, 64, 175] : mm > paperHeightMm - 15 ? [15, 118, 110] : null;
    for (let x = 0; x < width; x += 1) {
      const grid = Math.floor(x / pxPerMm) % 10 === 0 || Math.floor(mm) % 10 === 0;
      const rgb = band ?? (grid ? [225, 225, 225] : [255, 255, 255]);
      row[1 + x * 3] = rgb[0];
      row[2 + x * 3] = rgb[1];
      row[3 + x * 3] = rgb[2];
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

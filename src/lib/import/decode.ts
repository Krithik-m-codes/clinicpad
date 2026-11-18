export type DecodedCsv = { ok: true; text: string; encoding: "utf-8" | "utf-16le" | "utf-16be" } | { ok: false; message: string };

export const DECODE_MESSAGES = {
  empty: "The file is empty.",
  workbook: "This is an Excel workbook, not a CSV file. In Excel choose File > Save As > CSV UTF-8 (Comma delimited), then upload that file.",
  notUtf8: "This file is not saved as UTF-8, so names would come out garbled. In Excel choose CSV UTF-8 (Comma delimited) when you save, then upload it again.",
  unreadable: "This file could not be read as text. Save it as CSV UTF-8 (Comma delimited) and upload it again.",
} as const;

const fail = (message: string): DecodedCsv => ({ ok: false, message });

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b);
}

const utf8 = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
function utf16le(bytes: Uint8Array): string {
  if (bytes.length % 2 !== 0) throw new Error("odd length");
  return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
}
function swapPairs(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out[i] = bytes[i + 1];
    out[i + 1] = bytes[i];
  }
  if (bytes.length % 2 !== 0) out[bytes.length - 1] = bytes[bytes.length - 1];
  return out;
}

/**
 * Text of an uploaded spreadsheet export. UTF-8 (with or without BOM) and UTF-16 with a BOM (Excel "Unicode Text")
 * are read; workbooks, BOM-less UTF-16 or binary data, and any byte sequence that is not valid UTF-8 (Excel's ANSI
 * "CSV", Windows-1252) are refused with a message that says what to do. Nothing is ever decoded "best effort".
 */
export function decodeCsvBytes(bytes: Uint8Array): DecodedCsv {
  if (bytes.length === 0) return fail(DECODE_MESSAGES.empty);
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return fail(DECODE_MESSAGES.workbook);
  }
  try {
    if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return { ok: true, text: utf8(bytes.subarray(3)), encoding: "utf-8" };
    if (startsWith(bytes, [0xff, 0xfe])) return { ok: true, text: utf16le(bytes.subarray(2)), encoding: "utf-16le" };
    if (startsWith(bytes, [0xfe, 0xff])) return { ok: true, text: utf16le(swapPairs(bytes.subarray(2))), encoding: "utf-16be" };
  } catch {
    return fail(DECODE_MESSAGES.unreadable);
  }
  // Text never has many NUL bytes; UTF-16 without a BOM (or a binary file) does.
  const sample = bytes.subarray(0, 4096);
  let zeros = 0;
  for (const b of sample) if (b === 0) zeros += 1;
  if (zeros * 10 > sample.length) return fail(DECODE_MESSAGES.unreadable);
  try {
    return { ok: true, text: utf8(bytes), encoding: "utf-8" };
  } catch {
    return fail(DECODE_MESSAGES.notUtf8);
  }
}

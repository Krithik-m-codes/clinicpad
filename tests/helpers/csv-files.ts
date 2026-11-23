/** Bytes of an import file as a spreadsheet would save it. */
export const utf8File = (text: string): Uint8Array => new TextEncoder().encode(text);

export const utf8BomFile = (text: string): Uint8Array => {
  const body = utf8File(text);
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
};

/** Excel "Unicode Text": UTF-16 little-endian with a BOM. */
export const utf16LeFile = (text: string): Uint8Array => {
  const out = new Uint8Array(2 + text.length * 2);
  out.set([0xff, 0xfe]);
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    out[2 + 2 * i] = unit & 0xff;
    out[3 + 2 * i] = unit >> 8;
  }
  return out;
};

export const csv = (lines: string[]): string => `${lines.join("\r\n")}\r\n`;

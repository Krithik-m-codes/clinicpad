function isControl(code: number): boolean {
  // C0 controls except tab (0x09) and line feed (0x0a), plus DEL. Postgres rejects NUL in text.
  return (code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f;
}

/**
 * Normalizes user-entered text: Unicode NFC (so Devanagari typed on different keyboards
 * compares equal), CR and CRLF to LF, control characters removed. It does not trim and
 * does not touch HTML: text is stored as plain text and escaped when rendered.
 *
 * It removes NUL too, which keeps search terms and catalogue keys safe. Stored clinical
 * text does not rely on that: the validation layer (`cleanInput` in
 * src/server/validation/text.ts) leaves a NUL-containing string unchanged so that
 * `hasNoNul` refuses it, because a NUL is reported, never silently dropped (Plan 1A rule).
 */
export function cleanText(value: string): string {
  const normalized = value.normalize("NFC").replace(/\r\n?/g, "\n");
  let out = "";
  for (let i = 0; i < normalized.length; i += 1) {
    if (!isControl(normalized.charCodeAt(i))) out += normalized[i];
  }
  return out;
}

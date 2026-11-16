function isControl(code: number): boolean {
  // C0 controls except tab (0x09) and line feed (0x0a), plus DEL. Postgres rejects NUL in text.
  return (code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f;
}

/**
 * Invisible characters that never belong in a name or a note and only cause harm: they split
 * catalogue de-duplication ("Dolo<ZWSP> 650" is not "Dolo 650"), hide in searches, and the
 * bidi controls can visually reorder a printed prescription.
 *
 * Removed: zero-width space (200B), soft hyphen (00AD), BOM / zero-width no-break space
 * (FEFF), word joiner (2060), bidi embeddings and overrides (202A-202E), bidi isolates
 * (2066-2069), and C1 controls (0080-009F; 0085 is handled as a line break before this runs).
 *
 * Deliberately kept: ZWJ (200D) and ZWNJ (200C). Devanagari conjuncts need them.
 */
function isInvisible(code: number): boolean {
  return (
    code === 0x200b ||
    code === 0x00ad ||
    code === 0xfeff ||
    code === 0x2060 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    (code >= 0x0080 && code <= 0x009f)
  );
}

/**
 * Normalizes user-entered text: Unicode NFC (so Devanagari typed on different keyboards
 * compares equal), NEL, line and paragraph separators, CR and CRLF to LF, control characters
 * and invisible format characters removed. It does not trim and does not touch HTML: text
 * is stored as plain text and escaped when rendered.
 *
 * It removes NUL too, which keeps search terms and catalogue keys safe. Stored clinical
 * text does not rely on that: the validation layer (`cleanInput` in
 * src/server/validation/text.ts) leaves a NUL-containing string unchanged so that
 * `hasNoNul` refuses it, because a NUL is reported, never silently dropped (Plan 1A rule).
 */
export function cleanText(value: string): string {
  const normalized = value
    .normalize("NFC")
    .replace(/[\u0085\u2028\u2029]/g, "\n")
    .replace(/\r\n?/g, "\n");
  let out = "";
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    if (!isControl(code) && !isInvisible(code)) out += normalized[i];
  }
  return out;
}

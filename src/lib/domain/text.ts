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
 * (2066-2069), direction marks (200E, 200F, 061C), invisible math operators (2061-2064),
 * Mongolian vowel separator (180E), the Unicode tag block (E0000-E007F), and C1 controls (0080-009F; 0085 is handled as a line break before this runs).
 *
 * Deliberately kept: ZWJ (200D) and ZWNJ (200C). Devanagari conjuncts need them.
 */
function isInvisible(code: number): boolean {
  return (
    code === 0x200b ||
    code === 0x00ad ||
    code === 0xfeff ||
    code === 0x2060 ||
    code === 0x200e || // left-to-right mark
    code === 0x200f || // right-to-left mark
    code === 0x061c || // Arabic letter mark
    (code >= 0x2061 && code <= 0x2064) || // invisible function application, times, separator, plus
    code === 0x180e || // Mongolian vowel separator
    (code >= 0xe0000 && code <= 0xe007f) || // Unicode tag characters (astral)
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    (code >= 0x0080 && code <= 0x009f)
  );
}

/**
 * Normalizes user-entered text: Unicode NFC (so Devanagari typed on different keyboards
 * compares equal), NEL, line and paragraph separators, CR and CRLF to LF, control characters
 * and invisible format characters and unpaired surrogates removed. It does not trim and does not touch HTML: text
 * is stored as plain text and escaped when rendered.
 *
 * It removes NUL too, which keeps search terms and catalogue keys safe. Stored clinical
 * text does not rely on that: the validation layer (`cleanInput` in
 * src/server/validation/text.ts) leaves a NUL-containing string unchanged so that
 * `hasNoNul` refuses it, because a NUL is reported, never silently dropped (Plan 1A rule).
 */
export function cleanText(value: string): string {
  const normalized = value
    // Unpaired UTF-16 surrogates cannot be stored (jsonb refuses them, text columns turn them into
    // U+FFFD); with the `u` flag a valid pair is one astral character and is not matched.
    .replace(/\p{Cs}/gu, "")
    .normalize("NFC")
    .replace(/[\u0085\u2028\u2029]/g, "\n")
    .replace(/\r\n?/g, "\n");
  let out = "";
  // Iterate by code point so astral characters (tag characters, emoji) are judged whole.
  for (const char of normalized) {
    const code = char.codePointAt(0) ?? 0;
    if (!isControl(code) && !isInvisible(code)) out += char;
  }
  return out;
}

const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "dr", "master", "baby", "shri", "smt", "sri"]);

/** Comparison key for a person's name: case, spacing, punctuation and honorifics ignored. */
export function nameKey(name: string): string {
  const cleaned = name
    .normalize("NFC")
    .toLowerCase()
    // Invisible joiners and soft hyphens must not split a word.
    .replace(/\p{Cf}/gu, "")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = cleaned.split(" ");
  // Drop one leading honorific, but never reduce a name to nothing.
  if (parts.length > 1 && HONORIFICS.has(parts[0])) parts.shift();
  return parts.join(" ");
}

/** True only when both names have a non-empty key and the keys match. */
export function sameName(a: string, b: string): boolean {
  const keyA = nameKey(a);
  return keyA !== "" && keyA === nameKey(b);
}

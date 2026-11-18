import { cleanText } from "./text";

/** Escapes LIKE wildcards so user input matches literally (Postgres' default escape is "\"). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Key used to de-duplicate catalogue names: case and spacing are ignored, punctuation is
 * kept ("CTD T 12.5/20" and "CTD T 125/20" are different medicines).
 */
export function catalogueKey(name: string): string {
  return cleanText(name).toLowerCase().replace(/\s+/g, " ").trim();
}

/** A search term from untrusted input: cleaned, whitespace collapsed, at most `max` characters. */
export function searchTerm(raw: unknown, max = 60): string {
  if (typeof raw !== "string") return "";
  const collapsed = cleanText(raw).replace(/\s+/g, " ").trim();
  // Array.from splits by code point, so an emoji is never cut in half.
  return Array.from(collapsed).slice(0, max).join("").trim();
}

/**
 * Page size from untrusted input: a whole number between 1 and `max`. Only numbers and
 * strings are read; anything else (including objects, whose `toString` may throw), NaN, and
 * Infinity use `fallback`. The result is always within [1, max], the fallback included.
 */
export function clampLimit(raw: unknown, fallback: number, max: number): number {
  const clamp = (n: number): number => (Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), max) : 1);
  let n = Number.NaN;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string") n = Number.parseInt(raw, 10);
  return clamp(Number.isFinite(n) ? n : fallback);
}

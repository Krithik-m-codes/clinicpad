/**
 * Normalizes a phone number for matching. Indian numbers (default) become 10 digits:
 * "+91 98765 43210", "919876543210", "09876543210" and "0091 98765 43210" all map to
 * "9876543210". A "+" or "00" dialling prefix marks an international number; other
 * country codes keep their full digits. "tel:+91 ...", "+0091 ..." and numbers carrying invisible format
 * characters normalize the same way. Returns null when it is not plausible.
 */
export function normalizePhone(raw: string): string | null {
  // Dialling noise, not part of the number: Unicode format characters (bidi marks, zero-width spaces pasted
  // from chat apps) and a "tel:" prefix copied from a link.
  const trimmed = raw.replace(/\p{Cf}/gu, "").trim().replace(/^tel:/i, "").trim();
  let digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return null;

  // "+" or the "00" dialling prefix marks an international number ("+00 91 ..." is a typing slip for "+91").
  let international = trimmed.startsWith("+");
  if (digits.startsWith("00")) {
    international = true;
    digits = digits.slice(2);
  }

  if (international) {
    if (digits.startsWith("91")) {
      // Indian number: country code, an optional trunk "0", then exactly 10 digits.
      const rest = digits.slice(2);
      const national = rest.length === 11 && rest.startsWith("0") ? rest.slice(1) : rest;
      return national.length === 10 ? national : null;
    }
    return digits.length >= 8 && digits.length <= 15 ? digits : null;
  }

  let national = digits;
  if (national.length === 12 && national.startsWith("91")) national = national.slice(2);
  else if (national.length === 11 && national.startsWith("0")) national = national.slice(1);

  return national.length >= 7 && national.length <= 15 ? national : null;
}

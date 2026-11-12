/**
 * Normalizes a phone number for matching. Indian numbers (default) become 10 digits:
 * "+91 98765 43210", "919876543210" and "09876543210" all map to "9876543210".
 * Other "+" country codes keep their full digits. Returns null when it is not plausible.
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return null;

  if (trimmed.startsWith("+") && !digits.startsWith("91")) {
    return digits.length >= 8 && digits.length <= 15 ? digits : null;
  }

  let national = digits;
  if (national.length === 12 && national.startsWith("91")) national = national.slice(2);
  else if (national.length === 11 && national.startsWith("0")) national = national.slice(1);

  return national.length >= 7 && national.length <= 15 ? national : null;
}

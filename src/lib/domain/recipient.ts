import { normalizePhone } from "./phone";
import { cleanText } from "./text";

export type PhoneRecipient = { ok: true; digits: string; masked: string } | { ok: false; message: string };
export type EmailRecipient = { ok: true; address: string; masked: string } | { ok: false; message: string };

export const RECIPIENT_MESSAGES = {
  phoneEmpty: "Enter the WhatsApp number.",
  phoneChars: "Use digits only, for example +91 98765 43210.",
  phoneInvalid: "This is not a valid phone number.",
  notMobile: "This is not an Indian mobile number. For another country, start with + and the country code.",
  plusAmbiguous: "The country code is missing or unclear. Retype the full number with its country code, for example +91 for India.",
  landline: "A leading 0 followed by an area code means a landline, not a mobile. Retype the mobile number without the area code, or start with + and the country code.",
  needsCountry: "Add the country code, for example +44 7700 900123.",
  emailEmpty: "Enter the email address.",
  emailInvalid: "This is not a valid email address.",
} as const;

const refuse = (message: string) => ({ ok: false as const, message });

/** Country codes that start 6-9 and are two digits long, for numbers typed "+65 8123 4567". */
const TWO_DIGIT_CODES = new Set(["60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86", "90", "92", "93", "94", "95", "98"]);

function hasSetApartCountryCode(text: string, typedDigits: string): boolean {
  const match = /^\+\s*(\d{2})[\s().-]+\d/.exec(text);
  return match !== null && TWO_DIGIT_CODES.has(match[1]) && typedDigits.startsWith(match[1]);
}

/**
 * A national number typed with a single leading 0 (11 digits). "09876543210", "0 98765 43210" and "098765-43210" are
 * mobiles with the trunk prefix; "080 2345 6789", "0755 123 4567" or "08023456789" start with an STD area code, so
 * they are landlines and are never turned into +91 mobiles. Grouping decides: a first group of 1 or 6 characters
 * (the 0 alone, or 0 plus a five-digit mobile series) or an unseparated number outside the metro STD codes.
 */
function trunkZeroNumber(text: string, typedDigits: string, international: boolean): "none" | "mobile" | "landline" {
  if (international || typedDigits.length !== 11 || !typedDigits.startsWith("0")) return "none";
  const groups = text.split(/\D+/).filter((g) => g !== "");
  if (groups.length <= 1) return /^0(?:11|20|22|33|40|44|79|80|755|612|731|712)/.test(typedDigits) ? "landline" : "mobile";
  return groups[0].length === 1 || groups[0].length === 6 ? "mobile" : "landline";
}

/** "+91******3210": the first two digits and the last four; the share log never stores more (decision 11). */
export function maskDigits(digits: string): string {
  return `+${digits.slice(0, 2)}${"*".repeat(Math.max(0, digits.length - 6))}${digits.slice(-4)}`;
}

/**
 * The full international number, digits only, that wa.me needs. Indian numbers may be typed nationally (98765
 * 43210, 0 98765 43210, 91 98765 43210) and must be mobiles (6-9); any other country needs + and its code. Anything
 * ambiguous is refused with what to type: a wrong number would send a prescription to a stranger.
 */
export function whatsAppRecipient(raw: string): PhoneRecipient {
  const text = cleanText(raw).replace(/\p{Cf}/gu, "").trim().replace(/^tel:/i, "").trim();
  if (text === "") return refuse(RECIPIENT_MESSAGES.phoneEmpty);
  if (!/^\+?[\d\s().-]+$/.test(text)) return refuse(RECIPIENT_MESSAGES.phoneChars);
  const normalized = normalizePhone(text);
  if (normalized === null) return refuse(RECIPIENT_MESSAGES.phoneInvalid);
  const typedDigits = text.replace(/\D/g, "");
  // "+9876543210": ten digits that look like an Indian mobile after a bare plus. It may be a mobile typed with a stray
  // plus or a real foreign number, so guessing either way could reach a stranger: refuse and ask for the full number
  // (no digits are ever suggested). A foreign number whose country code is set apart ("+65 8123 4567") is accepted.
  if (text.startsWith("+") && /^[6-9]\d{9}$/.test(typedDigits) && !hasSetApartCountryCode(text, typedDigits)) {
    return refuse(RECIPIENT_MESSAGES.plusAmbiguous);
  }
  const international = text.startsWith("+") || typedDigits.startsWith("00");
  const trunk = trunkZeroNumber(text, typedDigits, international);
  if (trunk === "landline") return refuse(normalized.length === 10 && /^[6-9]/.test(normalized) ? RECIPIENT_MESSAGES.landline : RECIPIENT_MESSAGES.notMobile);
  const indian = normalized.length === 10 && (!international || /^(?:00)?91/.test(typedDigits));
  let digits: string;
  if (indian) {
    if (!/^[6-9]/.test(normalized)) return refuse(RECIPIENT_MESSAGES.notMobile);
    digits = `91${normalized}`;
  } else if (international) {
    digits = normalized;
  } else {
    return refuse(RECIPIENT_MESSAGES.needsCountry);
  }
  return { ok: true, digits, masked: maskDigits(digits) };
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

/** A plain address only. Control characters (a CR/LF header injection, a NUL) are refused before any cleaning. */
export function emailRecipient(raw: string): EmailRecipient {
  if (/[\u0000-\u001f\u007f]/.test(raw)) return refuse(RECIPIENT_MESSAGES.emailInvalid);
  const text = cleanText(raw).trim();
  if (text === "") return refuse(RECIPIENT_MESSAGES.emailEmpty);
  if (text.length > 254 || !EMAIL.test(text)) return refuse(RECIPIENT_MESSAGES.emailInvalid);
  const at = text.lastIndexOf("@");
  const local = text.slice(0, at);
  const domain = text.slice(at + 1).toLowerCase();
  return { ok: true, address: `${local}@${domain}`, masked: maskEmail(local, domain) };
}

/** The most the share log accepts (rx_shares_recipient_check). */
export const MASKED_MAX = 64;

/**
 * "r***@clinic*****.in": the first character of the local part and the domain, with every digit replaced by "*" so
 * the mask never holds a run of five digits, cut to the share log's 64 characters. Whatever the address, the result
 * satisfies the log's CHECK (contains "*", no five-digit run, 1 to 64 characters); `isLoggableMask` asserts it.
 */
export function maskEmail(local: string, domain: string): string {
  const first = Array.from(local)[0] ?? "";
  const full = Array.from(`${first}***@${domain}`.replace(/\d/g, "*"));
  return full.length > MASKED_MAX ? `${full.slice(0, MASKED_MAX - 3).join("")}...` : full.join("");
}

/** Mirrors rx_shares_recipient_check and rx_shares_recipient_masked_check; checked before anything is sent. */
export function isLoggableMask(masked: string): boolean {
  const length = Array.from(masked).length;
  return length >= 1 && length <= MASKED_MAX && masked.includes("*") && !/\d{5}/.test(masked);
}

/** The number as the clinic confirms it before opening WhatsApp: "+91 98765 43210", other countries "+<digits>". */
export function formatInternational(digits: string): string {
  return /^91[6-9]\d{9}$/.test(digits) ? `+91 ${digits.slice(2, 7)} ${digits.slice(7)}` : `+${digits}`;
}

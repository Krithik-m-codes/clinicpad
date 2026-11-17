import { normalizePhone } from "./phone";
import { cleanText } from "./text";

export type PhoneRecipient = { ok: true; digits: string; masked: string } | { ok: false; message: string };
export type EmailRecipient = { ok: true; address: string; masked: string } | { ok: false; message: string };

export const RECIPIENT_MESSAGES = {
  phoneEmpty: "Enter the WhatsApp number.",
  phoneChars: "Use digits only, for example +91 98765 43210.",
  phoneInvalid: "This is not a valid phone number.",
  notMobile: "This is not an Indian mobile number. For another country, start with + and the country code.",
  needsCountry: "Add the country code, for example +44 7700 900123.",
  emailEmpty: "Enter the email address.",
  emailInvalid: "This is not a valid email address.",
} as const;

const refuse = (message: string) => ({ ok: false as const, message });

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
  // "+9876543210": a plus in front of an Indian-looking mobile that lacks the 91. It is a valid-looking international
  // number of some other country, so guessing either way could reach a stranger: refuse and say what to type.
  if (text.startsWith("+") && /^[6-9]\d{9}$/.test(typedDigits)) {
    return refuse(`Did you mean +91 ${typedDigits.slice(0, 5)} ${typedDigits.slice(5)}? Add the country code 91.`);
  }
  const international = text.startsWith("+") || typedDigits.startsWith("00");
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
  return { ok: true, address: `${local}@${domain}`, masked: `${local[0]}***@${domain}` };
}

import { randomInt } from "node:crypto";
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/rx-render/format";

/** A designer (the concierge pad setup account, ADR-0052) is temporary: seven days unless the owner chooses, never over thirty. */
export const DESIGNER_DEFAULT_DAYS = 7;
export const DESIGNER_MAX_DAYS = 30;
/** Unexpired designer accounts one clinic may have at a time. */
export const DESIGNER_MAX_ACTIVE = 5;

export type DaysResult = { ok: true; days: number } | { ok: false };

/** Whole days from 1 to 30. Empty or missing means the default; anything else (decimals, exponents, text) is refused. */
export function parseDesignerDays(value: unknown): DaysResult {
  if (value === undefined || (typeof value === "string" && value.trim() === "")) return { ok: true, days: DESIGNER_DEFAULT_DAYS };
  const days = typeof value === "number" ? value : typeof value === "string" && /^[0-9]{1,3}$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isInteger(days) || days < 1 || days > DESIGNER_MAX_DAYS) return { ok: false };
  return { ok: true, days };
}

// No 0/O/1/I/l: the password is read out or typed from a message.
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** Four groups of five characters from a CSPRNG (about 114 bits). Shown once to the owner, stored only as a bcrypt hash. */
export function generateTemporaryPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let group = "";
    for (let i = 0; i < 5; i++) group += LETTERS[randomInt(LETTERS.length)];
    groups.push(group);
  }
  return groups.join("-");
}

export type DesignerStatus = "active" | "expired" | "revoked";

/** What the owner sees. A membership without an expiry cannot be active (a designer must expire), so it reads as expired. */
export function designerStatus(row: { status: string; expiresAt: Date | null }, now: Date): DesignerStatus {
  if (row.status !== "active") return "revoked";
  if (!row.expiresAt || row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

export type HandoverInput = {
  /** null when the server has no public URL configured (NEXT_PUBLIC_APP_URL). */
  signInUrl: string | null;
  email: string;
  password: string;
  expiresAt: Date;
  timeZone: string | null | undefined;
  clinicName: string;
};

function expiryText(date: Date, timeZone: string | null | undefined): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(date);
}

/** The text the owner passes to the designer. Plain text, no markup: it is copied into a chat or an email. */
export function buildHandoverNote(input: HandoverInput): string {
  return [
    `ClinicPad setup access for ${input.clinicName}`,
    "",
    `Sign in: ${input.signInUrl ?? "the ClinicPad sign-in page"}`,
    `Email: ${input.email}`,
    `Temporary password: ${input.password}`,
    `Access ends: ${expiryText(input.expiresAt, input.timeZone)}`,
    "",
    "This account can work on pad templates only. It cannot open patients, prescriptions or settings, and it shows sample data, never a real patient.",
    "Send the password through a private channel, not together with this email address in a public place. The owner publishes the finished pad after checking it with a real patient.",
  ].join("\n");
}

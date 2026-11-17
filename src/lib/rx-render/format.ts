import type { RxItem } from "./types";

/** Largest number a printed field will show; beyond this the input is treated as damaged. */
const PRINT_LIMIT = 1_000_000;

/**
 * A finite number as short text: at most `maxDecimals` decimals, no trailing zeros, never "-0",
 * never exponent form. Empty for null, undefined, NaN, +-Infinity or absurdly large values.
 */
export function numberText(value: number | null | undefined, maxDecimals = 1): string {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > PRINT_LIMIT) return "";
  const factor = 10 ** maxDecimals;
  const rounded = Math.round(value * factor) / factor;
  if (rounded === 0) return "0"; // also turns -0 into "0"
  const fixed = rounded.toFixed(maxDecimals);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/** "130/85", or "" unless both readings are usable (positive). */
export function bpText(systolic: number | null | undefined, diastolic: number | null | undefined): string {
  const s = numberText(systolic, 0);
  const d = numberText(diastolic, 0);
  return s !== "" && d !== "" && s !== "0" && d !== "0" && !s.startsWith("-") && !d.startsWith("-") ? `${s}/${d}` : "";
}

/** Body-mass index to one decimal, or "" when weight or height is missing, non-positive or not finite. */
export function bmiText(weightKg: number | null | undefined, heightCm: number | null | undefined): string {
  if (typeof weightKg !== "number" || typeof heightCm !== "number") return "";
  if (!Number.isFinite(weightKg) || !Number.isFinite(heightCm) || weightKg <= 0 || heightCm <= 0) return "";
  const metres = heightCm / 100;
  return numberText(weightKg / (metres * metres), 1);
}

/** The product default zone, used when a stored zone is missing or damaged. */
export const DEFAULT_TIME_ZONE = "Asia/Kolkata";

/** True for a real IANA zone name. Never throws. */
export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** True for YYYY-MM-DD naming a real calendar day. */
export function isCalendarDate(ymd: unknown): ymd is string {
  return typeof ymd === "string" && formatCalendarDate(ymd) !== "";
}

function dayMonthYear(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")}`;
}

/**
 * DD/MM/YYYY of an instant in the given (clinic) timezone, never the machine's. A missing, empty or
 * unknown zone falls back to Asia/Kolkata (never UTC, which would print the wrong day for an Indian
 * evening); an unreadable or implausible instant gives "".
 */
export function formatIssuedDate(iso: string, timeZone: string | null | undefined): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getUTCFullYear();
  if (year < 1900 || year > 2999) return "";
  return dayMonthYear(date, isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE);
}

/** "2026-12-01" -> "01/12/2026"; anything else (including 2026-02-31) -> "". */
export function formatCalendarDate(ymd: string | null): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? "");
  if (!match) return "";
  const [, y, m, d] = match;
  const probe = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const real =
    probe.getUTCFullYear() === Number(y) && probe.getUTCMonth() === Number(m) - 1 && probe.getUTCDate() === Number(d);
  return real ? `${d}/${m}/${y}` : "";
}

/** Largest dose printed as a number; above it the slot reads "999+" rather than a wrong figure. */
const DOSE_CAP = 999;

/** A slot value that can be printed: finite and positive, else 0 (no dose). */
function cleanQuantity(q: number | null | undefined): number {
  if (typeof q !== "number" || !Number.isFinite(q) || q <= 0) return 0;
  return q > DOSE_CAP ? q : Math.round(q * 100) / 100; // two decimals, so "present" matches what prints
}

/**
 * One dose slot as printed in an M/A/E/N column: "0", "1", "½", "1½", "12", "0.33".
 * null, 0, negative, NaN and Infinity print "0"; fractions other than quarters keep at most 2 decimals.
 */
export function quantityText(q: number | null | undefined): string {
  const clean = cleanQuantity(q);
  if (clean === 0) return "0";
  if (clean > DOSE_CAP) return `${DOSE_CAP}+`;
  const rounded = Math.round(clean * 100) / 100;
  if (rounded === 0) return "0";
  const whole = Math.trunc(rounded);
  const fraction = Math.round((rounded - whole) * 100) / 100;
  if (fraction === 0) return String(whole);
  const glyph = fraction === 0.25 ? "¼" : fraction === 0.5 ? "½" : fraction === 0.75 ? "¾" : null;
  if (glyph === null) return String(rounded);
  return whole === 0 ? glyph : `${whole}${glyph}`;
}

type Slots = Pick<RxItem, "doseMorning" | "doseAfternoon" | "doseEvening" | "doseNight">;

export function hasSlots(item: Slots): boolean {
  return [item.doseMorning, item.doseAfternoon, item.doseEvening, item.doseNight].some((q) => cleanQuantity(q) > 0);
}

/**
 * "1-0-1" (morning-afternoon-night), or "1-0-1-1" when there is an evening dose, from the dose
 * slots; else the free-text timing; else "".
 */
export function scheduleText(item: Slots & Pick<RxItem, "timing">): string {
  if (!hasSlots(item)) return item.timing?.trim() ?? "";
  const slots =
    cleanQuantity(item.doseEvening) > 0
      ? [item.doseMorning, item.doseAfternoon, item.doseEvening, item.doseNight]
      : [item.doseMorning, item.doseAfternoon, item.doseNight];
  return slots.map(quantityText).join("-");
}

/**
 * Download name. Never contains patient data. A draft never carries a number, even though an
 * amendment draft inherits its parent's `rxNo`: `status` is required, and the name stays "Rx-draft-v<n>.pdf".
 */
export function pdfFileName(rx: { rxNo: number | null; version: number; status: string }): string {
  const numbered = rx.status !== "draft" && rx.rxNo !== null && Number.isSafeInteger(rx.rxNo) && rx.rxNo > 0;
  const no = numbered ? String(rx.rxNo) : "draft";
  const version = Number.isSafeInteger(rx.version) && rx.version > 0 ? rx.version : 1;
  return `Rx-${no}-v${version}.pdf`;
}

import { DURATION_UNIT_DAYS, type DurationUnit, type Vitals } from "./rx-options";

export type Schedule = {
  morning: number | null;
  afternoon: number | null;
  evening: number | null;
  night: number | null;
};

const GLYPHS: Record<string, number> = { "¼": 0.25, "½": 0.5, "¾": 0.75 };

function formatQty(q: number | null): string {
  if (q === null || q === 0) return "0";
  const whole = Math.trunc(q);
  const frac = Math.round((q - whole) * 100) / 100;
  if (frac === 0) return String(whole);
  const glyph = frac === 0.25 ? "¼" : frac === 0.5 ? "½" : frac === 0.75 ? "¾" : null;
  if (glyph === null) return String(q);
  return whole === 0 ? glyph : `${whole}${glyph}`;
}

/**
 * Indian pad convention: "1-0-1" is morning-afternoon-night. When an evening dose exists,
 * the four-slot form "1-0-1-1" (morning-afternoon-evening-night) is used. Empty when no dose.
 */
export function formatSchedule(s: Schedule): string {
  const slots = [s.morning, s.afternoon, s.evening, s.night];
  if (slots.every((q) => q === null || q === 0)) return "";
  const hasEvening = s.evening !== null && s.evening !== 0;
  const parts = hasEvening ? slots : [s.morning, s.afternoon, s.night];
  return parts.map(formatQty).join("-");
}

function parseQty(token: string): number | null {
  const t = token.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const glyph = /^(\d*)([¼½¾])$/.exec(t);
  if (glyph) return Number(glyph[1] || "0") + GLYPHS[glyph[2]];
  const slash = /^(\d+)\/(\d+)$/.exec(t);
  if (slash && Number(slash[2]) !== 0) return Number(slash[1]) / Number(slash[2]);
  return null;
}

/** Reads "1-0-1" (M-A-N) or "1-0-1-1" (M-A-E-N). Null for anything else ("TDS", "as directed"). */
export function parseSchedule(pattern: string): Schedule | null {
  const parts = pattern.trim().split("-");
  if (parts.length !== 3 && parts.length !== 4) return null;
  const qty: number[] = [];
  for (const part of parts) {
    const q = parseQty(part);
    if (q === null || q > 99) return null;
    qty.push(q);
  }
  return parts.length === 3
    ? { morning: qty[0], afternoon: qty[1], evening: null, night: qty[2] }
    : { morning: qty[0], afternoon: qty[1], evening: qty[2], night: qty[3] };
}

export function durationToDays(value: number, unit: DurationUnit): number {
  return value * DURATION_UNIT_DAYS[unit];
}

const UNIT_WORDS: Record<DurationUnit, [string, string]> = {
  days: ["day", "days"],
  weeks: ["week", "weeks"],
  months: ["month", "months"],
};

/** "5 days", "1 week", "3 months". Unknown or missing units read as days. Empty without a value. */
export function formatDuration(value: number | null, unit: string | null): string {
  if (value === null) return "";
  const words = unit !== null && Object.hasOwn(UNIT_WORDS, unit) ? UNIT_WORDS[unit as DurationUnit] : UNIT_WORDS.days;
  return `${value} ${value === 1 ? words[0] : words[1]}`;
}

export function bmi(weightKg?: number | null, heightCm?: number | null): number | null {
  if (!weightKg || !heightCm || weightKg <= 0 || heightCm <= 0) return null;
  const metres = heightCm / 100;
  return Math.round((weightKg / (metres * metres)) * 10) / 10;
}

export function formatBp(systolic?: number | null, diastolic?: number | null): string {
  return systolic && diastolic ? `${systolic}/${diastolic}` : "";
}

/** One-line vitals summary for read-only views and (Plan 1C) templates. */
export function vitalsLine(v: Vitals): string {
  const bp = formatBp(v.bpSystolic, v.bpDiastolic);
  const index = bmi(v.weightKg, v.heightCm);
  const parts = [
    bp ? `BP ${bp} mmHg` : "",
    v.pulse !== undefined ? `Pulse ${v.pulse}/min` : "",
    v.temperatureF !== undefined ? `Temp ${v.temperatureF} °F` : "",
    v.spo2 !== undefined ? `SpO₂ ${v.spo2}%` : "",
    v.respiratoryRate !== undefined ? `RR ${v.respiratoryRate}/min` : "",
    v.weightKg !== undefined ? `Weight ${v.weightKg} kg` : "",
    v.heightCm !== undefined ? `Height ${v.heightCm} cm` : "",
    index !== null ? `BMI ${index}` : "",
    v.bloodSugarMgDl !== undefined ? `Sugar ${v.bloodSugarMgDl} mg/dL` : "",
    v.notes ?? "",
  ];
  return parts.filter((p) => p !== "").join(" · ");
}

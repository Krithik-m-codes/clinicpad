import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/rx-render/format";

/** "YYYY-MM-DD" for `at` on the calendar of `timeZone` (the clinic's own day, not UTC's). An unknown zone uses Asia/Kolkata, never UTC. */
export function clinicLocalDate(at: Date, timeZone: string | null | undefined): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * The calendar date at UTC+14 (Kiribati), where each day starts first. A date after this is in the future for
 * every clinic on Earth, so validation that does not know the clinic yet can use it as a structural bound.
 */
export function latestCalendarDate(at: Date): string {
  return new Date(at.getTime() + 14 * 3_600_000).toISOString().slice(0, 10);
}

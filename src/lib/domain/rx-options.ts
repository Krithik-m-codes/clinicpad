import { translations } from "@/lib/translations";
/**
 * Codes and limits shared by validation, services, and the editor UI. Codes are what the
 * database stores; English labels live here. Hindi labels (for the printed pad today) live here too,
 * keyed by the same codes.
 */
export const FOOD_RELATIONS = [
  "before",
  "after",
  "with",
  "without",
  "with_tea",
  "just_for_now",
  "according_to_pain",
] as const;
export type FoodRelation = (typeof FOOD_RELATIONS)[number];

export const FOOD_RELATION_LABELS: Record<FoodRelation, string> = {
  before: "Before food",
  after: "After food",
  with: "With food",
  without: "Empty stomach",
  with_tea: "With tea or snacks",
  just_for_now: "Just for now",
  according_to_pain: "According to pain",
};

export const PERIODICITIES = [
  "daily",
  "alternate_day",
  "twice_weekly",
  "weekly",
  "every_5th_day",
  "fortnightly",
  "monthly",
  "as_needed",
] as const;
export type Periodicity = (typeof PERIODICITIES)[number];

export const PERIODICITY_LABELS: Record<Periodicity, string> = {
  daily: "Daily",
  alternate_day: "Alternate days",
  twice_weekly: "Twice a week",
  weekly: "Weekly",
  every_5th_day: "Every 5th day",
  fortnightly: "Fortnightly",
  monthly: "Monthly",
  as_needed: "As needed",
};

export const DURATION_UNITS = ["days", "weeks", "months"] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

/** Days per unit for the derived `duration_days` column. A month counts as 30 days. */
export const DURATION_UNIT_DAYS: Record<DurationUnit, number> = { days: 1, weeks: 7, months: 30 };

/** One-click schedules: morning-afternoon-night, or morning-afternoon-evening-night. */
export const SCHEDULE_PRESETS = ["1-0-1", "1-0-0", "0-0-1", "1-1-1", "1-1-1-1", "0-1-0", "½-0-½"] as const;

export const TERM_KINDS = ["complaint", "diagnosis", "history", "test"] as const;
export type TermKind = (typeof TERM_KINDS)[number];

export const RX_LIMITS = {
  medicines: 30,
  phrases: 30,
  diagnoses: 20,
  investigations: 30,
  favouritesPerDoctor: 200,
  searchQuery: 60,
} as const;

/** One set of vitals per visit, stored as jsonb in `visits.vitals`. An absent key was not measured. */
export type Vitals = {
  bpSystolic?: number;
  bpDiastolic?: number;
  pulse?: number;
  temperatureF?: number;
  spo2?: number;
  respiratoryRate?: number;
  weightKg?: number;
  heightCm?: number;
  bloodSugarMgDl?: number;
  notes?: string;
};

/** An ordered test, stored in the jsonb array `visits.investigations`. */
export type Investigation = { name: string; instructions?: string };

const hi = translations.hindi;

/*
 * NEEDS NATIVE-SPEAKER REVIEW before wide release (human decision, Plan 1D). Taken from the legacy app's strings
 * (src/lib/translations.ts). The app UI is English; these are printed on Hindi and bilingual pads.
 */
export const FOOD_RELATION_LABELS_HI: Record<FoodRelation, string> = {
  before: hi.before,
  after: hi.after,
  with: hi.with,
  without: hi.without,
  with_tea: hi.with_tea,
  just_for_now: hi.just_for_now,
  according_to_pain: hi.according_to_pain,
};

export const PERIODICITY_LABELS_HI: Record<Periodicity, string> = {
  daily: hi.daily,
  alternate_day: hi.alternate,
  twice_weekly: hi.weeklyTwice,
  weekly: hi.weekly,
  every_5th_day: hi.every_5th_day,
  fortnightly: hi.fortnightly,
  monthly: hi.monthly,
  as_needed: hi.asNeeded,
};

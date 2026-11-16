import { z } from "zod";
import {
  DURATION_UNITS,
  FOOD_RELATIONS,
  PERIODICITIES,
  RX_LIMITS,
  type Vitals,
} from "@/lib/domain/rx-options";
import { durationToDays } from "@/lib/domain/rx-format";
import { cleanText } from "@/lib/domain/text";
import {
  blankToUndefined,
  cleanInput,
  cleanOptionalText,
  cleanRequiredText,
  hasNoNul,
  NUL_MESSAGE,
} from "./text";

// Every string is cleaned (NFC, CR/CRLF to LF, stray control characters removed) before any rule
// runs; a NUL is refused with NUL_MESSAGE instead (see cleanInput).
const optionalText = cleanOptionalText;
const requiredText = cleanRequiredText;
/** For closed lists (enums): cleaned, blank means absent. */
const cleanBlank = (value: unknown) => blankToUndefined(cleanInput(value));

const emptyToNull = (value: unknown) => (value === "" || value === undefined ? null : value);
const emptyToUndefined = (value: unknown) => (value === "" || value === null ? undefined : value);
const missingToEmptyList = (value: unknown) => (value === undefined || value === null ? [] : value);

/**
 * Blank phrase entries carry no content, so they are dropped: one empty chip must never reject a
 * whole autosave. An entry that contains a NUL is kept, so the NUL rule reports it.
 */
const dropBlankEntries = (value: unknown) => {
  const list = missingToEmptyList(value);
  if (!Array.isArray(list)) return list;
  return list.filter((entry) => !(typeof entry === "string" && hasNoNul(entry) && cleanText(entry).trim() === ""));
};

/** Short phrases (complaints, history...). Blanks and repeats (ignoring case) are dropped; order is kept. */
const phraseList = (maxItems: number, label: string) =>
  z
    .preprocess(
      dropBlankEntries,
      z.array(requiredText(200, `Remove the empty ${label} entry`)).max(maxItems, `At most ${maxItems} ${label}`),
    )
    .transform((list) => list.filter((v, i) => list.findIndex((w) => w.toLowerCase() === v.toLowerCase()) === i));

// Follow-up dates are bounded so that year 0000 (valid in JavaScript, rejected by Postgres) and
// absurd years never reach the database.
const EARLIEST_FOLLOW_UP = "1900-01-01";
const LATEST_FOLLOW_UP = "2100-12-31";

/** A real calendar date from 1900-01-01 to 2100-12-31, as YYYY-MM-DD. */
const followUpDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Enter a real date")
  .refine((v) => v >= EARLIEST_FOLLOW_UP, "Follow-up date cannot be before 1900-01-01")
  .refine((v) => v <= LATEST_FOLLOW_UP, "Follow-up date cannot be after 2100-12-31");

/** A quarter-step dose for one slot of the day. */
const doseQty = z.preprocess(
  emptyToNull,
  z
    .number()
    .min(0, "A dose cannot be negative")
    .max(99, "That dose is too large")
    .multipleOf(0.25, "Use quarter steps (¼, ½, ¾)")
    .nullable(),
);

const vital = (label: string, min: number, max: number, integer = true) =>
  z.preprocess(
    emptyToUndefined,
    (integer ? z.number().int(`${label} must be a whole number`) : z.number())
      .min(min, `${label} must be at least ${min}`)
      .max(max, `${label} must be at most ${max}`)
      .optional(),
  );

export const vitalsSchema = z
  .object({
    bpSystolic: vital("Systolic BP", 50, 260),
    bpDiastolic: vital("Diastolic BP", 30, 160),
    pulse: vital("Pulse", 20, 250),
    temperatureF: vital("Temperature (°F)", 90, 110, false),
    spo2: vital("SpO₂", 50, 100),
    respiratoryRate: vital("Respiratory rate", 5, 80),
    weightKg: vital("Weight (kg)", 0.3, 300, false),
    heightCm: vital("Height (cm)", 20, 250, false),
    bloodSugarMgDl: vital("Blood sugar", 10, 800),
    notes: optionalText(200),
  })
  .superRefine((v, ctx) => {
    const hasSystolic = typeof v.bpSystolic === "number";
    const hasDiastolic = typeof v.bpDiastolic === "number";
    if (hasSystolic !== hasDiastolic) {
      ctx.addIssue({ code: "custom", path: ["bpSystolic"], message: "Enter both systolic and diastolic BP" });
    } else if (hasSystolic && hasDiastolic && (v.bpSystolic as number) <= (v.bpDiastolic as number)) {
      ctx.addIssue({ code: "custom", path: ["bpSystolic"], message: "Systolic BP must be higher than diastolic BP" });
    }
  })
  // Unknown keys are already stripped by z.object; drop the unmeasured ones too.
  .transform((v): Vitals => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as Vitals);

export const investigationSchema = z.object({
  name: requiredText(120, "Enter the test name"),
  instructions: optionalText(300),
});

export const prescriptionItemSchema = z
  .object({
    drugName: requiredText(200, "Enter the medicine name"),
    genericName: optionalText(300),
    strength: optionalText(60),
    form: optionalText(40),
    route: optionalText(40),
    dose: optionalText(60),
    doseMorning: doseQty,
    doseAfternoon: doseQty,
    doseEvening: doseQty,
    doseNight: doseQty,
    timing: optionalText(60),
    foodRelation: z.preprocess(
      cleanBlank,
      z.enum(FOOD_RELATIONS, { error: "Choose a food instruction from the list" }).optional(),
    ),
    periodicity: z.preprocess(
      cleanBlank,
      z.enum(PERIODICITIES, { error: "Choose how often from the list" }).optional(),
    ),
    isSos: z.boolean().default(false),
    durationValue: z.preprocess(
      emptyToNull,
      z
        .number()
        .int("Duration must be a whole number")
        .min(1, "Duration must be at least 1")
        .max(365, "Duration is too long")
        .nullable(),
    ),
    durationUnit: z.preprocess(cleanBlank, z.enum(DURATION_UNITS, { error: "Use days, weeks, or months" }).default("days")),
    /** Plan 1A input shape (a number of days). Used only when durationValue is absent. */
    durationDays: z
      .number()
      .int()
      .min(1, "Duration must be at least 1 day")
      .max(365, "Duration cannot exceed 365 days")
      .nullish(),
    remarks: optionalText(300),
  })
  .superRefine((item, ctx) => {
    if (typeof item.durationValue === "number" && durationToDays(item.durationValue, item.durationUnit) > 365) {
      ctx.addIssue({ code: "custom", path: ["durationValue"], message: "Duration cannot exceed one year" });
    }
  })
  .transform((item) => {
    const value = item.durationValue ?? item.durationDays ?? null;
    const unit = item.durationValue !== null ? item.durationUnit : "days";
    return {
      ...item,
      durationValue: value,
      durationUnit: value === null ? null : unit,
      // Derived total days, kept for quantity and refill calculations.
      durationDays: value === null ? null : durationToDays(value, unit),
    };
  });

export const draftInputSchema = z.object({
  visitType: z.enum(["new", "follow-up"]).default("new"),
  chiefComplaint: optionalText(500),
  complaints: phraseList(RX_LIMITS.phrases, "complaints"),
  diagnosis: phraseList(RX_LIMITS.diagnoses, "diagnoses"),
  medicalHistory: phraseList(RX_LIMITS.phrases, "history entries"),
  drugHistory: phraseList(RX_LIMITS.phrases, "drug history entries"),
  examinationNotes: optionalText(2000),
  vitals: z.preprocess((value) => (value === undefined || value === null ? {} : value), vitalsSchema),
  investigations: z
    .preprocess(
      missingToEmptyList,
      z.array(investigationSchema).max(RX_LIMITS.investigations, `At most ${RX_LIMITS.investigations} tests`),
    )
    .transform((list) =>
      list.filter((t, i) => list.findIndex((u) => u.name.toLowerCase() === t.name.toLowerCase()) === i),
    ),
  advice: optionalText(2000),
  followUpDate: z.preprocess(blankToUndefined, followUpDate.optional()),
  followUpReason: optionalText(300),
  items: z
    .array(prescriptionItemSchema)
    .max(RX_LIMITS.medicines, `A prescription can have at most ${RX_LIMITS.medicines} medicines`)
    .default([]),
});

/** Why a finalized prescription is being amended. Stored on the new version, so it is free text. */
export const amendReasonSchema = z
  .string()
  .trim()
  .min(5, "Give a reason of at least 5 characters")
  .max(500, "Keep the reason under 500 characters")
  .refine(hasNoNul, NUL_MESSAGE);

export type DraftInput = z.output<typeof draftInputSchema>;
export type DraftItemInput = z.output<typeof prescriptionItemSchema>;

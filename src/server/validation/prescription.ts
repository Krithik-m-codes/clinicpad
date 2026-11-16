import { z } from "zod";
import { blankToUndefined, hasNoNul, NUL_MESSAGE, optionalText } from "./text";

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

export const prescriptionItemSchema = z.object({
  drugName: z.string().trim().min(1, "Enter the medicine name").max(200).refine(hasNoNul, NUL_MESSAGE),
  strength: optionalText(60),
  form: optionalText(40),
  route: optionalText(40),
  dose: optionalText(60),
  timing: optionalText(60),
  foodRelation: optionalText(40),
  durationDays: z.number().int().min(1, "Duration must be at least 1 day").max(365, "Duration cannot exceed 365 days").nullish(),
  remarks: optionalText(300),
});

export const draftInputSchema = z.object({
  visitType: z.enum(["new", "follow-up"]).default("new"),
  chiefComplaint: optionalText(500),
  diagnosis: z.array(z.string().trim().min(1).max(200).refine(hasNoNul, NUL_MESSAGE)).max(20).default([]),
  advice: optionalText(2000),
  followUpDate: z.preprocess(blankToUndefined, followUpDate.optional()),
  items: z.array(prescriptionItemSchema).max(30, "A prescription can have at most 30 medicines").default([]),
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

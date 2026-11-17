import { z } from "zod";
import { normalizePhone } from "@/lib/domain/phone";
import { blankToUndefined, cleanInput, hasNoNul, NUL_MESSAGE, optionalText } from "./text";

const EARLIEST_DOB = "1900-01-01";

/** YYYY-MM-DD for a real calendar date between 1900-01-01 and today (UTC calendar date). */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Enter a real date")
  .refine((v) => v >= EARLIEST_DOB, "Date of birth cannot be before 1900-01-01")
  .refine((v) => v <= new Date().toISOString().slice(0, 10), "Date of birth cannot be in the future");

/** Accepts "a, b" from a form or ["a", "b"] from code. */
const list = z.preprocess(
  (value) => {
    if (value === undefined || value === null) return [];
    if (typeof value === "string") return value.split(/[,\n]/).map((s) => String(cleanInput(s)).trim()).filter(Boolean);
    return Array.isArray(value) ? value.map(cleanInput) : value;
  },
  z.array(z.string().trim().min(1).max(80).refine(hasNoNul, NUL_MESSAGE)).max(20),
);

export const patientInputSchema = z.object({
  name: z.preprocess(
    cleanInput,
    z.string().trim().min(2, "Enter the patient's name").max(120).refine(hasNoNul, NUL_MESSAGE),
  ),
  phone: z.preprocess(
    (value) => blankToUndefined(cleanInput(value)),
    z
      .string()
      .trim()
      .max(32)
      .refine(hasNoNul, NUL_MESSAGE)
      .refine((v) => normalizePhone(v) !== null, "Enter a valid phone number")
      .optional(),
  ),
  gender: z.enum(["female", "male", "other", "unknown"]).default("unknown"),
  dob: z.preprocess(blankToUndefined, isoDate.optional()),
  address: optionalText(300),
  allergies: list,
  notes: optionalText(2000),
});

export type PatientInput = z.output<typeof patientInputSchema>;

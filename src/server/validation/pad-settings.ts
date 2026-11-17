import { z } from "zod";
import { BUILTIN_TEMPLATES, LABEL_LANGUAGES, PAPER_SIZES } from "@/lib/rx-render/types";
import { blankToUndefined, cleanInput, cleanOptionalText, hasNoNul, NUL_MESSAGE } from "./text";

/**
 * Write-side limits of the pad settings. Every one must stay <= the frozen snapshot's limit for the same
 * value (src/lib/rx-render/snapshot.ts); tests/unit/rx-labels.test.ts imports this table to pin that.
 */
export const PAD_LIMITS = {
  clinicName: 120,
  addressLine: 200,
  city: 80,
  pincode: 12,
  state: 80,
  phone: 80,
  email: 120,
  footerChars: 600,
  footerLines: 4,
  doctorName: 120,
  qualifications: 200,
  designation: 200,
  registrationNo: 40,
  registrationCouncil: 120,
} as const;

// Every string is cleaned (cleanText: NFC, line breaks to LF, control, zero-width and bidi-control characters
// removed) before any rule runs. A string that contains a NUL is passed through untouched, so hasNoNul (or a
// format rule) refuses it with a field error: a NUL is reported, never silently dropped. Blank means absent.
const cleanBlank = (value: unknown) => blankToUndefined(cleanInput(value));

/** Cleaned, trimmed text of `min` to `max` characters without NUL. A blank value fails `min`. */
const requiredText = (min: number, max: number, message: string) =>
  z.preprocess(
    cleanInput,
    z.string().trim().min(min, message).max(max, `Keep this to at most ${max} characters`).refine(hasNoNul, NUL_MESSAGE),
  );

const footer = z
  .string()
  .trim()
  .max(PAD_LIMITS.footerChars, `Keep the footer to at most ${PAD_LIMITS.footerChars} characters`)
  .refine(hasNoNul, NUL_MESSAGE)
  .transform((text) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join("\n"),
  )
  .refine((text) => text.split("\n").length <= PAD_LIMITS.footerLines, `Use at most ${PAD_LIMITS.footerLines} footer lines`);

export const clinicPadSchema = z.object({
  // The clinic must have a printable name: a pad with no clinic name is never saved.
  name: requiredText(2, PAD_LIMITS.clinicName, "Enter the clinic name"),
  addressLine1: cleanOptionalText(PAD_LIMITS.addressLine),
  addressLine2: cleanOptionalText(PAD_LIMITS.addressLine),
  city: cleanOptionalText(PAD_LIMITS.city),
  state: cleanOptionalText(PAD_LIMITS.state),
  // The format rules below also refuse a NUL (it is not in their character classes).
  pincode: z.preprocess(cleanBlank, z.string().trim().regex(new RegExp(`^[0-9A-Za-z -]{3,${PAD_LIMITS.pincode}}$`), "Enter a valid PIN code").optional()),
  phone: cleanOptionalText(PAD_LIMITS.phone),
  email: z.preprocess(
    cleanBlank,
    z.string().trim().max(PAD_LIMITS.email, `Keep this to at most ${PAD_LIMITS.email} characters`).email("Enter a valid email").optional(),
  ),
  padFooter: z.preprocess(cleanBlank, footer.optional()),
  // A missing or blank select reads as the default (the form always sends all three).
  rxTemplate: z.preprocess(cleanBlank, z.enum(BUILTIN_TEMPLATES, { error: "Choose a template from the list" }).default("general")),
  rxPaperSize: z.preprocess(cleanBlank, z.enum(PAPER_SIZES, { error: "Choose A4 or A5" }).default("A4")),
  rxLabels: z.preprocess(cleanBlank, z.enum(LABEL_LANGUAGES, { error: "Choose a label language from the list" }).default("en")),
});

export type ClinicPadInput = z.output<typeof clinicPadSchema>;

export const doctorProfileSchema = z.object({
  displayName: requiredText(2, PAD_LIMITS.doctorName, "Enter your name as it should appear on prescriptions"),
  qualifications: cleanOptionalText(PAD_LIMITS.qualifications),
  designation: cleanOptionalText(PAD_LIMITS.designation),
  registrationNo: z.preprocess(
    cleanBlank,
    z
      .string()
      .trim()
      .max(PAD_LIMITS.registrationNo, `Keep this to at most ${PAD_LIMITS.registrationNo} characters`)
      .regex(/^[A-Za-z0-9][A-Za-z0-9 ./-]*$/, "Use letters, digits, spaces, dots, slashes or hyphens")
      .optional(),
  ),
  registrationCouncil: cleanOptionalText(PAD_LIMITS.registrationCouncil),
});

export type DoctorProfileInput = z.output<typeof doctorProfileSchema>;

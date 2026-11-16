import { z } from "zod";

const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalText = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

export const prescriptionItemSchema = z.object({
  drugName: z.string().trim().min(1, "Enter the medicine name").max(200),
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
  diagnosis: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  advice: optionalText(2000),
  followUpDate: z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
      .refine((v) => {
        const d = new Date(`${v}T00:00:00Z`);
        return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
      }, "Enter a real date")
      .optional(),
  ),
  items: z.array(prescriptionItemSchema).max(30, "A prescription can have at most 30 medicines").default([]),
});

export type DraftInput = z.output<typeof draftInputSchema>;
export type DraftItemInput = z.output<typeof prescriptionItemSchema>;

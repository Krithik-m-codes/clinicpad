import { z } from "zod";
import { cleanInput, cleanOptionalText, hasNoNul, NUL_MESSAGE } from "./text";

export const clinicMedicineInputSchema = z.object({
  name: z.preprocess(
    cleanInput,
    z
      .string()
      .trim()
      .min(2, "Enter the medicine name")
      .max(200, "Keep the name under 200 characters")
      .refine(hasNoNul, NUL_MESSAGE),
  ),
  genericName: cleanOptionalText(300),
});

export type ClinicMedicineInput = z.output<typeof clinicMedicineInputSchema>;

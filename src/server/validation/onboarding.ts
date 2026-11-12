import { z } from "zod";

export const onboardingSchema = z.object({
  clinicName: z.string().trim().min(2, "Enter your clinic name").max(120),
  doctorName: z.string().trim().min(2, "Enter your name").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  phone: z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s-]/g, ""))
    .pipe(z.string().regex(/^[0-9]{10,15}$/, "Enter a valid phone number")),
  // bcrypt only uses the first 72 bytes; reject longer input instead of silently truncating.
  password: z.string().min(8, "Use at least 8 characters").max(72, "Use at most 72 characters"),
  city: z.string().trim().max(80).optional(),
  country: z.string().trim().length(2).default("IN"),
  timezone: z.string().trim().min(1).default("Asia/Kolkata"),
  currency: z.enum(["INR", "USD", "GBP", "AED", "SGD"]).default("INR"),
});

/** Raw (pre-default) shape accepted at the boundary. */
export type OnboardingInput = z.input<typeof onboardingSchema>;

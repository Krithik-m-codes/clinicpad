"use server";

import { signIn } from "@/auth";
import { createClinicAccount } from "@/server/auth/create-clinic";
import { onboardingSchema } from "@/server/validation/onboarding";

export type SignupState = { error?: string; field?: string };

export async function signupAction(_prev: SignupState, formData: FormData): Promise<SignupState> {
  const parsed = onboardingSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: issue.message, field: String(issue.path[0] ?? "form") };
  }

  const result = await createClinicAccount(parsed.data);
  if (!result.ok) return { error: result.error, field: result.field };

  // Throws NEXT_REDIRECT on success; Next handles it.
  await signIn("credentials", {
    email: parsed.data.email,
    password: parsed.data.password,
    redirectTo: "/dashboard",
  });

  return {};
}

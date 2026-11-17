"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/server/auth/session";
import { recordSharingConsent, withdrawSharingConsent } from "@/server/services/consent";
import type { Result } from "@/lib/result";

export type ConsentFormState = { error?: string; field?: string; saved?: boolean };

const INTERNAL: ConsentFormState = { error: "Something went wrong. Please try again." };

function refresh(): void {
  // The card is shown on the patient page and inside the prescription page's share panel.
  revalidatePath("/patients/[id]", "page");
  revalidatePath("/prescriptions/[id]", "page");
}

/**
 * requireSession() redirects by throwing, so it stays outside the try block; a failure after it is answered with a
 * typed state (never a thrown error) and logged by class only.
 */
async function run(name: string, work: (session: Awaited<ReturnType<typeof requireSession>>) => Promise<Result<unknown>>): Promise<ConsentFormState> {
  const session = await requireSession();
  try {
    const result = await work(session);
    if (!result.ok) return { error: result.message, field: result.field };
    refresh();
    return { saved: true };
  } catch (error) {
    console.error(`${name} failed`, error instanceof Error ? error.name : typeof error);
    return INTERNAL;
  }
}

export async function recordConsentAction(patientId: string, _prev: ConsentFormState, formData: FormData): Promise<ConsentFormState> {
  return run("recordConsentAction", (session) =>
    recordSharingConsent(session, patientId, { method: formData.get("method"), confirmed: formData.get("confirmed") === "yes" }),
  );
}

export async function withdrawConsentAction(patientId: string, _prev: ConsentFormState, formData: FormData): Promise<ConsentFormState> {
  return run("withdrawConsentAction", (session) => withdrawSharingConsent(session, patientId, { method: formData.get("method") }));
}

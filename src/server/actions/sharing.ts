"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/server/auth/session";
import { revokeShareLink } from "@/server/services/share-links";
import { shareByEmail, shareByWhatsApp } from "@/server/services/sharing";

export type ShareFormState = { error?: string; field?: string; waUrl?: string; url?: string; sentTo?: string; expiresAt?: string };
export type RevokeFormState = { error?: string };

// Plain module constants: a "use server" file may export only async functions and types.
const INTERNAL = "Something went wrong. Please try again.";

function logFailure(name: string, error: unknown): void {
  console.error(`${name} failed`, error instanceof Error ? error.name : typeof error);
}

export async function shareWhatsAppAction(prescriptionId: string, _prev: ShareFormState, formData: FormData): Promise<ShareFormState> {
  const session = await requireSession();
  try {
    const result = await shareByWhatsApp(session, { prescriptionId, phone: formData.get("phone") });
    if (!result.ok) return { error: result.message, field: result.field };
    revalidatePath(`/prescriptions/${prescriptionId}`);
    return { waUrl: result.value.waUrl, url: result.value.url, sentTo: result.value.recipientMasked, expiresAt: result.value.expiresAt.toISOString() };
  } catch (error) {
    logFailure("shareWhatsAppAction", error);
    return { error: INTERNAL };
  }
}

export async function shareEmailAction(prescriptionId: string, _prev: ShareFormState, formData: FormData): Promise<ShareFormState> {
  const session = await requireSession();
  try {
    const result = await shareByEmail(session, { prescriptionId, email: formData.get("email") });
    if (!result.ok) {
      revalidatePath(`/prescriptions/${prescriptionId}`);
      return { error: result.message, field: result.field };
    }
    revalidatePath(`/prescriptions/${prescriptionId}`);
    return { sentTo: result.value.recipientMasked, expiresAt: result.value.expiresAt.toISOString() };
  } catch (error) {
    logFailure("shareEmailAction", error);
    return { error: INTERNAL };
  }
}

export async function revokeShareLinkAction(prescriptionId: string, linkId: string, _prev: RevokeFormState): Promise<RevokeFormState> {
  void _prev;
  const session = await requireSession();
  try {
    const result = await revokeShareLink(session, linkId);
    revalidatePath(`/prescriptions/${prescriptionId}`);
    return result.ok ? {} : { error: result.message };
  } catch (error) {
    logFailure("revokeShareLinkAction", error);
    return { error: INTERNAL };
  }
}

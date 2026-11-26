"use server";

import { revalidatePath } from "next/cache";
import { buildHandoverNote } from "@/lib/domain/designer";
import { requireSession } from "@/server/auth/session";
import { extendDesigner, inviteDesigner, revokeDesigner } from "@/server/auth/designers";
import { withTenant } from "@/server/db/tenant";
import { primaryClinic } from "@/server/services/render-snapshot";
import { resolveAppUrl } from "@/server/sharing/config";

/** `note` carries the one-time password inside the hand-over text. It is returned once and never stored or logged. */
export type DesignerFormState = { error?: string; field?: string; saved?: boolean; note?: string };

const INTERNAL: DesignerFormState = { error: "Something went wrong. Please try again." };

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function inviteDesignerAction(_prev: DesignerFormState, formData: FormData): Promise<DesignerFormState> {
  const session = await requireSession();
  try {
    const result = await inviteDesigner(session, { email: text(formData, "email"), name: text(formData, "name"), days: text(formData, "days") });
    if (!result.ok) return { error: result.message, field: result.field };
    // The account is already created: a failed clinic lookup must not lose the one-time password, so fall back to defaults.
    const clinic = await withTenant(session.tenantId, (tx) => primaryClinic(tx, session.tenantId)).catch(() => null);
    const base = resolveAppUrl(process.env);
    const note = buildHandoverNote({
      signInUrl: base ? `${base}/login` : null,
      email: result.value.email,
      password: result.value.password,
      expiresAt: result.value.expiresAt,
      timeZone: clinic?.timezone,
      clinicName: clinic?.name ?? "your clinic",
    });
    revalidatePath("/settings/designers");
    return { saved: true, note };
  } catch (error) {
    console.error("inviteDesignerAction failed", error instanceof Error ? error.name : typeof error);
    return INTERNAL;
  }
}

export async function extendDesignerAction(_prev: DesignerFormState, formData: FormData): Promise<DesignerFormState> {
  const session = await requireSession();
  try {
    const result = await extendDesigner(session, text(formData, "membershipId"), text(formData, "days"));
    if (!result.ok) return { error: result.message, field: result.field };
    revalidatePath("/settings/designers");
    return { saved: true };
  } catch (error) {
    console.error("extendDesignerAction failed", error instanceof Error ? error.name : typeof error);
    return INTERNAL;
  }
}

export async function revokeDesignerAction(_prev: DesignerFormState, formData: FormData): Promise<DesignerFormState> {
  const session = await requireSession();
  try {
    const result = await revokeDesigner(session, text(formData, "membershipId"));
    if (!result.ok) return { error: result.message };
    revalidatePath("/settings/designers");
    return { saved: true };
  } catch (error) {
    console.error("revokeDesignerAction failed", error instanceof Error ? error.name : typeof error);
    return INTERNAL;
  }
}

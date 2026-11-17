"use server";

import { revalidatePath } from "next/cache";
import { requireSession, type SessionContext } from "@/server/auth/session";
import { IMAGE_LIMITS } from "@/lib/domain/image";
import { setClinicLogo, setDoctorSignature, updateClinicPad, updateDoctorProfile } from "@/server/services/pad-settings";

export type SettingsFormState = { error?: string; field?: string; saved?: boolean; values?: Record<string, string> };

// Plain module constants: a "use server" file may export only async functions and types.
const CLINIC_FIELDS = ["name", "addressLine1", "addressLine2", "city", "state", "pincode", "phone", "email", "padFooter", "rxTemplate", "rxPaperSize", "rxLabels"];
const DOCTOR_FIELDS = ["displayName", "qualifications", "designation", "registrationNo", "registrationCouncil"];
const INTERNAL: SettingsFormState = { error: "Something went wrong. Please try again." };

function readValues(formData: FormData, fields: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const value = formData.get(field);
    values[field] = typeof value === "string" ? value : "";
  }
  return values;
}

/**
 * The file's size is checked before its bytes are read; inspectImage() decides what the bytes are. The
 * client's file name and declared type are never read.
 */
async function readImage(formData: FormData): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  const value = formData.get("image");
  if (!(value instanceof File) || value.size === 0) return { ok: false, error: "Choose a PNG or JPEG image first." };
  if (value.size > IMAGE_LIMITS.maxBytes) return { ok: false, error: `The image is larger than ${IMAGE_LIMITS.maxBytes / 1024} KB.` };
  return { ok: true, bytes: new Uint8Array(await value.arrayBuffer()) };
}

/**
 * Runs one settings action as the signed-in user. requireSession() redirects (it throws), so it runs outside
 * the try block; everything after it is caught and answered with a typed state. Logs the error class only.
 */
async function asSession(
  name: string,
  run: (session: SessionContext) => Promise<SettingsFormState>,
): Promise<SettingsFormState> {
  const session = await requireSession();
  try {
    return await run(session);
  } catch (error) {
    console.error(`${name} failed`, error instanceof Error ? error.name : typeof error);
    return INTERNAL;
  }
}

export async function saveClinicPadAction(_prev: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  return asSession("saveClinicPadAction", async (session) => {
    const values = readValues(formData, CLINIC_FIELDS);
    const result = await updateClinicPad(session, values);
    if (!result.ok) return { error: result.message, field: result.field, values };
    revalidatePath("/settings");
    return { saved: true };
  });
}

export async function saveDoctorProfileAction(_prev: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  return asSession("saveDoctorProfileAction", async (session) => {
    const values = readValues(formData, DOCTOR_FIELDS);
    const result = await updateDoctorProfile(session, values);
    if (!result.ok) return { error: result.message, field: result.field, values };
    revalidatePath("/settings/profile");
    return { saved: true };
  });
}

export async function uploadLogoAction(_prev: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  return asSession("uploadLogoAction", async (session) => {
    const image = await readImage(formData);
    if (!image.ok) return { error: image.error, field: "image" };
    const result = await setClinicLogo(session, { bytes: image.bytes });
    if (!result.ok) return { error: result.message, field: "image" };
    revalidatePath("/settings");
    return { saved: true };
  });
}

export async function removeLogoAction(_prev: SettingsFormState): Promise<SettingsFormState> {
  return asSession("removeLogoAction", async (session) => {
    const result = await setClinicLogo(session, null);
    if (!result.ok) return { error: result.message };
    revalidatePath("/settings");
    return { saved: true };
  });
}

export async function uploadSignatureAction(_prev: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  return asSession("uploadSignatureAction", async (session) => {
    const image = await readImage(formData);
    if (!image.ok) return { error: image.error, field: "image" };
    const result = await setDoctorSignature(session, { bytes: image.bytes });
    if (!result.ok) return { error: result.message, field: "image" };
    revalidatePath("/settings/profile");
    return { saved: true };
  });
}

export async function removeSignatureAction(_prev: SettingsFormState): Promise<SettingsFormState> {
  return asSession("removeSignatureAction", async (session) => {
    const result = await setDoctorSignature(session, null);
    if (!result.ok) return { error: result.message };
    revalidatePath("/settings/profile");
    return { saved: true };
  });
}

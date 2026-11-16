"use server";

import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { createPatient, updatePatient, type DuplicateCandidate } from "@/server/services/patients";

export type PatientFormValues = Record<string, string>;

export type PatientFormState = {
  error?: string;
  field?: string;
  candidates?: DuplicateCandidate[];
  values?: PatientFormValues;
};

const FIELDS = ["name", "phone", "gender", "dob", "address", "allergies", "notes"] as const;

/** Reads only the known patient fields. Tenant, user and role never come from the form. */
function readValues(formData: FormData): PatientFormValues {
  const values: PatientFormValues = {};
  for (const field of FIELDS) values[field] = String(formData.get(field) ?? "");
  return values;
}

export async function createPatientAction(
  _prev: PatientFormState,
  formData: FormData,
): Promise<PatientFormState> {
  const session = await requireSession();
  const values = readValues(formData);
  const result = await createPatient(session, values, {
    allowDuplicate: formData.get("confirmDuplicate") === "yes",
  });
  if (!result.ok) {
    if (result.code === "duplicate_candidates") {
      return { error: result.message, candidates: result.candidates, values };
    }
    return { error: result.message, field: result.field, values };
  }
  redirect(`/patients/${result.value.id}`);
}

export async function updatePatientAction(
  id: string,
  _prev: PatientFormState,
  formData: FormData,
): Promise<PatientFormState> {
  const session = await requireSession();
  const values = readValues(formData);
  const result = await updatePatient(session, id, values);
  if (!result.ok) return { error: result.message, field: result.field, values };
  redirect(`/patients/${id}`);
}

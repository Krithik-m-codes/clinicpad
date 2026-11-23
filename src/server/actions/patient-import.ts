"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/server/auth/session";
import { IMPORT_LIMITS, IMPORT_MESSAGES } from "@/lib/import/patient-rows";
import { commitPatientImport, dryRunPatientImport, type CommitSummary, type ImportReport } from "@/server/services/patient-import";

export type DryRunState = { report?: ImportReport; error?: string; field?: string };
export type CommitState = { summary?: CommitSummary; error?: string; field?: string };

// Plain module constants: a "use server" file may export only async functions and types.
const INTERNAL = "Something went wrong. Please try again.";
// File (<= 900 KB) plus these JSON fields must stay under Next's 1 MB server-action body limit.
const MAX_JSON = 100_000;
const MAX_TEXT = 100_000;

/** The size is checked before the bytes are read; decodeCsvBytes decides what the bytes are. The file name and type are never read. */
async function readFile(formData: FormData): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  const value = formData.get("file");
  if (!(value instanceof File) || value.size === 0) return { ok: false, error: "Choose a CSV file first." };
  if (value.size > IMPORT_LIMITS.maxBytes) return { ok: false, error: IMPORT_MESSAGES.tooLarge };
  return { ok: true, bytes: new Uint8Array(await value.arrayBuffer()) };
}

/** A JSON form field; anything unreadable becomes a value the service refuses (never a thrown error). */
function jsonField(formData: FormData, name: string): unknown {
  const value = formData.get(name);
  if (value === null) return undefined;
  if (typeof value !== "string" || value.length > MAX_JSON) return "unreadable";
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return "unreadable";
  }
}

/** A plain-text form field (the compact choice lists); a non-string or oversized value becomes one the service refuses. */
function textField(formData: FormData, name: string): unknown {
  const value = formData.get(name);
  if (value === null) return undefined;
  return typeof value === "string" && value.length <= MAX_TEXT ? value : false;
}

export async function dryRunImportAction(formData: FormData): Promise<DryRunState> {
  const session = await requireSession();
  try {
    const file = await readFile(formData);
    if (!file.ok) return { error: file.error, field: "file" };
    const result = await dryRunPatientImport(session, { bytes: file.bytes }, jsonField(formData, "mapping"));
    return result.ok ? { report: result.value } : { error: result.message, field: result.field };
  } catch (error) {
    console.error("dryRunImportAction failed", error instanceof Error ? error.name : typeof error);
    return { error: INTERNAL };
  }
}

export async function commitImportAction(formData: FormData): Promise<CommitState> {
  const session = await requireSession();
  try {
    const file = await readFile(formData);
    if (!file.ok) return { error: file.error, field: "file" };
    const result = await commitPatientImport(session, { bytes: file.bytes }, {
      mapping: jsonField(formData, "mapping"),
      choices: textField(formData, "choices"),
      dups: textField(formData, "dups"),
      expectedSha256: formData.get("sha"),
      checkToken: formData.get("token"),
    });
    if (!result.ok) return { error: result.message, field: result.field };
    revalidatePath("/patients");
    return { summary: result.value };
  } catch (error) {
    console.error("commitImportAction failed", error instanceof Error ? error.name : typeof error);
    return { error: INTERNAL };
  }
}

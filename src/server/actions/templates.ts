"use server";

import { revalidatePath } from "next/cache";
import { requireSession, type SessionContext } from "@/server/auth/session";
import { assignTemplate } from "@/server/services/template-assign";
import { publishTemplate, rollbackTemplate } from "@/server/services/template-publish";
import { archiveTemplate, createOverlayTemplate, discardTemplateDraft, saveTemplateDraft, startTemplateDraft, unarchiveTemplate } from "@/server/services/templates";

export type TemplateActionState = { ok?: true; error?: string; field?: string; templateId?: string; revision?: number; currentRevision?: number; issues?: string[] };

const INTERNAL: TemplateActionState = { error: "Something went wrong. Please try again." };

/** requireSession() redirects (it throws), so it runs outside the try block; everything after it is caught. Error class only in logs. */
async function asSession(name: string, run: (session: SessionContext) => Promise<TemplateActionState>): Promise<TemplateActionState> {
  const session = await requireSession();
  try {
    return await run(session);
  } catch (error) {
    console.error(`${name} failed`, error instanceof Error ? error.name : typeof error);
    return INTERNAL;
  }
}

type Failure = { ok: false; message: string; field?: string; currentRevision?: number; issues?: string[] };
const failed = (r: Failure): TemplateActionState => ({ error: r.message, field: r.field, currentRevision: r.currentRevision, issues: r.issues });

export async function createTemplateAction(input: { name: string; fileId: string; paperSize: string; labels: string; definition: unknown }): Promise<TemplateActionState> {
  return asSession("createTemplateAction", async (session) => {
    const result = await createOverlayTemplate(session, input);
    if (!result.ok) return failed(result);
    revalidatePath("/templates");
    return { ok: true, templateId: result.value.templateId };
  });
}

export async function saveTemplateDraftAction(templateId: string, input: { definition: unknown; labels: string; name?: string; fileId?: string; baseRevision: number }): Promise<TemplateActionState> {
  return asSession("saveTemplateDraftAction", async (session) => {
    const result = await saveTemplateDraft(session, templateId, input);
    if (!result.ok) return failed(result as Failure);
    return { ok: true, revision: result.value.revision };
  });
}

export async function startTemplateDraftAction(templateId: string): Promise<TemplateActionState> {
  return asSession("startTemplateDraftAction", async (session) => {
    const result = await startTemplateDraft(session, templateId);
    if (!result.ok) return failed(result);
    revalidatePath(`/templates/${templateId}`);
    return { ok: true };
  });
}

export async function discardTemplateDraftAction(templateId: string): Promise<TemplateActionState> {
  return asSession("discardTemplateDraftAction", async (session) => {
    const result = await discardTemplateDraft(session, templateId);
    if (!result.ok) return failed(result);
    revalidatePath("/templates");
    return { ok: true };
  });
}

export async function publishTemplateAction(templateId: string, input: { identity: string; boundDoctorId: string | null; confirmLetterhead: boolean; baseRevision: number }): Promise<TemplateActionState> {
  return asSession("publishTemplateAction", async (session) => {
    const result = await publishTemplate(session, templateId, input);
    if (!result.ok) return failed(result as Failure);
    revalidatePath("/templates");
    revalidatePath(`/templates/${templateId}`);
    return { ok: true };
  });
}

export async function rollbackTemplateAction(templateId: string, versionId: string): Promise<TemplateActionState> {
  return asSession("rollbackTemplateAction", async (session) => {
    const result = await rollbackTemplate(session, templateId, versionId);
    if (!result.ok) return failed(result as Failure);
    revalidatePath(`/templates/${templateId}`);
    return { ok: true };
  });
}

export async function archiveTemplateAction(templateId: string): Promise<TemplateActionState> {
  return asSession("archiveTemplateAction", async (session) => {
    const result = await archiveTemplate(session, templateId);
    if (!result.ok) return failed(result);
    revalidatePath("/templates");
    return { ok: true };
  });
}

export async function unarchiveTemplateAction(templateId: string): Promise<TemplateActionState> {
  return asSession("unarchiveTemplateAction", async (session) => {
    const result = await unarchiveTemplate(session, templateId);
    if (!result.ok) return failed(result);
    revalidatePath("/templates");
    return { ok: true };
  });
}

export async function assignTemplateAction(input: { scope: "clinic"; templateId: string | null } | { scope: "doctor"; doctorId: string; templateId: string | null }): Promise<TemplateActionState> {
  return asSession("assignTemplateAction", async (session) => {
    const result = await assignTemplate(session, input);
    if (!result.ok) return failed(result);
    revalidatePath("/templates");
    return { ok: true };
  });
}

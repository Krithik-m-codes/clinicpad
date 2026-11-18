import { and, desc, eq } from "drizzle-orm";
import { can } from "@/lib/domain/permissions";
import { fail, type ServiceError } from "@/lib/result";
import { pgErrorInfo } from "@/server/db/errors";
import { doctors, templates, templateVersions } from "@/server/db/schema";
import type { TenantTx } from "@/server/db/tenant";
import type { ServiceContext } from "./context";

export type VersionRow = typeof templateVersions.$inferSelect;
/** A template with its working draft and current published version (the identity binding lives on the VERSION, override 2). */
export type TemplateRow = typeof templates.$inferSelect & { draft: VersionRow | null; current: VersionRow | null };
export const TEMPLATE_NOT_FOUND = "Pad template not found.";
export const FILE_GONE_MESSAGE = "The uploaded pad image was not found. Upload the image again.";

/** The caller's own doctor profile in this clinic, or null (owners without a profile, designers). */
export async function myDoctorId(tx: TenantTx, ctx: ServiceContext): Promise<string | null> {
  const [row] = await tx
    .select({ id: doctors.id })
    .from(doctors)
    .where(and(eq(doctors.tenantId, ctx.tenantId), eq(doctors.userId, ctx.userId)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Locks a template row (decision 20): FOR UPDATE before writing it or its versions, FOR SHARE before writing anything
 * that references it (an assignment). Take lockTemplateQuota first when the change counts against a quota. Returns
 * null for an id that is not this tenant's (the caller answers one uniform not_found).
 */
export async function lockTemplate(tx: TenantTx, tenantId: string, id: string, mode: "update" | "share"): Promise<TemplateRow | null> {
  const [row] = await tx
    .select()
    .from(templates)
    .where(and(eq(templates.tenantId, tenantId), eq(templates.id, id)))
    .limit(1)
    .for(mode);
  if (!row) return null;
  const versions = await tx
    .select()
    .from(templateVersions)
    .where(and(eq(templateVersions.tenantId, tenantId), eq(templateVersions.templateId, id)))
    .orderBy(desc(templateVersions.version));
  return {
    ...row,
    draft: versions.find((v) => v.state === "draft") ?? null,
    current: versions.find((v) => v.id === row.currentVersionId && v.state === "published") ?? null,
  };
}

/**
 * template.write, and for a doctor only a template whose working binding (the open draft, else the current version)
 * is bound to the doctor's own profile (decision 15).
 */
export function mayWriteTemplate(ctx: ServiceContext, template: Pick<TemplateRow, "draft" | "current">, doctorId: string | null): boolean {
  if (!can(ctx.role, "template.write")) return false;
  if (ctx.role !== "doctor") return true;
  const binding = template.draft ?? template.current;
  return binding !== null && binding.identity === "bound" && doctorId !== null && binding.boundDoctorId === doctorId;
}

/**
 * Runs a write; a 23503 on template_versions_file_fk (the file was collected after the existence check or the dedupe)
 * becomes a friendly "upload the image again" instead of an internal error (Task 8/9 review note).
 */
export async function withFileFkMapped<T>(run: () => Promise<T>): Promise<T | ServiceError> {
  try {
    return await run();
  } catch (error) {
    const info = pgErrorInfo(error);
    if (info.code === "23503" && info.constraint === "template_versions_file_fk") return fail("not_found", FILE_GONE_MESSAGE, "fileId");
    throw error;
  }
}

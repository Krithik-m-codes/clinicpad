import { and, count, eq, max } from "drizzle-orm";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { fail, invalidFrom, ok, type Result, type ServiceError } from "@/lib/result";
import { overlayDefinitionSchema, overlayGeometryIssues, parseOverlayDefinition, type OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { PAPER_SIZES, pickOption, type PaperSize } from "@/lib/rx-render/types";
import { templateFiles, templates, templateVersions } from "@/server/db/schema";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { createTemplateSchema, saveDraftSchema } from "@/server/validation/templates";
import { recordAudit } from "./audit";
import type { ServiceContext } from "./context";
import { FILE_GONE_MESSAGE, lockTemplate, mayWriteTemplate, myDoctorId, TEMPLATE_NOT_FOUND, withFileFkMapped } from "./template-access";
import { lockTemplateQuota, TEMPLATE_QUOTAS } from "./template-files";

export { archiveTemplate, unarchiveTemplate } from "./template-archive";
export { getTemplateEditor, listTemplates, type TemplateEditorView, type TemplateSummary } from "./template-views";

export type DraftRevisionConflict = ServiceError & { code: "conflict"; currentRevision: number };

const NOT_FOUND = () => fail("not_found", TEMPLATE_NOT_FOUND);
const FORBIDDEN = () => fail("forbidden", "You cannot change this pad template.");
const VERSION_LIMIT = () => fail("invalid", "This clinic has reached its limit of pad versions. Ask us to raise it.");

/** The first problem with a definition, as a field error on "definition" (schema, then geometry on this paper). */
function definitionError(value: unknown, paperSize: PaperSize): ServiceError | null {
  const parsed = overlayDefinitionSchema.safeParse(value);
  if (!parsed.success) return { ...invalidFrom(parsed.error), field: "definition" };
  const issues = overlayGeometryIssues(parsed.data, paperSize);
  return issues.length > 0 ? { ok: false, code: "invalid", message: issues[0].message, field: "definition", path: issues[0].path } : null;
}

async function fileExists(tx: TenantTx, tenantId: string, fileId: string): Promise<boolean> {
  const [row] = await tx.select({ id: templateFiles.id }).from(templateFiles).where(and(eq(templateFiles.tenantId, tenantId), eq(templateFiles.id, fileId))).limit(1);
  return Boolean(row);
}

async function versionQuotaReached(tx: TenantTx, tenantId: string): Promise<boolean> {
  const [row] = await tx.select({ n: count() }).from(templateVersions).where(eq(templateVersions.tenantId, tenantId));
  return (row?.n ?? 0) >= TEMPLATE_QUOTAS.versions;
}

/** A new overlay template with its first draft (version 1). A doctor's draft is bound to the doctor (decision 15). */
export async function createOverlayTemplate(ctx: ServiceContext, raw: unknown): Promise<Result<{ templateId: string; versionId: string }>> {
  if (!can(ctx.role, "template.write")) return fail("forbidden", "You cannot create pad templates.");
  const input = createTemplateSchema.safeParse(raw);
  if (!input.success) return invalidFrom(input.error);
  const bad = definitionError(input.data.definition, input.data.paperSize);
  if (bad) return bad;
  const definition = parseOverlayDefinition(input.data.definition, input.data.paperSize) as OverlayDefinition;
  return withFileFkMapped(() =>
    withTenant(ctx.tenantId, async (tx): Promise<Result<{ templateId: string; versionId: string }>> => {
      await lockTemplateQuota(tx, ctx.tenantId);
      if (!(await fileExists(tx, ctx.tenantId, input.data.fileId))) return fail("not_found", FILE_GONE_MESSAGE, "fileId");
      const [active] = await tx.select({ n: count() }).from(templates).where(and(eq(templates.tenantId, ctx.tenantId), eq(templates.status, "active")));
      if ((active?.n ?? 0) >= TEMPLATE_QUOTAS.activeTemplates) {
        return fail("invalid", `This clinic already has ${TEMPLATE_QUOTAS.activeTemplates} active pads. Archive one first.`);
      }
      if (await versionQuotaReached(tx, ctx.tenantId)) return VERSION_LIMIT();
      let boundDoctorId: string | null = null;
      if (ctx.role === "doctor") {
        boundDoctorId = await myDoctorId(tx, ctx);
        if (!boundDoctorId) return fail("forbidden", "Set up your doctor profile before creating your own pad.");
      }
      const identity = boundDoctorId ? "bound" : "dynamic";
      const [template] = await tx.insert(templates).values({ tenantId: ctx.tenantId, name: input.data.name, kind: "overlay", createdBy: ctx.userId }).returning({ id: templates.id });
      const [version] = await tx
        .insert(templateVersions)
        .values({
          tenantId: ctx.tenantId,
          templateId: template.id,
          version: 1,
          fileId: input.data.fileId,
          definition,
          paperSize: input.data.paperSize,
          labels: input.data.labels,
          identity,
          boundDoctorId,
          createdBy: ctx.userId,
        })
        .returning({ id: templateVersions.id });
      await recordAudit(tx, ctx, {
        action: "template.created",
        entityType: "template",
        entityId: template.id,
        after: { templateId: template.id, versionId: version.id, kind: "overlay", paperSize: input.data.paperSize, labels: input.data.labels, identity },
      });
      return ok({ templateId: template.id, versionId: version.id });
    }),
  );
}

/** Saves the working draft in place (not audited: a draft is not a record, ADR-0029), under its revision counter. */
export async function saveTemplateDraft(ctx: ServiceContext, templateId: string, raw: unknown): Promise<Result<{ revision: number }> | DraftRevisionConflict> {
  if (!can(ctx.role, "template.write")) return FORBIDDEN();
  if (!isUuid(templateId)) return NOT_FOUND();
  const input = saveDraftSchema.safeParse(raw);
  if (!input.success) return invalidFrom(input.error);
  return withFileFkMapped(() =>
    withTenant(ctx.tenantId, async (tx): Promise<Result<{ revision: number }> | DraftRevisionConflict> => {
      // A new image id counts against the file quota and races the garbage collector: same lock order as upload (quota, then row).
      if (input.data.fileId) await lockTemplateQuota(tx, ctx.tenantId);
      const template = await lockTemplate(tx, ctx.tenantId, templateId, "update");
      if (!template) return NOT_FOUND();
      if (!mayWriteTemplate(ctx, template, await myDoctorId(tx, ctx))) return FORBIDDEN();
      if (template.status !== "active") return fail("conflict", "This pad is archived. Restore it before editing.");
      const draft = template.draft;
      if (!draft) return fail("conflict", "There is no draft to save. Start editing again from the published pad.");
      if (draft.draftRevision !== input.data.baseRevision) {
        return { ok: false, code: "conflict", message: "This pad was changed in another window. Reload to see the latest version.", currentRevision: draft.draftRevision };
      }
      const paperSize = pickOption(PAPER_SIZES, draft.paperSize, "A4");
      const bad = definitionError(input.data.definition, paperSize);
      if (bad) return bad;
      if (input.data.fileId && input.data.fileId !== draft.fileId && !(await fileExists(tx, ctx.tenantId, input.data.fileId))) {
        return fail("not_found", FILE_GONE_MESSAGE, "fileId");
      }
      const revision = draft.draftRevision + 1;
      await tx
        .update(templateVersions)
        .set({ definition: parseOverlayDefinition(input.data.definition, paperSize) as OverlayDefinition, labels: input.data.labels, fileId: input.data.fileId ?? draft.fileId, draftRevision: revision })
        .where(eq(templateVersions.id, draft.id));
      if (input.data.name && input.data.name !== template.name) await tx.update(templates).set({ name: input.data.name }).where(eq(templates.id, templateId));
      return ok({ revision });
    }),
  );
}

/** The working draft, created from the current published version (content and binding) when there is none (idempotent). */
export async function startTemplateDraft(ctx: ServiceContext, templateId: string): Promise<Result<{ versionId: string; version: number }>> {
  if (!can(ctx.role, "template.write")) return FORBIDDEN();
  if (!isUuid(templateId)) return NOT_FOUND();
  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ versionId: string; version: number }>> => {
    await lockTemplateQuota(tx, ctx.tenantId);
    const template = await lockTemplate(tx, ctx.tenantId, templateId, "update");
    if (!template) return NOT_FOUND();
    if (!mayWriteTemplate(ctx, template, await myDoctorId(tx, ctx))) return FORBIDDEN();
    if (template.status !== "active") return fail("conflict", "This pad is archived. Restore it before editing.");
    if (template.draft) return ok({ versionId: template.draft.id, version: template.draft.version });
    const current = template.current;
    if (!current) return fail("conflict", "This pad has nothing published to start from.");
    if (await versionQuotaReached(tx, ctx.tenantId)) return VERSION_LIMIT();
    const [top] = await tx.select({ v: max(templateVersions.version) }).from(templateVersions).where(eq(templateVersions.templateId, templateId));
    const [row] = await tx
      .insert(templateVersions)
      .values({
        tenantId: ctx.tenantId,
        templateId,
        version: (top?.v ?? 0) + 1,
        fileId: current.fileId,
        definition: current.definition,
        paperSize: current.paperSize,
        labels: current.labels,
        identity: current.identity,
        boundDoctorId: current.boundDoctorId,
        createdBy: ctx.userId,
      })
      .returning({ id: templateVersions.id, version: templateVersions.version });
    return ok({ versionId: row.id, version: row.version });
  });
}

/** Drops the working draft; a template that was never published goes with it (audited, ids only). */
export async function discardTemplateDraft(ctx: ServiceContext, templateId: string): Promise<Result<{ templateDeleted: boolean }>> {
  if (!can(ctx.role, "template.write")) return FORBIDDEN();
  if (!isUuid(templateId)) return NOT_FOUND();
  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ templateDeleted: boolean }>> => {
    const template = await lockTemplate(tx, ctx.tenantId, templateId, "update");
    if (!template) return NOT_FOUND();
    if (!mayWriteTemplate(ctx, template, await myDoctorId(tx, ctx))) return FORBIDDEN();
    if (template.draft) await tx.delete(templateVersions).where(eq(templateVersions.id, template.draft.id));
    if (template.currentVersionId !== null) return ok({ templateDeleted: false });
    await tx.delete(templates).where(eq(templates.id, templateId));
    await recordAudit(tx, ctx, { action: "template.deleted", entityType: "template", entityId: templateId, after: { templateId } });
    return ok({ templateDeleted: true });
  });
}

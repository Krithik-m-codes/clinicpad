import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { fail, ok, type Result } from "@/lib/result";
import { parseOverlayDefinition, type OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { LABEL_LANGUAGES, PAPER_SIZES, pickOption, type LabelLanguage, type PaperSize } from "@/lib/rx-render/types";
import { clinics, doctors, templates, templateVersions } from "@/server/db/schema";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import type { ServiceContext } from "./context";
import { mayWriteTemplate, myDoctorId, TEMPLATE_NOT_FOUND } from "./template-access";

export type TemplateSummary = {
  id: string;
  name: string;
  status: "active" | "archived";
  identity: "dynamic" | "bound";
  boundDoctorId: string | null;
  current: { versionId: string; version: number; publishedAt: Date } | null;
  draft: { versionId: string; version: number; revision: number; updatedAt: Date } | null;
  assignedToClinic: boolean;
  assignedDoctorIds: string[];
  canWrite: boolean;
};

export type TemplateEditorView = {
  summary: TemplateSummary;
  draft: { versionId: string; version: number; revision: number; definition: OverlayDefinition; paperSize: PaperSize; labels: LabelLanguage; fileId: string } | null;
  history: { versionId: string; version: number; publishedAt: Date; contentSha256: string }[];
};

type TemplateRecord = typeof templates.$inferSelect;

async function summaries(tx: TenantTx, ctx: ServiceContext, rows: TemplateRecord[]): Promise<TemplateSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const versions = await tx
    .select()
    .from(templateVersions)
    .where(and(eq(templateVersions.tenantId, ctx.tenantId), inArray(templateVersions.templateId, ids)));
  const [clinic] = await tx.select({ customTemplateId: clinics.customTemplateId }).from(clinics).where(eq(clinics.tenantId, ctx.tenantId)).limit(1);
  const assigned = await tx
    .select({ id: doctors.id, templateId: doctors.templateId })
    .from(doctors)
    .where(and(eq(doctors.tenantId, ctx.tenantId), inArray(doctors.templateId, ids)));
  const mine = await myDoctorId(tx, ctx);
  return rows.map((t) => {
    const current = versions.find((v) => v.id === t.currentVersionId && v.state === "published") ?? null;
    const draft = versions.find((v) => v.templateId === t.id && v.state === "draft") ?? null;
    const binding = current ?? draft;
    return {
      id: t.id,
      name: t.name,
      status: t.status === "archived" ? "archived" : "active",
      identity: binding?.identity === "bound" ? "bound" : "dynamic",
      boundDoctorId: binding?.boundDoctorId ?? null,
      current: current && current.publishedAt ? { versionId: current.id, version: current.version, publishedAt: current.publishedAt } : null,
      draft: draft ? { versionId: draft.id, version: draft.version, revision: draft.draftRevision, updatedAt: draft.updatedAt } : null,
      assignedToClinic: clinic?.customTemplateId === t.id,
      assignedDoctorIds: assigned.filter((d) => d.templateId === t.id).map((d) => d.id),
      canWrite: mayWriteTemplate(ctx, { draft, current }, mine),
    };
  });
}

export async function listTemplates(ctx: ServiceContext): Promise<Result<TemplateSummary[]>> {
  if (!can(ctx.role, "template.read")) return fail("forbidden", "You cannot view pad templates.");
  return withTenant(ctx.tenantId, async (tx) => {
    const rows = await tx.select().from(templates).where(eq(templates.tenantId, ctx.tenantId)).orderBy(asc(templates.createdAt), asc(templates.id));
    return ok(await summaries(tx, ctx, rows));
  });
}

export async function getTemplateEditor(ctx: ServiceContext, templateId: string): Promise<Result<TemplateEditorView>> {
  if (!can(ctx.role, "template.read")) return fail("forbidden", "You cannot view pad templates.");
  if (!isUuid(templateId)) return fail("not_found", TEMPLATE_NOT_FOUND);
  return withTenant(ctx.tenantId, async (tx): Promise<Result<TemplateEditorView>> => {
    const [row] = await tx.select().from(templates).where(and(eq(templates.tenantId, ctx.tenantId), eq(templates.id, templateId))).limit(1);
    if (!row) return fail("not_found", TEMPLATE_NOT_FOUND);
    const [summary] = await summaries(tx, ctx, [row]);
    const versions = await tx
      .select()
      .from(templateVersions)
      .where(and(eq(templateVersions.tenantId, ctx.tenantId), eq(templateVersions.templateId, templateId)))
      .orderBy(desc(templateVersions.version));
    const draftRow = versions.find((v) => v.state === "draft");
    let draft: TemplateEditorView["draft"] = null;
    if (draftRow) {
      const paperSize = pickOption(PAPER_SIZES, draftRow.paperSize, "A4");
      const definition = parseOverlayDefinition(draftRow.definition, paperSize);
      if (!definition) return fail("invalid", "This draft is damaged. Discard it and start again from the published version.");
      draft = {
        versionId: draftRow.id,
        version: draftRow.version,
        revision: draftRow.draftRevision,
        definition,
        paperSize,
        labels: pickOption(LABEL_LANGUAGES, draftRow.labels, "en"),
        fileId: draftRow.fileId,
      };
    }
    const history = versions
      .filter((v) => v.state === "published" && v.publishedAt && v.contentSha256)
      .map((v) => ({ versionId: v.id, version: v.version, publishedAt: v.publishedAt as Date, contentSha256: v.contentSha256 as string }));
    return ok({ summary, draft, history });
  });
}

import { and, count, eq } from "drizzle-orm";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { fail, ok, type Result } from "@/lib/result";
import { clinics, doctors, templates } from "@/server/db/schema";
import { withTenant } from "@/server/db/tenant";
import { recordAudit } from "./audit";
import type { ServiceContext } from "./context";
import { lockTemplate, TEMPLATE_NOT_FOUND } from "./template-access";
import { lockTemplateQuota, TEMPLATE_QUOTAS } from "./template-files";

const NOT_FOUND = () => fail("not_found", TEMPLATE_NOT_FOUND);

/** Hides a pad from assignment (owner only); refused while the clinic or a doctor uses it. FOR UPDATE excludes a concurrent assignment (FOR SHARE). */
export async function archiveTemplate(ctx: ServiceContext, templateId: string): Promise<Result<null>> {
  if (!can(ctx.role, "template.publish")) return fail("forbidden", "Only the clinic owner can archive pads.");
  if (!isUuid(templateId)) return NOT_FOUND();
  return withTenant(ctx.tenantId, async (tx): Promise<Result<null>> => {
    const template = await lockTemplate(tx, ctx.tenantId, templateId, "update");
    if (!template) return NOT_FOUND();
    if (template.status === "archived") return ok(null);
    const [clinic] = await tx.select({ id: clinics.id }).from(clinics).where(and(eq(clinics.tenantId, ctx.tenantId), eq(clinics.customTemplateId, templateId))).limit(1);
    const [doctor] = await tx.select({ id: doctors.id }).from(doctors).where(and(eq(doctors.tenantId, ctx.tenantId), eq(doctors.templateId, templateId))).limit(1);
    if (clinic || doctor) return fail("conflict", "This pad is in use. Choose another pad for the clinic and its doctors first.");
    await tx.update(templates).set({ status: "archived" }).where(eq(templates.id, templateId));
    await recordAudit(tx, ctx, { action: "template.archived", entityType: "template", entityId: templateId, after: { templateId } });
    return ok(null);
  });
}

export async function unarchiveTemplate(ctx: ServiceContext, templateId: string): Promise<Result<null>> {
  if (!can(ctx.role, "template.publish")) return fail("forbidden", "Only the clinic owner can restore pads.");
  if (!isUuid(templateId)) return NOT_FOUND();
  return withTenant(ctx.tenantId, async (tx): Promise<Result<null>> => {
    await lockTemplateQuota(tx, ctx.tenantId);
    const template = await lockTemplate(tx, ctx.tenantId, templateId, "update");
    if (!template) return NOT_FOUND();
    if (template.status === "active") return ok(null);
    const [active] = await tx.select({ n: count() }).from(templates).where(and(eq(templates.tenantId, ctx.tenantId), eq(templates.status, "active")));
    if ((active?.n ?? 0) >= TEMPLATE_QUOTAS.activeTemplates) return fail("invalid", `This clinic already has ${TEMPLATE_QUOTAS.activeTemplates} active pads. Archive one first.`);
    await tx.update(templates).set({ status: "active" }).where(eq(templates.id, templateId));
    await recordAudit(tx, ctx, { action: "template.unarchived", entityType: "template", entityId: templateId, after: { templateId } });
    return ok(null);
  });
}

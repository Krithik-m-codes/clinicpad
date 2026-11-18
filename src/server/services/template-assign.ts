import { and, asc, eq } from "drizzle-orm";
import { can } from "@/lib/domain/permissions";
import { fail, invalidFrom, ok, type Result } from "@/lib/result";
import { clinics, doctors } from "@/server/db/schema";
import { withTenant } from "@/server/db/tenant";
import { assignSchema } from "@/server/validation/templates";
import { recordAudit } from "./audit";
import type { ServiceContext } from "./context";
import { primaryClinic } from "./render-snapshot";
import { lockTemplate, myDoctorId, TEMPLATE_NOT_FOUND } from "./template-access";

/**
 * Chooses the pad the clinic (owner) or one doctor (owner, or that doctor for their own profile) prints on;
 * templateId null means the built-in pad. The template row is locked FOR SHARE (publish and archive take FOR UPDATE),
 * so neither can slip in between the checks and the write; the binding checked is the CURRENT version's (override 2).
 * Lock order: template (share), then the clinic or doctor row (update).
 */
export async function assignTemplate(ctx: ServiceContext, raw: unknown): Promise<Result<{ previousTemplateId: string | null }>> {
  if (!can(ctx.role, "template.assign")) return fail("forbidden", "You cannot choose pads.");
  const input = assignSchema.safeParse(raw);
  if (!input.success) return invalidFrom(input.error);
  const target = input.data;
  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ previousTemplateId: string | null }>> => {
    if (target.scope === "clinic" && ctx.role !== "owner") return fail("forbidden", "Only the clinic owner can choose the clinic's pad.");
    if (target.scope === "doctor" && ctx.role !== "owner" && target.doctorId !== (await myDoctorId(tx, ctx))) {
      return fail("forbidden", "You can only choose your own pad.");
    }
    if (target.templateId !== null) {
      const template = await lockTemplate(tx, ctx.tenantId, target.templateId, "share");
      if (!template) return fail("not_found", TEMPLATE_NOT_FOUND);
      if (template.status !== "active") return fail("conflict", "This pad is archived. Restore it first.");
      const current = template.current;
      if (!current) return fail("conflict", "Publish this pad before using it.");
      if (current.identity === "bound") {
        if (target.scope === "clinic") return fail("invalid", "A doctor's own letterhead cannot be the clinic default.");
        if (current.boundDoctorId !== target.doctorId) return fail("invalid", "This letterhead belongs to another doctor.");
      }
    }
    let previousTemplateId: string | null;
    if (target.scope === "clinic") {
      const clinic = await primaryClinic(tx, ctx.tenantId, true);
      if (!clinic) return fail("not_found", "Set up the clinic profile first.");
      previousTemplateId = clinic.customTemplateId;
      await tx.update(clinics).set({ customTemplateId: target.templateId }).where(eq(clinics.id, clinic.id));
    } else {
      const [doctor] = await tx.select().from(doctors).where(and(eq(doctors.tenantId, ctx.tenantId), eq(doctors.id, target.doctorId))).limit(1).for("update");
      if (!doctor) return fail("not_found", "Doctor not found.");
      previousTemplateId = doctor.templateId;
      await tx.update(doctors).set({ templateId: target.templateId }).where(eq(doctors.id, doctor.id));
    }
    await recordAudit(tx, ctx, {
      action: "template.assigned",
      entityType: "template",
      entityId: target.templateId ?? undefined,
      after: { scope: target.scope, doctorId: target.scope === "doctor" ? target.doctorId : null, templateId: target.templateId, previousTemplateId },
    });
    return ok({ previousTemplateId });
  });
}

/** Doctors of this clinic for the bound-letterhead and assignment pickers (display names only). */
export async function listTemplateDoctors(ctx: ServiceContext): Promise<Result<{ id: string; name: string; isMe: boolean }[]>> {
  if (!can(ctx.role, "template.read")) return fail("forbidden", "You cannot view pad templates.");
  return withTenant(ctx.tenantId, async (tx) => {
    const rows = await tx.select({ id: doctors.id, name: doctors.displayName, userId: doctors.userId }).from(doctors).where(eq(doctors.tenantId, ctx.tenantId)).orderBy(asc(doctors.displayName));
    return ok(rows.map((r) => ({ id: r.id, name: r.name?.trim() || "Doctor without a name", isMe: r.userId === ctx.userId })));
  });
}

import { and, count, eq, max } from "drizzle-orm";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { fail, invalidFrom, ok, type Result, type ServiceError } from "@/lib/result";
import { overlayDefinitionSchema, type OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { LABEL_LANGUAGES, PAPER_SIZES, pickOption } from "@/lib/rx-render/types";
import { omittedSections, sectionNames } from "@/lib/rx-render/omitted";
import { overlayPublishIssues, type PublishIdentity, type PublishIssue } from "@/lib/templates/publish-rules";
import { clinics, doctors, templateFiles, templates, templateVersions } from "@/server/db/schema";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { templateContentSha256 } from "@/server/templates/content-hash";
import { publishSchema } from "@/server/validation/templates";
import { recordAudit } from "./audit";
import type { ServiceContext } from "./context";
import { lockTemplate, TEMPLATE_NOT_FOUND, type VersionRow } from "./template-access";
import { lockTemplateQuota, TEMPLATE_QUOTAS } from "./template-files";

/** A refusal that carries every publish problem (the editor lists them), not only the first. */
export type PublishRefusal = ServiceError & { issues: string[]; issueCodes: string[] };

const NOT_FOUND = () => fail("not_found", TEMPLATE_NOT_FOUND);
const FORBIDDEN = () => fail("forbidden", "Only the clinic owner can publish pads.");
const DAMAGED = () => fail("invalid", "This pad is damaged. Discard the draft and start again from the published version.");

function refusal(issues: PublishIssue[]): PublishRefusal {
  return { ok: false, code: "invalid", message: issues[0].message, field: "definition", issues: issues.map((i) => i.message), issueCodes: issues.map((i) => i.code) };
}

type Binding = { identity: "dynamic" | "bound"; boundDoctorId: string | null; confirmed: boolean };

/**
 * A bound (doctor's own) letterhead cannot be the clinic default and cannot be another doctor's pad (decision 9). Runs
 * under the template row lock (FOR UPDATE), which an assignment (FOR SHARE) needs first, so no assignment can slip in
 * between this check and the publish. Publish and rollback share it, so a rollback cannot resurrect a binding that
 * would break an assignment made since.
 */
async function bindingConflict(tx: TenantTx, tenantId: string, templateId: string, binding: Binding): Promise<ServiceError | null> {
  if (binding.identity !== "bound") return null;
  const [asDefault] = await tx.select({ id: clinics.id }).from(clinics).where(and(eq(clinics.tenantId, tenantId), eq(clinics.customTemplateId, templateId))).limit(1);
  if (asDefault) return fail("conflict", "This pad is the clinic default. A doctor's own letterhead cannot be the clinic default: choose another default first.");
  const users = await tx.select({ id: doctors.id }).from(doctors).where(and(eq(doctors.tenantId, tenantId), eq(doctors.templateId, templateId)));
  if (users.some((d) => d.id !== binding.boundDoctorId)) return fail("conflict", "Another doctor uses this pad. Choose another pad for them first.");
  return null;
}

type Frozen = { contentSha256: string; definition: OverlayDefinition; fieldCount: number };

/** The stored file's hash and size, or null when the file is not this tenant's. */
async function fileFacts(tx: TenantTx, tenantId: string, fileId: string): Promise<{ sha256: string; byteSize: number } | null> {
  const [file] = await tx
    .select({ sha256: templateFiles.sha256, byteSize: templateFiles.byteSize })
    .from(templateFiles)
    .where(and(eq(templateFiles.tenantId, tenantId), eq(templateFiles.id, fileId)))
    .limit(1);
  return file ?? null;
}

/**
 * Publish-time checks on a draft row: the stored definition parses under the frozen v1 schema, then every publish
 * rule runs with the REAL background size (override 3). Returns the parsed definition and the file hash.
 */
async function checkDraft(tx: TenantTx, ctx: ServiceContext, draft: VersionRow, binding: Binding): Promise<Result<{ definition: OverlayDefinition; fileSha256: string }> | PublishRefusal> {
  const paperSize = pickOption(PAPER_SIZES, draft.paperSize, "A4");
  const parsed = overlayDefinitionSchema.safeParse(draft.definition);
  const file = await fileFacts(tx, ctx.tenantId, draft.fileId);
  if (!parsed.success || !file) return DAMAGED();
  const identity: PublishIdentity = binding.identity === "bound" ? { kind: "bound", doctorId: binding.boundDoctorId, confirmed: binding.confirmed } : { kind: "dynamic" };
  const issues = overlayPublishIssues(parsed.data, paperSize, identity, { backgroundBytes: file.byteSize });
  if (issues.length > 0) return refusal(issues);
  return ok({ definition: parsed.data, fileSha256: file.sha256 });
}

/**
 * A pad may leave clinical sections off, never silently (override 24): the owner's acknowledgement must equal the
 * list the server computes from the stored definition, so a stale or forged answer cannot publish.
 */
function omittedRefusal(omitted: string[], acknowledged: string[]): PublishRefusal | null {
  if (omitted.length === acknowledged.length && omitted.every((key) => acknowledged.includes(key)) && new Set(acknowledged).size === acknowledged.length) return null;
  const message = omitted.length === 0 ? "Nothing was left off this pad, so there is nothing to confirm. Reload and check it before publishing." : `This pad does not print: ${sectionNames(omitted)}. Confirm that these sections are left off, then publish.`;
  return { ok: false, code: "invalid", message, field: "definition", issues: [message], issueCodes: ["omitted_sections"] };
}

/**
 * Freezes one draft row as published (in the caller's transaction, under the template lock). The identity, bound
 * doctor, confirmation and publisher are set in the SAME publishing UPDATE (the version trigger freezes the row
 * afterwards), and the PARSED definition is written back so the stored definition is exactly what the hash covers.
 */
async function freeze(tx: TenantTx, ctx: ServiceContext, draft: VersionRow, binding: Binding, checked: { definition: OverlayDefinition; fileSha256: string }): Promise<Frozen> {
  const paperSize = pickOption(PAPER_SIZES, draft.paperSize, "A4");
  const labels = pickOption(LABEL_LANGUAGES, draft.labels, "en");
  const contentSha256 = templateContentSha256({ kind: "overlay", paperSize, labels, definition: checked.definition, fileSha256: checked.fileSha256 });
  await tx
    .update(templateVersions)
    .set({
      state: "published",
      definition: checked.definition,
      identity: binding.identity,
      boundDoctorId: binding.identity === "bound" ? binding.boundDoctorId : null,
      boundConfirmed: binding.identity === "bound" && binding.confirmed,
      contentSha256,
      publishedAt: new Date(),
      publishedBy: ctx.userId,
    })
    .where(eq(templateVersions.id, draft.id));
  return { contentSha256, definition: checked.definition, fieldCount: checked.definition.boxes.length };
}

type Published = { versionId: string; version: number; contentSha256: string };

/**
 * Publishes the working draft (owner only): checks the publish rules and the identity answer, refuses a binding
 * that would break an assignment, freezes the version with its binding (trigger), and makes it current. A double-click
 * publishes once: the second request waits on the template lock and then finds no draft.
 */
export async function publishTemplate(ctx: ServiceContext, templateId: string, raw: unknown): Promise<Result<Published> | PublishRefusal> {
  if (!can(ctx.role, "template.publish")) return FORBIDDEN();
  if (!isUuid(templateId)) return NOT_FOUND();
  const input = publishSchema.safeParse(raw);
  if (!input.success) return invalidFrom(input.error);
  return withTenant(ctx.tenantId, async (tx): Promise<Result<Published> | PublishRefusal> => {
    const template = await lockTemplate(tx, ctx.tenantId, templateId, "update");
    if (!template) return NOT_FOUND();
    if (template.status !== "active") return fail("conflict", "This pad is archived. Restore it before publishing.");
    const draft = template.draft;
    if (!draft) return fail("conflict", "There is nothing new to publish.");
    if (draft.draftRevision !== input.data.baseRevision) return fail("conflict", "This pad was changed in another window. Reload and check it before publishing.");
    const bound = input.data.identity === "bound";
    if (bound && input.data.boundDoctorId) {
      const [doc] = await tx.select({ id: doctors.id }).from(doctors).where(and(eq(doctors.tenantId, ctx.tenantId), eq(doctors.id, input.data.boundDoctorId))).limit(1);
      if (!doc) return fail("invalid", "Choose a doctor of this clinic.", "boundDoctorId");
    }
    const binding: Binding = { identity: input.data.identity, boundDoctorId: bound ? input.data.boundDoctorId : null, confirmed: bound && input.data.confirmLetterhead };
    const checked = await checkDraft(tx, ctx, draft, binding);
    if (!checked.ok) return checked;
    const omitted: string[] = omittedSections(checked.value.definition);
    const unacknowledged = omittedRefusal(omitted, input.data.acknowledgedOmitted);
    if (unacknowledged) return unacknowledged;
    const conflict = await bindingConflict(tx, ctx.tenantId, templateId, binding);
    if (conflict) return conflict;
    const frozen = await freeze(tx, ctx, draft, binding, checked.value);
    await tx.update(templates).set({ currentVersionId: draft.id }).where(eq(templates.id, templateId));
    await recordAudit(tx, ctx, {
      action: "template.published",
      entityType: "template",
      entityId: templateId,
      after: {
        templateId,
        versionId: draft.id,
        version: draft.version,
        contentSha256: frozen.contentSha256,
        kind: "overlay",
        fieldCount: frozen.fieldCount,
        identity: binding.identity,
        boundDoctorId: binding.boundDoctorId,
        boundConfirmation: bound ? binding.confirmed : null,
        omittedSections: omitted,
      },
    });
    return ok({ versionId: draft.id, version: draft.version, contentSha256: frozen.contentSha256 });
  });
}

/**
 * Publishes a copy of an older published version as the next version number (history stays linear, never rewritten).
 * The copy takes the SOURCE version's binding (override 2) and runs the same conflict checks as a publish: v1 bound to
 * doctor A, v2 unbound and made the clinic default, rollback to v1 is refused.
 */
export async function rollbackTemplate(ctx: ServiceContext, templateId: string, sourceVersionId: string): Promise<Result<{ versionId: string; version: number }> | PublishRefusal> {
  if (!can(ctx.role, "template.publish")) return FORBIDDEN();
  if (!isUuid(templateId) || !isUuid(sourceVersionId)) return NOT_FOUND();
  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ versionId: string; version: number }> | PublishRefusal> => {
    await lockTemplateQuota(tx, ctx.tenantId);
    const template = await lockTemplate(tx, ctx.tenantId, templateId, "update");
    if (!template) return NOT_FOUND();
    if (template.status !== "active") return fail("conflict", "This pad is archived. Restore it first.");
    if (template.draft) return fail("conflict", "Publish or discard the open draft first.");
    const [source] = await tx
      .select()
      .from(templateVersions)
      .where(and(eq(templateVersions.tenantId, ctx.tenantId), eq(templateVersions.templateId, templateId), eq(templateVersions.id, sourceVersionId), eq(templateVersions.state, "published")))
      .limit(1);
    if (!source) return NOT_FOUND();
    const [used] = await tx.select({ n: count() }).from(templateVersions).where(eq(templateVersions.tenantId, ctx.tenantId));
    if ((used?.n ?? 0) >= TEMPLATE_QUOTAS.versions) return fail("invalid", "This clinic has reached its limit of pad versions. Ask us to raise it.");
    const binding: Binding = { identity: source.identity === "bound" ? "bound" : "dynamic", boundDoctorId: source.boundDoctorId, confirmed: source.boundConfirmed };
    const checked = await checkDraft(tx, ctx, source, binding);
    if (!checked.ok) return checked;
    const conflict = await bindingConflict(tx, ctx.tenantId, templateId, binding);
    if (conflict) return conflict;
    const [top] = await tx.select({ v: max(templateVersions.version) }).from(templateVersions).where(eq(templateVersions.templateId, templateId));
    const [copy] = await tx
      .insert(templateVersions)
      .values({
        tenantId: ctx.tenantId,
        templateId,
        version: (top?.v ?? 0) + 1,
        fileId: source.fileId,
        definition: source.definition,
        paperSize: source.paperSize,
        labels: source.labels,
        identity: binding.identity,
        boundDoctorId: binding.boundDoctorId,
        createdBy: ctx.userId,
      })
      .returning();
    const frozen = await freeze(tx, ctx, copy, binding, checked.value);
    // A rollback is a verbatim copy: if the recomputed hash differs, the source was changed or rules about its content moved.
    if (source.contentSha256 !== frozen.contentSha256) throw new RollbackMismatch();
    await tx.update(templates).set({ currentVersionId: copy.id }).where(eq(templates.id, templateId));
    await recordAudit(tx, ctx, {
      action: "template.published",
      entityType: "template",
      entityId: templateId,
      after: {
        templateId,
        versionId: copy.id,
        version: copy.version,
        contentSha256: frozen.contentSha256,
        kind: "overlay",
        fieldCount: frozen.fieldCount,
        identity: binding.identity,
        boundDoctorId: binding.boundDoctorId,
        boundConfirmation: binding.identity === "bound" ? binding.confirmed : null,
        omittedSections: omittedSections(checked.value.definition),
        rolledBackFrom: source.id,
      },
    });
    return ok({ versionId: copy.id, version: copy.version });
  }).catch((error: unknown) => {
    if (error instanceof RollbackMismatch) return DAMAGED();
    throw error;
  });
}

class RollbackMismatch extends Error {}

import { and, desc, eq } from "drizzle-orm";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { fail, ok, type Result } from "@/lib/result";
import { renderAlignmentCheck } from "@/lib/rx-render/overlay-alignment";
import { overlayDefinitionSchema } from "@/lib/rx-render/overlay-definition";
import { renderPrescription } from "@/lib/rx-render/render";
import { sampleDocument, type SampleKind } from "@/lib/rx-render/samples";
import { checkSelfContained } from "@/lib/rx-render/self-contained";
import { snapshotWithLayout } from "@/lib/rx-render/snapshot";
import { LABEL_LANGUAGES, PAPER_SIZES, pickOption, type ImageAsset, type OverlayInput, type PadLayout, type RxDocument } from "@/lib/rx-render/types";
import { patients, prescriptions, templates, templateVersions, visits } from "@/server/db/schema";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { getPdfEngine } from "@/server/pdf";
import { PDF_LIMITS, type PdfEngine } from "@/server/pdf/engine";
import { renderLimiter, type Limiter } from "@/server/pdf/limiter";
import { loadFontCss } from "@/server/rx-render/fonts";
import { assetKey, loadImageAssets } from "./assets";
import { recordAudit } from "./audit";
import type { ServiceContext } from "./context";
import { buildRenderSnapshot } from "./render-snapshot";
import { loadRxDocumentIn } from "./rx-documents";
import { ABORTED_MESSAGE, BUSY_MESSAGE, estimateOverlayPdfBytes } from "./rx-output";
import { TEMPLATE_NOT_FOUND } from "./template-access";
import { fileAsImageAsset, loadTemplateFileIn } from "./template-files";

export type PreviewSource = { kind: "sample"; sample: SampleKind } | { kind: "patient"; prescriptionId: string };
export type PreviewResult = { format: "html"; html: string } | { format: "pdf"; pdf: ArrayBuffer };
export type PreviewPrescription = { id: string; label: string };
type Prepared = { doc: RxDocument; logo: ImageAsset | null; overlay: OverlayInput; audit: { versionId: string; prescriptionId: string; signedVersion: number | null } | null };

export const PREVIEW_PDF_TOO_LARGE_MESSAGE = "This pad is too large for a PDF preview. Use the on-screen preview instead.";
const NOT_FOUND = () => fail("not_found", TEMPLATE_NOT_FOUND);
const ZERO_HASH = "0".repeat(64);

/** The version to show: the one asked for, else the open draft, else the published one. */
async function pickVersion(tx: TenantTx, tenantId: string, templateId: string, versionId: string | null) {
  const [template] = await tx.select().from(templates).where(and(eq(templates.tenantId, tenantId), eq(templates.id, templateId))).limit(1);
  if (!template) return null;
  const versions = await tx.select().from(templateVersions).where(and(eq(templateVersions.tenantId, tenantId), eq(templateVersions.templateId, templateId)));
  return versionId ? (versions.find((v) => v.id === versionId) ?? null) : (versions.find((v) => v.state === "draft") ?? versions.find((v) => v.id === template.currentVersionId) ?? null);
}

async function prepare(tx: TenantTx, ctx: ServiceContext, templateId: string, source: PreviewSource, versionId: string | null): Promise<Result<Prepared>> {
  const version = await pickVersion(tx, ctx.tenantId, templateId, versionId);
  if (!version) return NOT_FOUND();
  const paperSize = pickOption(PAPER_SIZES, version.paperSize, "A4");
  const labels = pickOption(LABEL_LANGUAGES, version.labels, "en");
  // The frozen v1 schema without the geometry rule: a stored version was checked when it was saved, and the renderer clamps.
  const parsed = overlayDefinitionSchema.safeParse(version.definition);
  const file = parsed.success ? await loadTemplateFileIn(tx, ctx.tenantId, version.fileId) : null;
  if (!parsed.success || !file) return fail("invalid", "This pad version is damaged and cannot be shown.");
  const layout: PadLayout = { template: { kind: "overlay", templateVersionId: version.id, contentSha256: version.contentSha256 ?? ZERO_HASH }, paperSize, labels };
  const overlay: OverlayInput = { templateVersionId: version.id, definition: parsed.data, background: fileAsImageAsset(file) };

  if (source.kind === "sample") {
    // The clinic's own letterhead details; the doctor is replaced by a placeholder inside sampleDocument (override 13).
    const base = await buildRenderSnapshot(tx, { tenantId: ctx.tenantId, patientId: ctx.userId, prescriberUserId: null, visitDoctorId: null, at: new Date() });
    const { layout: _builtin, v: _v, ...parts } = base;
    void _builtin;
    void _v;
    const doc = sampleDocument(source.sample, snapshotWithLayout(parts, layout));
    const logoId = base.clinic.logoAssetId;
    const logos = logoId ? await loadImageAssets(tx, ctx.tenantId, [{ id: logoId, kind: "logo" }]) : new Map<string, ImageAsset>();
    return ok({ doc, logo: logoId ? (logos.get(assetKey("logo", logoId)) ?? null) : null, overlay, audit: null });
  }

  const loaded = await loadRxDocumentIn(tx, ctx.tenantId, source.prescriptionId, { userId: ctx.userId, canFinalize: false });
  if (!loaded.ok) return loaded.code === "not_found" ? NOT_FOUND() : loaded;
  const original = loaded.value.document;
  const { layout: _old, v: _ver, ...parts } = original.snapshot;
  void _old;
  void _ver;
  // Always a working copy: watermark, no Rx number, never a signature, whatever the source row is.
  const doc: RxDocument = {
    ...original,
    status: "draft",
    rxNo: null,
    issuedAt: null,
    supersededBy: null,
    snapshotSource: "live",
    snapshot: snapshotWithLayout({ ...parts, doctor: { ...parts.doctor, signatureAssetId: null } }, layout),
  };
  return ok({
    doc,
    logo: loaded.value.logo,
    overlay,
    audit: { versionId: version.id, prescriptionId: source.prescriptionId, signedVersion: original.status === "draft" ? null : original.version },
  });
}

/** Ids only. A real patient's data was shown, so it is audited; a signed record also gets the ordinary document-route event. */
async function recordPatientPreview(ctx: ServiceContext, templateId: string, audit: NonNullable<Prepared["audit"]>): Promise<void> {
  await withTenant(ctx.tenantId, async (tx) => {
    await recordAudit(tx, ctx, {
      action: "template.previewed_with_patient",
      entityType: "template",
      entityId: templateId,
      after: { templateId, templateVersionId: audit.versionId, prescriptionId: audit.prescriptionId },
    });
    if (audit.signedVersion !== null) {
      await recordAudit(tx, ctx, {
        action: "prescription.previewed",
        entityType: "prescription",
        entityId: audit.prescriptionId,
        after: { prescriptionId: audit.prescriptionId, version: audit.signedVersion },
      });
    }
  });
}

/**
 * A template version drawn with sample content (the clinic's letterhead, a fake patient, a placeholder doctor) or with a
 * real prescription of this clinic shown as a draft. Never a record: no output row, no signature, no Rx number. Only the
 * real-patient preview is audited (it is PHI), after the document is ready and only if the caller is still there. Designers
 * (no rx.read) can never reach the patient path. The PDF goes through the same renderer and engine as production.
 */
export async function renderTemplatePreview(
  ctx: ServiceContext,
  templateId: string,
  input: { source: PreviewSource; versionId?: string | null; format: "html" | "pdf" },
  deps: { engine?: PdfEngine; limiter?: Limiter; signal?: AbortSignal } = {},
): Promise<Result<PreviewResult>> {
  if (!can(ctx.role, "template.read")) return NOT_FOUND();
  if (!isUuid(templateId) || (input.versionId != null && !isUuid(input.versionId))) return NOT_FOUND();
  const { source } = input;
  if (source.kind === "patient" && (!can(ctx.role, "rx.read") || !isUuid(source.prescriptionId))) return NOT_FOUND();

  const prepared = await withTenant(ctx.tenantId, (tx) => prepare(tx, ctx, templateId, source, input.versionId ?? null));
  if (!prepared.ok) return prepared;
  const { doc, logo, overlay, audit } = prepared.value;

  if (input.format === "pdf" && estimateOverlayPdfBytes(overlay.background, logo, null) > PDF_LIMITS.maxPdfBytes) {
    return fail("invalid", PREVIEW_PDF_TOO_LARGE_MESSAGE);
  }
  const rendered = renderPrescription(doc, { logo, signature: null, fontCss: loadFontCss(), overlay }, { target: input.format === "pdf" ? "pdf" : "screen", sample: source.kind === "sample" });
  for (const part of [rendered.html, rendered.footerHtml]) {
    const check = checkSelfContained(part);
    if (!check.ok) throw new Error(`Rendered template preview is not self-contained: ${check.reason}`);
  }

  let pdf: ArrayBuffer | null = null;
  if (input.format === "pdf") {
    const engine = deps.engine ?? getPdfEngine();
    const run = await (deps.limiter ?? renderLimiter).run(() => engine.render(rendered, { signal: deps.signal }), { signal: deps.signal });
    if (run.busy) return fail("unavailable", BUSY_MESSAGE);
    if (run.aborted === true) return fail("unavailable", ABORTED_MESSAGE);
    if (!run.value.ok) {
      if (run.value.code === "pdf_too_large" || run.value.code === "pdf_refused") return fail("invalid", run.value.message);
      return fail(run.value.code === "pdf_timeout" ? "timeout" : "unavailable", run.value.message);
    }
    pdf = run.value.pdf;
  }
  if (deps.signal?.aborted) return fail("unavailable", ABORTED_MESSAGE);
  if (audit) await recordPatientPreview(ctx, templateId, audit);
  return pdf ? ok({ format: "pdf", pdf }) : ok({ format: "html", html: rendered.html });
}

/** The latest prescriptions of this clinic for the real-patient preview picker (rx.read only). */
export async function listPreviewPrescriptions(ctx: ServiceContext): Promise<Result<PreviewPrescription[]>> {
  if (!can(ctx.role, "rx.read") || !can(ctx.role, "template.read")) return ok([]);
  return withTenant(ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({ id: prescriptions.id, rxNo: prescriptions.rxNo, status: prescriptions.status, name: patients.name })
      .from(prescriptions)
      .innerJoin(visits, eq(visits.id, prescriptions.visitId))
      .innerJoin(patients, eq(patients.id, visits.patientId))
      .where(eq(prescriptions.tenantId, ctx.tenantId))
      .orderBy(desc(prescriptions.createdAt))
      .limit(10);
    return ok(rows.map((r) => ({ id: r.id, label: `${r.name} · ${r.status === "draft" || r.rxNo === null ? "draft" : `Rx ${r.rxNo}`}` })));
  });
}

/**
 * The alignment page for a template's open draft (else its current version): template.read only, no patient data, so
 * nothing is logged. Like previews, a stored version is never refused for geometry (the renderer clamps); a damaged one
 * fails closed.
 */
export async function renderTemplateAlignment(ctx: ServiceContext, templateId: string): Promise<Result<string>> {
  if (!can(ctx.role, "template.read") || !isUuid(templateId)) return NOT_FOUND();
  return withTenant(ctx.tenantId, async (tx): Promise<Result<string>> => {
    const version = await pickVersion(tx, ctx.tenantId, templateId, null);
    if (!version) return NOT_FOUND();
    const paperSize = pickOption(PAPER_SIZES, version.paperSize, "A4");
    const parsed = overlayDefinitionSchema.safeParse(version.definition);
    if (!parsed.success) return fail("invalid", "This pad version is damaged and cannot be shown.");
    const markup = renderAlignmentCheck(parsed.data, paperSize, loadFontCss());
    const check = checkSelfContained(markup);
    if (!check.ok) throw new Error(`Alignment check is not self-contained: ${check.reason}`);
    return ok(markup);
  });
}

import { createHash } from "node:crypto";
import { and, count, eq, inArray, max } from "drizzle-orm";
import { fail, ok, type Result } from "@/lib/result";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { rendererVersionFor, renderPrescription } from "@/lib/rx-render/render";
import { checkSelfContained } from "@/lib/rx-render/self-contained";
import { pdfFileName } from "@/lib/rx-render/format";
import type { RenderedDocument, RenderTarget } from "@/lib/rx-render/types";
import { prescriptionOutputs } from "@/server/db/schema";
import { withTenant } from "@/server/db/tenant";
import { getPdfEngine } from "@/server/pdf";
import { PDF_LIMITS, type PdfEngine } from "@/server/pdf/engine";
import { renderLimiter, type Limiter } from "@/server/pdf/limiter";
import { loadFontCss } from "@/server/rx-render/fonts";
import type { ServiceContext } from "./context";
import { recordAudit } from "./audit";
import { loadRxDocument, type RxDocumentBundle } from "./rx-documents";

export type DocumentPurpose = "preview" | "print";
export type OutputKind = "pdf_download" | "browser_print";
/** chromium: Gotenberg made a PDF. browser: the HTML document was handed to a browser print dialog. */
export type OutputEngine = "chromium" | "browser";
/** download: the digital copy. print: a PDF rendered for paper, for browsers that cannot print an overlay pad themselves. */
export type PdfPurpose = "download" | "print";
export type OutputSummary = { count: number; lastAt: Date | null };

export const DRAFT_OUTPUT_MESSAGE = "Finalize this prescription before printing or downloading it.";
export const ABORTED_MESSAGE = "The download was cancelled.";
export const BUSY_MESSAGE = "The PDF service is busy. Try again in a moment, or use Print.";

export function htmlSha256(html: string): string {
  return createHash("sha256").update(html, "utf8").digest("hex");
}

/**
 * Every document (HTML response or PDF input) is produced here, so the self-contained check runs
 * on the final markup, embedded font CSS included, before anything is served or sent to the PDF service.
 */
export function renderDocument(bundle: RxDocumentBundle, target: RenderTarget = "screen"): RenderedDocument {
  const rendered = renderPrescription(
    bundle.document,
    { logo: bundle.logo, signature: bundle.signature, fontCss: loadFontCss(), overlay: bundle.overlay },
    { target },
  );
  for (const part of [rendered.html, rendered.footerHtml]) {
    const check = checkSelfContained(part);
    // The renderer only emits embedded content, so this is a programming error, never user error.
    if (!check.ok) throw new Error(`Rendered prescription is not self-contained: ${check.reason}`);
  }
  return rendered;
}

/** The template columns of an output row and its audit event: the built-in key, or 'overlay' and the frozen version. */
export function outputTemplateColumns(bundle: RxDocumentBundle): { templateKey: string; templateVersionId: string | null; rendererVersion: string } {
  const template = bundle.document.snapshot.layout.template;
  return template.kind === "builtin"
    ? { templateKey: template.key, templateVersionId: null, rendererVersion: rendererVersionFor(template) }
    : { templateKey: "overlay", templateVersionId: template.templateVersionId, rendererVersion: rendererVersionFor(template) };
}

export const PDF_TOO_LARGE_MESSAGE = "This prescription pad is too large for download. Use Print instead.";
/** Room for fonts and PDF structure on top of the images (Gotenberg 8.40 writes each image about once). */
const PDF_SIZE_ALLOWANCE = 1024 * 1024;

const imageBytes = (image: { base64: string } | null): number => (image ? Math.floor((image.base64.length * 3) / 4) : 0);

/** A rough upper bound of an overlay pad's PDF: background + logo + signature + a small allowance. 0 for built-in pads. */
export function estimatedPdfBytes(bundle: RxDocumentBundle): number {
  if (!bundle.overlay) return 0;
  return imageBytes(bundle.overlay.background) + imageBytes(bundle.logo) + imageBytes(bundle.signature) + PDF_SIZE_ALLOWANCE;
}

export function overlayPdfTooLarge(bundle: RxDocumentBundle, limit: number = PDF_LIMITS.maxPdfBytes): boolean {
  return bundle.overlay !== null && estimatedPdfBytes(bundle) > limit;
}

/**
 * One output row plus its audit event, in ONE transaction (both or neither). Callers run it only
 * after the document exists, so a failed render logs nothing. Ids, counts and keys only: no
 * clinical text, no patient name, no file name.
 */
async function recordOutput(
  ctx: ServiceContext,
  bundle: RxDocumentBundle,
  rendered: RenderedDocument,
  kind: OutputKind,
  engine: OutputEngine,
  pdf: { pageCount: number; byteSize: number } | null,
): Promise<void> {
  const columns = outputTemplateColumns(bundle);
  await withTenant(ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(prescriptionOutputs)
      .values({
        tenantId: ctx.tenantId,
        prescriptionId: bundle.prescriptionId,
        actorUserId: ctx.userId,
        kind,
        templateKey: columns.templateKey,
        templateVersionId: columns.templateVersionId,
        engine,
        paperSize: rendered.paper.size,
        pageCount: pdf?.pageCount ?? null,
        byteSize: pdf?.byteSize ?? null,
        htmlSha256: htmlSha256(rendered.html),
        rendererVersion: columns.rendererVersion,
      })
      .returning({ id: prescriptionOutputs.id });
    await recordAudit(tx, ctx, {
      action: kind === "pdf_download" ? "prescription.pdf_downloaded" : "prescription.printed",
      entityType: "prescription",
      entityId: bundle.prescriptionId,
      after: {
        outputId: row.id,
        version: bundle.document.version,
        template: columns.templateKey,
        paperSize: rendered.paper.size,
        pageCount: pdf?.pageCount ?? null,
        engine,
        ...(columns.templateVersionId ? { templateVersionId: columns.templateVersionId } : {}),
      },
    });
  });
}

/**
 * Previewing a non-draft prescription shows a signed record, so it is audited (ids only: no output
 * row, so the "printed N times" count is unaffected). Draft previews are working copies and unlogged.
 */
async function recordPreview(ctx: ServiceContext, bundle: RxDocumentBundle): Promise<void> {
  await withTenant(ctx.tenantId, async (tx) => {
    await recordAudit(tx, ctx, {
      action: "prescription.previewed",
      entityType: "prescription",
      entityId: bundle.prescriptionId,
      after: { prescriptionId: bundle.prescriptionId, version: bundle.document.version },
    });
  });
}

function fileNameOf(bundle: RxDocumentBundle, extension: "pdf" | "html"): string {
  const { rxNo, version, status } = bundle.document;
  return pdfFileName({ rxNo, version, status }).replace(/\.pdf$/, `.${extension}`);
}

/**
 * The pad as HTML: a preview (any status; audited unless it is a draft) or a print (finalized only, logged and
 * audited). Browser print cannot be observed from the server, so a print is logged when the print
 * document is served (`purpose=print`): the log means "this document was handed to a print dialog".
 */
export async function renderPrescriptionHtml(
  ctx: ServiceContext,
  id: string,
  purpose: DocumentPurpose,
  signal?: AbortSignal,
): Promise<Result<{ html: string; title: string; fileName: string }>> {
  const loaded = await loadRxDocument(ctx, id);
  if (!loaded.ok) return loaded;
  if (purpose === "print" && loaded.value.document.status === "draft") return fail("conflict", DRAFT_OUTPUT_MESSAGE);
  const rendered = renderDocument(loaded.value, purpose === "print" ? "print" : "screen");
  // The request was cancelled before the document was handed over: do not log a print or a view nobody received.
  if (signal?.aborted) return fail("unavailable", ABORTED_MESSAGE);
  if (purpose === "print") await recordOutput(ctx, loaded.value, rendered, "browser_print", "browser", null);
  else if (loaded.value.document.status !== "draft") await recordPreview(ctx, loaded.value);
  return ok({ html: rendered.html, title: rendered.title, fileName: fileNameOf(loaded.value, "html") });
}

/** The pad as a PDF from the PDF engine. Nothing is logged unless a PDF was actually produced. */
export async function renderPrescriptionPdf(
  ctx: ServiceContext,
  id: string,
  engine: PdfEngine = getPdfEngine(),
  limiter: Limiter = renderLimiter,
  signal?: AbortSignal,
  purpose: PdfPurpose = "download",
): Promise<Result<{ pdf: ArrayBuffer; fileName: string; pageCount: number }>> {
  const loaded = await loadRxDocument(ctx, id);
  if (!loaded.ok) return loaded;
  const { document } = loaded.value;
  if (document.status === "draft") return fail("conflict", DRAFT_OUTPUT_MESSAGE);
  if (overlayPdfTooLarge(loaded.value)) return fail("invalid", PDF_TOO_LARGE_MESSAGE);
  const rendered = renderDocument(loaded.value, purpose === "print" ? "print" : "pdf");
  const run = await limiter.run(() => engine.render(rendered, { signal }), { signal });
  if (run.busy) return fail("unavailable", BUSY_MESSAGE);
  if (run.aborted === true) return fail("unavailable", ABORTED_MESSAGE);
  const outcome = run.value;
  if (!outcome.ok) {
    // Code only: never log patient data.
    console.warn(`[pdf] prescription PDF failed: ${outcome.code}`);
    if (outcome.code === "pdf_too_large" || outcome.code === "pdf_refused") return fail("invalid", outcome.message);
    return fail(outcome.code === "pdf_timeout" ? "timeout" : "unavailable", outcome.message);
  }
  // The client went away while the engine worked: nobody receives the file, so no download is logged.
  if (signal?.aborted) return fail("unavailable", ABORTED_MESSAGE);
  await recordOutput(ctx, loaded.value, rendered, purpose === "print" ? "browser_print" : "pdf_download", "chromium", {
    pageCount: outcome.pageCount,
    byteSize: outcome.pdf.byteLength,
  });
  return ok({ pdf: outcome.pdf, fileName: fileNameOf(loaded.value, "pdf"), pageCount: outcome.pageCount });
}

export async function listPrescriptionOutputs(ctx: ServiceContext, id: string): Promise<Result<OutputSummary>> {
  if (!can(ctx.role, "rx.read")) return fail("forbidden", "You cannot view prescriptions.");
  if (!isUuid(id)) return fail("not_found", "Prescription not found.");
  return withTenant(ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({ count: count(), lastAt: max(prescriptionOutputs.createdAt) })
      .from(prescriptionOutputs)
      .where(and(eq(prescriptionOutputs.prescriptionId, id), inArray(prescriptionOutputs.kind, ["pdf_download", "browser_print"])));
    return ok({ count: row?.count ?? 0, lastAt: row?.lastAt ?? null });
  });
}

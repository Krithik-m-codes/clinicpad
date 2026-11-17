import { createHash } from "node:crypto";
import { count, eq, max } from "drizzle-orm";
import { fail, ok, type Result } from "@/lib/result";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { renderPrescription } from "@/lib/rx-render/render";
import { checkSelfContained } from "@/lib/rx-render/self-contained";
import { pdfFileName } from "@/lib/rx-render/format";
import type { RenderedDocument } from "@/lib/rx-render/types";
import { prescriptionOutputs } from "@/server/db/schema";
import { withTenant } from "@/server/db/tenant";
import { getPdfEngine } from "@/server/pdf";
import type { PdfEngine } from "@/server/pdf/engine";
import { renderLimiter, type Limiter } from "@/server/pdf/limiter";
import { loadFontCss } from "@/server/rx-render/fonts";
import type { ServiceContext } from "./context";
import { recordAudit } from "./audit";
import { loadRxDocument, type RxDocumentBundle } from "./rx-documents";

export type DocumentPurpose = "preview" | "print";
export type OutputKind = "pdf_download" | "browser_print";
export type OutputSummary = { count: number; lastAt: Date | null };

export const DRAFT_OUTPUT_MESSAGE = "Finalize this prescription before printing or downloading it.";
export const BUSY_MESSAGE = "The PDF service is busy. Try again in a moment, or use Print.";

export function htmlSha256(html: string): string {
  return createHash("sha256").update(html, "utf8").digest("hex");
}

/**
 * Every document (HTML response or PDF input) is produced here, so the self-contained check runs
 * on the final markup, embedded font CSS included, before anything is served or sent to the PDF service.
 */
function render(bundle: RxDocumentBundle): RenderedDocument {
  const rendered = renderPrescription(bundle.document, { logo: bundle.logo, signature: bundle.signature, fontCss: loadFontCss() });
  for (const part of [rendered.html, rendered.footerHtml]) {
    const check = checkSelfContained(part);
    // The renderer only emits embedded content, so this is a programming error, never user error.
    if (!check.ok) throw new Error(`Rendered prescription is not self-contained: ${check.reason}`);
  }
  return rendered;
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
  pdf: { pageCount: number; byteSize: number } | null,
): Promise<void> {
  const template = bundle.document.snapshot.layout.template.key;
  await withTenant(ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(prescriptionOutputs)
      .values({
        tenantId: ctx.tenantId,
        prescriptionId: bundle.prescriptionId,
        actorUserId: ctx.userId,
        kind,
        templateKey: template,
        paperSize: rendered.paper.size,
        pageCount: pdf?.pageCount ?? null,
        byteSize: pdf?.byteSize ?? null,
        htmlSha256: htmlSha256(rendered.html),
      })
      .returning({ id: prescriptionOutputs.id });
    await recordAudit(tx, ctx, {
      action: kind === "pdf_download" ? "prescription.pdf_downloaded" : "prescription.printed",
      entityType: "prescription",
      entityId: bundle.prescriptionId,
      after: { outputId: row.id, version: bundle.document.version, template, paperSize: rendered.paper.size, pageCount: pdf?.pageCount ?? null },
    });
  });
}

function fileNameOf(bundle: RxDocumentBundle, extension: "pdf" | "html"): string {
  const { rxNo, version, status } = bundle.document;
  return pdfFileName({ rxNo, version, status }).replace(/\.pdf$/, `.${extension}`);
}

/**
 * The pad as HTML: a preview (any status, never logged) or a print (finalized only, logged and
 * audited). Browser print cannot be observed from the server, so a print is logged when the print
 * document is served (`purpose=print`): the log means "this document was handed to a print dialog".
 */
export async function renderPrescriptionHtml(
  ctx: ServiceContext,
  id: string,
  purpose: DocumentPurpose,
): Promise<Result<{ html: string; title: string; fileName: string }>> {
  const loaded = await loadRxDocument(ctx, id);
  if (!loaded.ok) return loaded;
  if (purpose === "print" && loaded.value.document.status === "draft") return fail("conflict", DRAFT_OUTPUT_MESSAGE);
  const rendered = render(loaded.value);
  if (purpose === "print") await recordOutput(ctx, loaded.value, rendered, "browser_print", null);
  return ok({ html: rendered.html, title: rendered.title, fileName: fileNameOf(loaded.value, "html") });
}

/** The pad as a PDF from the PDF engine. Nothing is logged unless a PDF was actually produced. */
export async function renderPrescriptionPdf(
  ctx: ServiceContext,
  id: string,
  engine: PdfEngine = getPdfEngine(),
  limiter: Limiter = renderLimiter,
): Promise<Result<{ pdf: ArrayBuffer; fileName: string; pageCount: number }>> {
  const loaded = await loadRxDocument(ctx, id);
  if (!loaded.ok) return loaded;
  const { document } = loaded.value;
  if (document.status === "draft") return fail("conflict", DRAFT_OUTPUT_MESSAGE);
  const rendered = render(loaded.value);
  const run = await limiter.run(() => engine.render(rendered));
  if (run.busy) return fail("unavailable", BUSY_MESSAGE);
  const outcome = run.value;
  if (!outcome.ok) {
    // Code only: never log patient data.
    console.warn(`[pdf] prescription PDF failed: ${outcome.code}`);
    if (outcome.code === "pdf_too_large" || outcome.code === "pdf_refused") return fail("invalid", outcome.message);
    return fail(outcome.code === "pdf_timeout" ? "timeout" : "unavailable", outcome.message);
  }
  await recordOutput(ctx, loaded.value, rendered, "pdf_download", { pageCount: outcome.pageCount, byteSize: outcome.pdf.byteLength });
  return ok({ pdf: outcome.pdf, fileName: fileNameOf(loaded.value, "pdf"), pageCount: outcome.pageCount });
}

export async function listPrescriptionOutputs(ctx: ServiceContext, id: string): Promise<Result<OutputSummary>> {
  if (!can(ctx.role, "rx.read")) return fail("forbidden", "You cannot view prescriptions.");
  if (!isUuid(id)) return fail("not_found", "Prescription not found.");
  return withTenant(ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({ count: count(), lastAt: max(prescriptionOutputs.createdAt) })
      .from(prescriptionOutputs)
      .where(eq(prescriptionOutputs.prescriptionId, id));
    return ok({ count: row?.count ?? 0, lastAt: row?.lastAt ?? null });
  });
}

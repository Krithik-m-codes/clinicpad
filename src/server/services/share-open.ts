import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { fail, ok, type Result } from "@/lib/result";
import { pdfFileName } from "@/lib/rx-render/format";
import { RENDERER_VERSION } from "@/lib/rx-render/render";
import { prescriptionOutputs, shareLinks } from "@/server/db/schema";
import { withShareToken } from "@/server/db/share-token";
import { withTenant } from "@/server/db/tenant";
import { getPdfEngine } from "@/server/pdf";
import type { PdfEngine } from "@/server/pdf/engine";
import { createLimiter, type Limiter } from "@/server/pdf/limiter";
import { isShareToken, shareTokenHash } from "@/server/sharing/token";
import { recordSystemAudit } from "./audit";
import { primaryClinic } from "./render-snapshot";
import { loadRxDocumentIn } from "./rx-documents";
import { htmlSha256, renderDocument } from "./rx-output";
import { linkGone, linkStatus, type ShareLinkSummary } from "./share-link-core";

const UNAVAILABLE = "The prescription cannot be shown right now.";

/**
 * Public renders get their own small engine budget, apart from the signed-in staff limiter (renderLimiter), so
 * a flood of link opens can never starve the clinic's own downloads: one render at a time, two waiting.
 */
export const publicPdfLimiter: Limiter = createLimiter({ concurrency: 1, maxQueue: 2 });

/** Links whose PDF is being rendered right now in this process: a second concurrent open of one link is refused, not queued. */
const rendering = new Set<string>();

/** For the public GET: is this token a usable link right now? Reads only; never counts an open. */
export async function resolveShareLink(token: string, now: Date = new Date()): Promise<Result<ShareLinkSummary>> {
  if (!isShareToken(token)) return linkGone();
  const hash = shareTokenHash(token);
  const [link] = await withShareToken(hash, (tx) => tx.select().from(shareLinks).where(eq(shareLinks.tokenHash, hash)).limit(1));
  if (!link || linkStatus(link, now) !== "active") return linkGone();
  return withTenant(link.tenantId, async (tx) => {
    const clinic = await primaryClinic(tx, link.tenantId);
    if (!clinic?.sharingEnabled) return linkGone();
    return ok({ linkId: link.id, tenantId: link.tenantId, expiresAt: link.expiresAt, remainingOpens: link.maxOpens - link.openCount, timeZone: clinic.timezone });
  });
}

/**
 * For the public POST: renders the frozen pad as a PDF and only then counts the open, logs a prescription_outputs
 * row (kind shared_pdf, no actor) and audits it, in one transaction that re-checks the clinic switch, the
 * cancellation signal and every link condition. A failed render, a busy engine or a cancelled request burns
 * nothing. Every unusable state answers linkGone(). Never logs the token (it is in the URL path).
 */
export async function openSharedPrescription(
  token: string,
  deps: { engine?: PdfEngine; limiter?: Limiter; signal?: AbortSignal; now?: Date } = {},
): Promise<Result<{ pdf: ArrayBuffer; fileName: string }>> {
  const now = deps.now ?? new Date();
  const resolved = await resolveShareLink(token, now);
  if (!resolved.ok) return resolved;
  const { linkId, tenantId } = resolved.value;
  if (rendering.has(linkId)) return fail("unavailable", UNAVAILABLE);
  rendering.add(linkId);
  try {
    return await render(linkId, tenantId, now, deps);
  } finally {
    rendering.delete(linkId);
  }
}

async function render(
  linkId: string,
  tenantId: string,
  now: Date,
  deps: { engine?: PdfEngine; limiter?: Limiter; signal?: AbortSignal },
): Promise<Result<{ pdf: ArrayBuffer; fileName: string }>> {
  const loaded = await withTenant(tenantId, async (tx) => {
    const [link] = await tx
      .select({ prescriptionId: shareLinks.prescriptionId })
      .from(shareLinks)
      .where(and(eq(shareLinks.tenantId, tenantId), eq(shareLinks.id, linkId)))
      .limit(1);
    if (!link) return linkGone();
    return loadRxDocumentIn(tx, tenantId, link.prescriptionId, { userId: null, canFinalize: false });
  });
  // Only a frozen, signed copy is ever shared: a draft or a row without its finalize-time snapshot is refused.
  if (!loaded.ok || loaded.value.document.status === "draft" || loaded.value.document.snapshotSource !== "finalize") return linkGone();
  const bundle = loaded.value;

  const rendered = renderDocument(bundle);
  const engine = deps.engine ?? getPdfEngine();
  const run = await (deps.limiter ?? publicPdfLimiter).run(() => engine.render(rendered, { signal: deps.signal }), { signal: deps.signal });
  if (run.busy || run.aborted === true) return fail("unavailable", UNAVAILABLE);
  const outcome = run.value;
  if (!outcome.ok) {
    console.warn(`[share] shared PDF failed: ${outcome.code}`);
    return fail(outcome.code === "pdf_timeout" ? "timeout" : "unavailable", UNAVAILABLE);
  }

  const counted = await withTenant(tenantId, async (tx): Promise<"gone" | "cancelled" | "counted"> => {
    // Re-checked here, in the transaction that counts: the clinic may have switched sharing off, or the client may
    // have gone away, while the engine worked.
    if (deps.signal?.aborted) return "cancelled";
    const clinic = await primaryClinic(tx, tenantId);
    if (!clinic?.sharingEnabled) return "gone";
    const [updated] = await tx
      .update(shareLinks)
      .set({ openCount: sql`${shareLinks.openCount} + 1`, lastOpenedAt: now })
      .where(
        and(
          eq(shareLinks.tenantId, tenantId),
          eq(shareLinks.id, linkId),
          isNull(shareLinks.revokedAt),
          gt(shareLinks.expiresAt, now),
          lt(shareLinks.openCount, shareLinks.maxOpens),
        ),
      )
      .returning({ openCount: shareLinks.openCount });
    if (!updated) return "gone";
    const [output] = await tx
      .insert(prescriptionOutputs)
      .values({
        tenantId,
        prescriptionId: bundle.prescriptionId,
        actorUserId: null,
        kind: "shared_pdf",
        shareLinkId: linkId,
        templateKey: bundle.document.snapshot.layout.template.key,
        paperSize: rendered.paper.size,
        pageCount: outcome.pageCount,
        byteSize: outcome.pdf.byteLength,
        htmlSha256: htmlSha256(rendered.html),
        rendererVersion: RENDERER_VERSION,
      })
      .returning({ id: prescriptionOutputs.id });
    await recordSystemAudit(tx, tenantId, {
      action: "prescription.share_opened",
      entityType: "prescription",
      entityId: bundle.prescriptionId,
      after: { linkId, outputId: output.id, version: bundle.document.version, openCount: updated.openCount },
    });
    return "counted";
  });
  if (counted === "gone") return linkGone();
  if (counted === "cancelled") return fail("unavailable", UNAVAILABLE);
  return ok({ pdf: outcome.pdf, fileName: pdfFileName(bundle.document) });
}

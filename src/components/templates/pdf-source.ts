import type { PaperSize } from "@/lib/rx-render/types";
import { paperFromPdfPoints } from "@/lib/templates/image-geometry";
import { rasterizePdfPage, type RasterFailure } from "@/lib/templates/pdf-frame-client";
import { BLANK_RENDER_PERCENT, PDF_INTAKE_LIMITS } from "@/lib/templates/pdf-intake";

const IMAGE_FALLBACK = "Export the pad page as a PNG or JPEG image and upload that instead.";
export const PDF_ERRORS: Record<RasterFailure, string> = {
  too_large: "The PDF is larger than 10 MB. Save page 1 alone as a PDF, or export it as an image.",
  too_many_pages: "The PDF has more than 50 pages. Save only the pad page as a PDF.",
  encrypted: "The PDF is password-protected. Save an unprotected copy, or export the pad page as an image.",
  unreadable: `The PDF could not be read here. ${IMAGE_FALLBACK}`,
  timeout: `Reading the PDF took too long. ${IMAGE_FALLBACK}`,
};
const BLANK_WARNING = "The page looks blank. If that is wrong, pick another page or export the pad as an image.";

export type PdfPage = { blob: Blob; proposedPaper: PaperSize; warning?: string; pageCount: number };

/** One page of a PDF as an image, through the sandboxed frame; the failure is already a sentence for the doctor. */
export async function readPdfPage(bytes: ArrayBuffer, page: number): Promise<({ ok: true } & PdfPage) | { ok: false; message: string }> {
  const result = await rasterizePdfPage(bytes, { page, dpi: PDF_INTAKE_LIMITS.dpi });
  if (!result.ok) return { ok: false, message: PDF_ERRORS[result.code] };
  return {
    ok: true,
    blob: result.image,
    proposedPaper: paperFromPdfPoints(result.pageSizePt[0], result.pageSizePt[1]) ?? "A4",
    warning: result.nonWhitePercent < BLANK_RENDER_PERCENT ? BLANK_WARNING : undefined,
    pageCount: result.pageCount,
  };
}

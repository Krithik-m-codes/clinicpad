"use client";

import { useState } from "react";
import type { PaperSize } from "@/lib/rx-render/types";
import { paperFromPdfPoints } from "@/lib/templates/image-geometry";
import { rasterizePdfPage, type RasterFailure } from "@/lib/templates/pdf-frame-client";
import { BLANK_RENDER_PERCENT, PDF_INTAKE_LIMITS } from "@/lib/templates/pdf-intake";
import { Button } from "@/components/ui/button";

export type PickedImage = { blob: Blob; proposedPaper: PaperSize; warning?: string };

const IMAGE_LIMIT = 15 * 1024 * 1024; // before the browser shrinks it; the upload itself is at most 1 MB
const IMAGE_FALLBACK = "Export the pad page as a PNG or JPEG image and upload that instead.";
const PDF_ERRORS: Record<RasterFailure, string> = {
  too_large: "The PDF is larger than 10 MB. Save page 1 alone as a PDF, or export it as an image.",
  too_many_pages: "The PDF has more than 50 pages. Save only the pad page as a PDF.",
  encrypted: "The PDF is password-protected. Save an unprotected copy, or export the pad page as an image.",
  unreadable: `The PDF could not be read here. ${IMAGE_FALLBACK}`,
  timeout: `Reading the PDF took too long. ${IMAGE_FALLBACK}`,
};
const BLANK_WARNING = "The page looks blank. If that is wrong, pick another page or export the pad as an image.";

type Props = { kind: "image" | "pdf"; onPicked: (picked: PickedImage) => void; onUseImage: () => void };

/** Never shows or sends the file's name: it is not needed and may be hostile. */
export function FileStep({ kind, onPicked, onUseImage }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pdf, setPdf] = useState<{ bytes: ArrayBuffer; pages: number; page: number } | null>(null);

  async function renderPage(bytes: ArrayBuffer, page: number) {
    setBusy(true);
    setError(null);
    const result = await rasterizePdfPage(bytes, { page, dpi: PDF_INTAKE_LIMITS.dpi });
    setBusy(false);
    if (!result.ok) return setError(PDF_ERRORS[result.code]);
    setPdf({ bytes, pages: result.pageCount, page });
    onPicked({
      blob: result.image,
      proposedPaper: paperFromPdfPoints(result.pageSizePt[0], result.pageSizePt[1]) ?? "A4",
      warning: result.nonWhitePercent < BLANK_RENDER_PERCENT ? BLANK_WARNING : undefined,
    });
  }

  async function choose(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (kind === "image") {
      // The bytes decide on the server; here only the size is checked so the browser does not try to decode a huge file.
      if (file.size > IMAGE_LIMIT) return setError("The image is larger than 15 MB. Scan at a lower resolution.");
      return onPicked({ blob: file, proposedPaper: "A4" });
    }
    if (file.size > PDF_INTAKE_LIMITS.maxBytes) return setError(PDF_ERRORS.too_large);
    try {
      await renderPage(await file.arrayBuffer(), 1);
    } catch {
      setBusy(false);
      setError(PDF_ERRORS.unreadable);
    }
  }

  return (
    <div className="space-y-3">
      <label className="block space-y-1">
        <span className="font-medium">{kind === "image" ? "Choose the photo or scan" : "Choose the PDF"}</span>
        <input
          type="file"
          accept={kind === "image" ? "image/png,image/jpeg" : "application/pdf"}
          onChange={(e) => void choose(e.target.files?.[0])}
          disabled={busy}
          aria-describedby="file-step-status"
          className="block w-full text-sm"
        />
      </label>
      {pdf && pdf.pages > 1 ? (
        <label className="block space-y-1">
          <span className="text-sm">The pad is on page</span>
          <select value={pdf.page} onChange={(e) => void renderPage(pdf.bytes, Number(e.target.value))} disabled={busy} className="rounded border p-1">
            {Array.from({ length: pdf.pages }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div id="file-step-status" role="status" aria-live="polite" className="space-y-2 text-sm">
        {busy ? <p>Reading the PDF…</p> : null}
        {error ? <p className="text-destructive">{error}</p> : null}
        {error && kind === "pdf" ? (
          <Button type="button" variant="outline" size="sm" onClick={onUseImage}>
            Use a photo or image instead
          </Button>
        ) : null}
      </div>
    </div>
  );
}

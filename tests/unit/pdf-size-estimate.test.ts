import { describe, expect, it } from "vitest";
import { estimatedPdfBytes, overlayPdfTooLarge, PDF_TOO_LARGE_MESSAGE } from "@/server/services/rx-output";
import { PDF_LIMITS } from "@/server/pdf/engine";
import type { ImageAsset } from "@/lib/rx-render/types";
import type { RxDocumentBundle } from "@/server/services/rx-documents";

const image = (bytes: number): ImageAsset => ({ mime: "image/jpeg", base64: "A".repeat(Math.ceil((bytes * 4) / 3)), width: 10, height: 10 });
const bundle = (overlayBytes: number | null, logo = 0, signature = 0): RxDocumentBundle =>
  ({
    prescriptionId: "x",
    document: {},
    logo: logo ? image(logo) : null,
    signature: signature ? image(signature) : null,
    overlay: overlayBytes === null ? null : { templateVersionId: "v", definition: {}, background: image(overlayBytes) },
  }) as unknown as RxDocumentBundle;

describe("overlay PDF size estimate (Gotenberg 8.40 writes each image about once)", () => {
  it("is zero for built-in pads, which are never refused here", () => {
    expect(estimatedPdfBytes(bundle(null, 400_000))).toBe(0);
    expect(overlayPdfTooLarge(bundle(null, 400_000))).toBe(false);
  });
  it("is the background plus logo plus signature plus a small allowance, not multiplied by pages", () => {
    const e = estimatedPdfBytes(bundle(1_000_000, 500_000, 500_000));
    expect(e).toBeGreaterThanOrEqual(2_000_000);
    expect(e).toBeLessThan(2_000_000 + 2 * 1024 * 1024);
    expect(overlayPdfTooLarge(bundle(1_000_000, 500_000, 500_000))).toBe(false);
  });
  it("refuses beyond the PDF cap with the friendly message", () => {
    expect(overlayPdfTooLarge(bundle(PDF_LIMITS.maxPdfBytes))).toBe(true);
    expect(PDF_TOO_LARGE_MESSAGE).toMatch(/too large for download/);
    expect(PDF_TOO_LARGE_MESSAGE).toMatch(/Print/);
  });
});

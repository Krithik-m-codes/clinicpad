import { describe, expect, it } from "vitest";
import { aspectError, aspectOk, clampCrop, cropRect, paperFromPdfPoints, rotatedSize, targetPixels, UPLOAD_SCALES } from "@/lib/templates/image-geometry";
import { BACKGROUND_LIMITS } from "@/lib/domain/image";

describe("image geometry", () => {
  it("swaps the sides for quarter turns", () => {
    expect(rotatedSize(1000, 1414, 1)).toEqual({ width: 1414, height: 1000 });
    expect(rotatedSize(1000, 1414, -1)).toEqual({ width: 1414, height: 1000 });
    expect(rotatedSize(1000, 1414, 2)).toEqual({ width: 1000, height: 1414 });
  });

  it("crops by fractions, never below one pixel, never more than 45 % per side", () => {
    expect(cropRect(1000, 2000, { top: 0.1, right: 0.05, bottom: 0.1, left: 0.05 })).toEqual({ x: 50, y: 200, width: 900, height: 1600 });
    expect(clampCrop({ top: -1, right: 2, bottom: Number.NaN, left: 0.2 })).toEqual({ top: 0, right: 0.45, bottom: 0, left: 0.2 });
    expect(cropRect(2, 2, { top: 0.45, right: 0.45, bottom: 0.45, left: 0.45 }).width).toBeGreaterThanOrEqual(1);
  });

  it("accepts only upright A-series proportions, with the server's tolerance", () => {
    expect(aspectOk(1654, 2339)).toBe(true);
    expect(aspectOk(1165, 1654)).toBe(true);
    expect(aspectOk(2339, 1654)).toBe(false);
    expect(aspectOk(850, 1100)).toBe(false);
    expect(aspectError(1000, 1000)).toBeGreaterThan(BACKGROUND_LIMITS.aspectTolerance);
  });

  it("produces upload sizes the server accepts", () => {
    for (const paper of ["A4", "A5"] as const) {
      const { width, height } = targetPixels(paper);
      expect(aspectOk(width, height)).toBe(true);
      expect(height).toBeGreaterThanOrEqual(BACKGROUND_LIMITS.minLongSide);
      expect(height).toBeLessThanOrEqual(BACKGROUND_LIMITS.maxLongSide);
    }
  });

  it("every shrink step still produces a size the server accepts", () => {
    for (const paper of ["A4", "A5"] as const) {
      for (const scale of UPLOAD_SCALES) {
        const { width, height } = targetPixels(paper, scale);
        expect(aspectOk(width, height), `${paper} ${scale}`).toBe(true);
        expect(height, `${paper} ${scale}`).toBeGreaterThanOrEqual(BACKGROUND_LIMITS.minLongSide);
      }
    }
  });

  it("recognises A4 and A5 PDF pages, either way up, and nothing else", () => {
    expect(paperFromPdfPoints(595.28, 841.89)).toBe("A4");
    expect(paperFromPdfPoints(841.89, 595.28)).toBe("A4");
    expect(paperFromPdfPoints(419.53, 595.28)).toBe("A5");
    expect(paperFromPdfPoints(612, 792)).toBeNull();
  });
});

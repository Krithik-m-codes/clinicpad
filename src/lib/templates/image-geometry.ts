import { BACKGROUND_LIMITS } from "@/lib/domain/image";
import type { PaperSize } from "@/lib/rx-render/types";

export const A_SERIES_RATIO = BACKGROUND_LIMITS.aspect;
export const ASPECT_TOLERANCE = BACKGROUND_LIMITS.aspectTolerance;
/** The client aims well under the server's 1 MB cap: the background is embedded in every printed document. */
export const TARGET_UPLOAD_BYTES = 600 * 1024;
export const JPEG_QUALITIES = [0.8, 0.7, 0.6, 0.5] as const;

/** Fractions of the (rotated) image to cut from each side. */
export type Crop = { top: number; right: number; bottom: number; left: number };
export const NO_CROP: Crop = { top: 0, right: 0, bottom: 0, left: 0 };

const clamp = (n: number) => (Number.isFinite(n) ? Math.min(0.45, Math.max(0, n)) : 0);

export function clampCrop(c: Crop): Crop {
  return { top: clamp(c.top), right: clamp(c.right), bottom: clamp(c.bottom), left: clamp(c.left) };
}

export function rotatedSize(width: number, height: number, quarterTurns: number): { width: number; height: number } {
  return (((quarterTurns % 4) + 4) % 2) === 0 ? { width, height } : { width: height, height: width };
}

export function cropRect(width: number, height: number, crop: Crop): { x: number; y: number; width: number; height: number } {
  const c = clampCrop(crop);
  return {
    x: Math.round(width * c.left),
    y: Math.round(height * c.top),
    width: Math.max(1, Math.round(width * (1 - c.left - c.right))),
    height: Math.max(1, Math.round(height * (1 - c.top - c.bottom))),
  };
}

/** |height / width - sqrt 2| (the server's own measure); landscape and degenerate sizes count as far off (1). */
export function aspectError(width: number, height: number): number {
  if (!(width > 0) || !(height > 0) || width > height) return 1;
  return Math.abs(height / width - A_SERIES_RATIO);
}

export function aspectOk(width: number, height: number): boolean {
  return aspectError(width, height) <= ASPECT_TOLERANCE;
}

/** About 200 dpi: sharp on paper, small enough to embed in every print. */
export function targetPixels(paper: PaperSize, scale = 1): { width: number; height: number } {
  const full = paper === "A4" ? { width: 1654, height: 2339 } : { width: 1165, height: 1654 };
  return { width: Math.round(full.width * scale), height: Math.round(full.height * scale) };
}

/** Sizes tried in turn when a busy photo does not fit the 1 MB cap at the first one (the server needs at least 1,100 px on the long side). */
export const UPLOAD_SCALES = [1, 0.85, 0.75] as const;

const near = (a: number, b: number) => Math.abs(a - b) / b <= 0.02;

/** A4 (595 x 842 pt) or A5 (420 x 595 pt), either orientation; anything else (Letter, legal, custom) is null. */
export function paperFromPdfPoints(widthPt: number, heightPt: number): PaperSize | null {
  const short = Math.min(widthPt, heightPt);
  const long = Math.max(widthPt, heightPt);
  if (near(short, 595.28) && near(long, 841.89)) return "A4";
  if (near(short, 419.53) && near(long, 595.28)) return "A5";
  return null;
}

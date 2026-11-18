import { BACKGROUND_LIMITS } from "@/lib/domain/image";
import type { PaperSize } from "@/lib/rx-render/types";
import { cropRect, downscaleTarget, JPEG_QUALITIES, rotatedSize, targetPixels, TARGET_UPLOAD_BYTES, UPLOAD_SCALES, type Crop } from "./image-geometry";

/** The long side of the small bitmap the fit preview is drawn from. */
const PREVIEW_LONG_SIDE = 1000;

/** A copy of `bitmap` shrunk to `size` (the source is left open); the caller closes the result. */
async function shrunk(bitmap: ImageBitmap, size: { width: number; height: number }): Promise<ImageBitmap> {
  return createImageBitmap(bitmap, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "high", imageOrientation: "none" });
}

/**
 * Decodes an image, applying its EXIF orientation (phone photos), and shrinks it once to at most 3,600 px on the long
 * side: a 48 MP photo would otherwise exceed the canvas area limit of older iPhones (about 16.7 MP) in the preview and
 * the upload. The caller closes the bitmap when it replaces or drops it. Browser only.
 */
export async function loadBitmap(blob: Blob): Promise<ImageBitmap> {
  const full = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const target = downscaleTarget(full.width, full.height);
  if (!target) return full;
  try {
    return await shrunk(full, target);
  } finally {
    full.close();
  }
}

/** A small bitmap to draw the fit preview from (null when the image is already small or the browser cannot resize); the caller closes it. */
export async function loadPreviewBitmap(bitmap: ImageBitmap): Promise<ImageBitmap | null> {
  const target = downscaleTarget(bitmap.width, bitmap.height, PREVIEW_LONG_SIDE);
  if (!target || typeof createImageBitmap !== "function") return null;
  try {
    return await shrunk(bitmap, target);
  } catch {
    return null;
  }
}

/** Rotates by quarter turns, crops, and scales into a canvas of exactly `target` pixels on a white background. */
export function drawFitted(bitmap: ImageBitmap, crop: Crop, quarterTurns: number, target: { width: number; height: number }): HTMLCanvasElement {
  const turns = ((quarterTurns % 4) + 4) % 4;
  const rotated = rotatedSize(bitmap.width, bitmap.height, turns);
  const stage = document.createElement("canvas");
  stage.width = rotated.width;
  stage.height = rotated.height;
  const s = stage.getContext("2d");
  if (!s) throw new Error("canvas unavailable");
  s.translate(rotated.width / 2, rotated.height / 2);
  s.rotate((turns * Math.PI) / 2);
  s.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  const r = cropRect(rotated.width, rotated.height, crop);
  const out = document.createElement("canvas");
  out.width = target.width;
  out.height = target.height;
  const o = out.getContext("2d");
  if (!o) throw new Error("canvas unavailable");
  o.fillStyle = "#ffffff";
  o.fillRect(0, 0, out.width, out.height);
  o.imageSmoothingQuality = "high";
  o.drawImage(stage, r.x, r.y, r.width, r.height, 0, 0, out.width, out.height);
  return out;
}

/** Average darkness of `strips` horizontal strips, top to bottom (0 white, 1 black), for autoLayout. */
export function rowDarkness(canvas: HTMLCanvasElement, strips = 100): number[] {
  const small = document.createElement("canvas");
  small.width = 40;
  small.height = strips;
  const ctx = small.getContext("2d");
  if (!ctx) return [];
  ctx.drawImage(canvas, 0, 0, small.width, small.height);
  const { data } = ctx.getImageData(0, 0, small.width, small.height);
  return Array.from({ length: strips }, (_, y) => {
    let sum = 0;
    for (let x = 0; x < small.width; x += 1) {
      const i = (y * small.width + x) * 4;
      sum += 1 - (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    }
    return sum / small.width;
  });
}

/** A JPEG at the first quality that fits the 600 KB target, or the smallest one under the server's 1 MB cap; null if none fits. */
export async function encodeForUpload(canvas: HTMLCanvasElement): Promise<Blob | null> {
  let best: Blob | null = null;
  for (const quality of JPEG_QUALITIES) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) continue;
    if (blob.size <= TARGET_UPLOAD_BYTES) return blob;
    if (!best || blob.size < best.size) best = blob;
  }
  return best && best.size <= BACKGROUND_LIMITS.maxBytes ? best : null;
}

export type UploadImage = { blob: Blob; darkness: number[] };

/** The cropped, rotated pad as a JPEG the server accepts (shrinking in steps for busy photos), plus its row darkness for auto-layout. */
export async function buildUploadImage(bitmap: ImageBitmap, crop: Crop, quarterTurns: number, paper: PaperSize): Promise<UploadImage | null> {
  let darkness: number[] | null = null;
  for (const scale of UPLOAD_SCALES) {
    const canvas = drawFitted(bitmap, crop, quarterTurns, targetPixels(paper, scale));
    darkness ??= rowDarkness(canvas);
    const blob = await encodeForUpload(canvas);
    if (blob) return { blob, darkness };
  }
  return null;
}

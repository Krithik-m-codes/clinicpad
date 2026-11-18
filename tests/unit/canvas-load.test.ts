import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBitmap, loadPreviewBitmap } from "@/lib/templates/canvas";

const bitmap = (width: number, height: number) => ({ width, height, close: vi.fn() });
afterEach(() => vi.unstubAllGlobals());

describe("loadBitmap (photos are decoded once and shrunk to at most 3,600 px)", () => {
  it("keeps a small image as decoded, applying the EXIF orientation", async () => {
    const small = bitmap(3000, 2000);
    const create = vi.fn(async () => small);
    vi.stubGlobal("createImageBitmap", create);
    const blob = new Blob([new Uint8Array(4)]);
    expect(await loadBitmap(blob)).toBe(small);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(blob, { imageOrientation: "from-image" });
    expect(small.close).not.toHaveBeenCalled();
  });

  it("shrinks a 48 MP photo to 3,600 px on the long side and closes the full-size bitmap", async () => {
    const full = bitmap(8000, 6000);
    const shrunk = bitmap(3600, 2700);
    const create = vi.fn(async (source: unknown) => (source instanceof Blob ? full : shrunk));
    vi.stubGlobal("createImageBitmap", create);
    expect(await loadBitmap(new Blob([new Uint8Array(4)]))).toBe(shrunk);
    expect(create).toHaveBeenLastCalledWith(full, { resizeWidth: 3600, resizeHeight: 2700, resizeQuality: "high", imageOrientation: "none" });
    expect(full.close).toHaveBeenCalledTimes(1);
  });

  it("closes the full-size bitmap even when shrinking fails", async () => {
    const full = bitmap(8000, 6000);
    vi.stubGlobal("createImageBitmap", vi.fn(async (source: unknown) => (source instanceof Blob ? full : Promise.reject(new Error("out of memory")))));
    await expect(loadBitmap(new Blob([new Uint8Array(4)]))).rejects.toThrow("out of memory");
    expect(full.close).toHaveBeenCalledTimes(1);
  });

  it("makes a preview bitmap only when the image is larger than the preview needs", async () => {
    const small = bitmap(800, 1000);
    const preview = bitmap(707, 1000);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => preview));
    expect(await loadPreviewBitmap(small as unknown as ImageBitmap)).toBeNull();
    expect(await loadPreviewBitmap(bitmap(3600, 5091) as unknown as ImageBitmap)).toBe(preview);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => Promise.reject(new Error("no"))));
    expect(await loadPreviewBitmap(bitmap(3600, 5091) as unknown as ImageBitmap)).toBeNull();
  });
});

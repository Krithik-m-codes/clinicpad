"use client";

import { useEffect, useRef, useState } from "react";
import type { PaperSize } from "@/lib/rx-render/types";
import { drawFitted, loadPreviewBitmap } from "@/lib/templates/canvas";
import { aspectError, aspectOk, ASPECT_TOLERANCE, A_SERIES_RATIO, cropRect, NO_CROP, rotatedSize, type Crop } from "@/lib/templates/image-geometry";
import { Button } from "@/components/ui/button";
import { StepHeading } from "./step-heading";

export type Fitted = { paper: PaperSize; crop: Crop; turns: number };

const SIDES: (keyof Crop)[] = ["top", "bottom", "left", "right"];
const PREVIEW_WIDTH = 320;

export type PdfPages = { pageCount: number; page: number };
type Props = {
  bitmap: ImageBitmap;
  proposedPaper: PaperSize;
  warning?: string;
  pdf?: PdfPages;
  onPage: (page: number) => void;
  onFitted: (f: Fitted) => void;
  onBack: () => void;
  busy: boolean;
  busyLabel: string;
};

export function FitStep({ bitmap, proposedPaper, warning, pdf, onPage, onFitted, onBack, busy, busyLabel }: Props) {
  const [crop, setCrop] = useState<Crop>(NO_CROP);
  const [turns, setTurns] = useState(0);
  const [paper, setPaper] = useState<PaperSize>(proposedPaper);
  const preview = useRef<HTMLCanvasElement>(null);
  // The preview is drawn from a small copy of the image; a full-size photo made the canvas work needlessly heavy.
  const [small, setSmall] = useState<{ source: ImageBitmap; bitmap: ImageBitmap } | null>(null);
  const [drawError, setDrawError] = useState(false);
  const rotated = rotatedSize(bitmap.width, bitmap.height, turns);
  const cut = cropRect(rotated.width, rotated.height, crop);
  const ok = aspectOk(cut.width, cut.height);
  const offPercent = Math.round((aspectError(cut.width, cut.height) / A_SERIES_RATIO) * 100);
  const allowedPercent = Math.round((ASPECT_TOLERANCE / A_SERIES_RATIO) * 100);

  useEffect(() => {
    let alive = true;
    let made: ImageBitmap | null = null;
    void loadPreviewBitmap(bitmap).then((b) => {
      if (!b) return;
      if (!alive) return b.close();
      made = b;
      setSmall({ source: bitmap, bitmap: b });
    });
    return () => {
      alive = false;
      made?.close();
    };
  }, [bitmap]);

  const from = small && small.source === bitmap ? small.bitmap : bitmap;
  useEffect(() => {
    const target = preview.current;
    if (!target) return;
    try {
      const drawn = drawFitted(from, crop, turns, { width: PREVIEW_WIDTH, height: Math.max(1, Math.round((PREVIEW_WIDTH * cut.height) / cut.width)) });
      target.width = drawn.width;
      target.height = drawn.height;
      target.getContext("2d")?.drawImage(drawn, 0, 0);
      setDrawError(false);
    } catch {
      setDrawError(true); // e.g. a canvas the browser refuses to allocate; never an uncaught throw into the error boundary
    }
  }, [from, crop, turns, cut.width, cut.height]);

  const message = ok
    ? "The proportions fit an A4 or A5 pad."
    : rotated.width > rotated.height
      ? "Rotate the image so the pad stands upright."
      : `Crop to the pad edges: the proportions are about ${offPercent} % away from A4 or A5 (at most ${allowedPercent} % allowed).`;

  return (
    <div className="space-y-4">
      <StepHeading>Fit the pad</StepHeading>
      {warning ? <p className="text-sm text-amber-700 dark:text-amber-400">{warning}</p> : null}
      {drawError ? <p className="text-sm text-destructive">The preview could not be drawn in this browser. Try a smaller image, or go back and choose another file.</p> : null}
      {pdf && pdf.pageCount > 1 ? (
        <label className="block space-y-1 text-sm">
          <span className="font-medium">The pad is on page</span>
          <select value={pdf.page} onChange={(e) => onPage(Number(e.target.value))} disabled={busy} className="block rounded border p-1">
            {Array.from({ length: pdf.pageCount }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1} of {pdf.pageCount}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <canvas ref={preview} role="img" aria-label="Preview of the cropped pad" className="mx-auto block h-auto max-h-[60vh] w-auto max-w-full border shadow" />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => setTurns((t) => t - 1)}>
          Rotate left
        </Button>
        <Button type="button" variant="outline" onClick={() => setTurns((t) => t + 1)}>
          Rotate right
        </Button>
      </div>
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="font-medium">Crop to the edges of the pad</legend>
        {SIDES.map((side) => (
          <label key={side} className="flex items-center gap-2 text-sm">
            <span className="w-14 capitalize">{side}</span>
            <input
              type="range"
              min={0}
              max={45}
              step={0.5}
              value={crop[side] * 100}
              onChange={(e) => setCrop((c) => ({ ...c, [side]: Number(e.target.value) / 100 }))}
              aria-label={`Crop ${side}`}
              aria-valuetext={`${Math.round(crop[side] * 1000) / 10} percent`}
              className="min-w-0 flex-1"
            />
          </label>
        ))}
      </fieldset>
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Paper size of this pad</span>
        <select value={paper} onChange={(e) => setPaper(e.target.value === "A5" ? "A5" : "A4")} className="block rounded border p-1">
          <option value="A4">A4 (210 × 297 mm)</option>
          <option value="A5">A5 (148 × 210 mm)</option>
        </select>
      </label>
      <p role="status" aria-live="polite" className={ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>
        {message}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={onBack} disabled={busy}>
          Choose another file
        </Button>
        <Button type="button" disabled={!ok || busy} onClick={() => onFitted({ paper, crop, turns })}>
          {busy ? busyLabel : "Continue"}
        </Button>
      </div>
    </div>
  );
}

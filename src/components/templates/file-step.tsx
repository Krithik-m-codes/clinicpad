"use client";

import { Button } from "@/components/ui/button";

export const IMAGE_LIMIT = 15 * 1024 * 1024; // before the browser shrinks it; the upload itself is at most 1 MB

type Props = { kind: "image" | "pdf"; busy: boolean; showFallback: boolean; onFile: (file: File) => void; onUseImage: () => void };

/** Picks a file; the wizard reads it. Never shows or sends the file's name: it is not needed and may be hostile. */
export function FileStep({ kind, busy, showFallback, onFile, onUseImage }: Props) {
  return (
    <div className="space-y-3">
      <label className="block space-y-1">
        <span className="font-medium">{kind === "image" ? "Choose the photo or scan" : "Choose the PDF"}</span>
        <input
          type="file"
          accept={kind === "image" ? "image/png,image/jpeg" : "application/pdf"}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
          }}
          disabled={busy}
          aria-describedby="file-step-status"
          className="block w-full text-sm"
        />
      </label>
      <div id="file-step-status" role="status" aria-live="polite" className="space-y-2 text-sm">
        {busy ? <p>Reading the file…</p> : null}
        {showFallback && kind === "pdf" ? (
          <Button type="button" variant="outline" size="sm" onClick={onUseImage}>
            Use a photo or image instead
          </Button>
        ) : null}
      </div>
    </div>
  );
}

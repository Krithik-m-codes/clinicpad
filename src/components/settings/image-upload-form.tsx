"use client";

import { useActionState, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IMAGE_LIMITS } from "@/lib/domain/image";
import type { SettingsFormState } from "@/server/actions/settings";
import type { AssetPreview } from "@/server/services/assets";

type Props = {
  label: string;
  hint: string;
  current: AssetPreview | null;
  upload: (prev: SettingsFormState, formData: FormData) => Promise<SettingsFormState>;
  remove: () => Promise<SettingsFormState>;
};

/**
 * Quick checks before upload. The server decides from the bytes; this only saves a round trip, and keeps
 * a too-large file from hitting the framework's request body limit (which gives an unfriendly error).
 */
export function checkImageFile(file: { size: number; type: string }): string | null {
  if (file.type !== "image/png" && file.type !== "image/jpeg") return "Choose a PNG or JPEG image.";
  if (file.size > IMAGE_LIMITS.maxBytes) return `The image is larger than ${IMAGE_LIMITS.maxBytes / 1024} KB.`;
  return null;
}

export function ImageUploadForm({ label, hint, current, upload, remove }: Props) {
  const [state, uploadAction, uploading] = useActionState(upload, {} as SettingsFormState);
  const [removeState, removeAction, removing] = useActionState(
    (_prev: SettingsFormState) => remove(),
    {} as SettingsFormState,
  );
  const [clientError, setClientError] = useState<string | null>(null);
  const inputId = useId();
  const error = clientError ?? state.error ?? removeState.error ?? null;

  return (
    <div className="space-y-3">
      <form action={uploadAction} className="space-y-2">
        <Label htmlFor={inputId}>{label}</Label>
        <Input
          id={inputId}
          name="image"
          type="file"
          accept="image/png,image/jpeg"
          onChange={(event) => {
            const file = event.target.files?.[0];
            setClientError(file ? checkImageFile(file) : null);
          }}
        />
        <p className="text-xs text-muted-foreground">{hint}</p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {state.saved && !error ? (
          <p role="status" className="text-sm text-muted-foreground">
            Image saved.
          </p>
        ) : null}
        <Button type="submit" variant="outline" disabled={uploading || clientError !== null}>
          {uploading ? "Uploading…" : "Upload"}
        </Button>
      </form>

      {current ? (
        <div className="flex items-center gap-4 rounded-md border p-3">
          {/* A data: URL from our own asset store; next/image adds nothing here. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={current.dataUrl}
            alt={`Current ${label.toLowerCase()}`}
            width={current.width}
            height={current.height}
            className="max-h-16 w-auto"
          />
          <form action={removeAction}>
            <Button type="submit" variant="ghost" disabled={removing}>
              Remove
            </Button>
          </form>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No image yet.</p>
      )}
    </div>
  );
}

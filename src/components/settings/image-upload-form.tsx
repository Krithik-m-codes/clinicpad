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

type Status = { kind: "error" | "saved" | "removed"; text: string; client?: boolean };

export function ImageUploadForm({ label, hint, current, upload, remove }: Props) {
  // One source of truth for what the user sees: the latest client check, upload result, or removal result.
  const [status, setStatus] = useState<Status | null>(null);
  const [, uploadAction, uploading] = useActionState(async (prev: SettingsFormState, formData: FormData) => {
    const result = await upload(prev, formData);
    setStatus(result.error ? { kind: "error", text: result.error } : { kind: "saved", text: "Image saved." });
    return result;
  }, {} as SettingsFormState);
  const [, removeAction, removing] = useActionState(async () => {
    const result = await remove();
    setStatus(result.error ? { kind: "error", text: result.error } : { kind: "removed", text: "Image removed." });
    return result;
  }, {} as SettingsFormState);
  const inputId = useId();
  const messageId = `${inputId}-message`;
  const error = status?.kind === "error" ? status.text : null;

  return (
    <div className="space-y-3">
      <form action={uploadAction} className="space-y-2">
        <Label htmlFor={inputId}>{label}</Label>
        <Input
          id={inputId}
          name="image"
          type="file"
          accept="image/png,image/jpeg"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? messageId : undefined}
          onChange={(event) => {
            // A new file clears whatever the last attempt said, from the client or the server.
            const file = event.target.files?.[0];
            const problem = file ? checkImageFile(file) : null;
            setStatus(problem ? { kind: "error", text: problem, client: true } : null);
          }}
        />
        <p className="text-xs text-muted-foreground">{hint}</p>
        {error ? (
          <p id={messageId} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {status && status.kind !== "error" ? (
          <p role="status" className="text-sm text-muted-foreground">
            {status.text}
          </p>
        ) : null}
        <Button type="submit" variant="outline" disabled={uploading || status?.client === true}>
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

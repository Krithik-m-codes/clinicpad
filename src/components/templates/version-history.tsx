"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { rollbackTemplateAction } from "@/server/actions/templates";
import { Button } from "@/components/ui/button";

type Version = { versionId: string; version: number; publishedAt: string };
type Props = { templateId: string; currentVersionId: string | null; versions: Version[]; canPublish: boolean; /** An open draft would be replaced by publishing an older version again: do it from the pad list, not inside the editor. */ hasDraft?: boolean };

/**
 * Published versions, newest first. Publishing an older one again makes a new version (history is never rewritten) and
 * shows the same refusals as publishing: a bound pad that is the clinic default, or one another doctor uses.
 */
export function VersionHistory({ templateId, currentVersionId, versions, canPublish, hasDraft = false }: Props) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (versions.length === 0) return null;

  async function again(v: Version) {
    setBusy(true);
    const result = await rollbackTemplateAction(templateId, v.versionId);
    setBusy(false);
    const issues = result.issues && result.issues.length > 0 ? ` ${result.issues.join(" ")}` : "";
    setMessage(result.ok ? `Version ${v.version} is published again as a new version.` : `${result.error ?? "Could not publish it again."}${issues}`);
    if (result.ok) router.refresh();
  }

  return (
    <section aria-label="Versions" className="space-y-2 rounded-md border p-3 text-sm">
      <h2 className="font-medium">Published versions</h2>
      <ul className="space-y-1">
        {versions.map((v) => (
          <li key={v.versionId} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              Version {v.version} · {new Date(v.publishedAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}
              {v.versionId === currentVersionId ? " (current)" : ""}
            </span>
            <span className="flex gap-2">
              <Button asChild variant="outline" size="sm">
                <a href={`/templates/${templateId}/preview?sample=short&version=${v.versionId}`} target="_blank" rel="noopener noreferrer">
                  Preview version {v.version}
                </a>
              </Button>
              {canPublish && !hasDraft && v.versionId !== currentVersionId ? (
                <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void again(v)}>
                  Publish version {v.version} again
                </Button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {hasDraft && canPublish ? <p className="text-xs text-muted-foreground">There is an open draft. Publish or discard it before publishing an older version again.</p> : null}
      <p role="status" aria-live="polite">
        {message}
      </p>
    </section>
  );
}

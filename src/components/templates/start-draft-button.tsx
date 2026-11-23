"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { startTemplateDraftAction } from "@/server/actions/templates";
import { Button } from "@/components/ui/button";

/** "Edit this pad": starts a draft from the published version; shows the reason when it cannot. */
export function StartDraftButton({ templateId }: { templateId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setMessage(null);
    const result = await startTemplateDraftAction(templateId);
    setBusy(false);
    if (result.ok) router.refresh();
    else setMessage(result.error ?? "Could not start editing.");
  }

  return (
    <div className="space-y-2">
      <Button type="button" onClick={() => void start()} disabled={busy}>
        {busy ? "Starting…" : "Edit this pad"}
      </Button>
      <p role="status" aria-live="polite" className="text-sm text-destructive">
        {message}
      </p>
    </div>
  );
}

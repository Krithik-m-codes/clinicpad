"use client";

import { useState, useTransition } from "react";
import { archiveTemplateAction, unarchiveTemplateAction } from "@/server/actions/templates";
import { Button } from "@/components/ui/button";

export function TemplateRowActions({ templateId, archived, inUse }: { templateId: string; archived: boolean; inUse: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const blocked = !archived && inUse;
  const run = () =>
    start(async () => {
      try {
        const result = archived ? await unarchiveTemplateAction(templateId) : await archiveTemplateAction(templateId);
        setError(result.error ?? null);
      } catch {
        setError("This could not be done. Check the connection and try again.");
      }
    });
  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" variant="outline" size="sm" onClick={run} disabled={pending || blocked} aria-describedby={blocked ? `${templateId}-why` : undefined}>
        {archived ? "Restore" : "Archive"}
      </Button>
      {blocked ? (
        <p id={`${templateId}-why`} className="max-w-48 text-right text-xs text-muted-foreground">
          Choose another pad for the clinic and its doctors first.
        </p>
      ) : null}
      <p role="status" aria-live="polite" className="text-xs text-destructive">
        {error}
      </p>
    </div>
  );
}

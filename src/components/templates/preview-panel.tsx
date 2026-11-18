"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useEditorDirty } from "./editor-dirty";

type Props = { templateId: string; versionId: string | null; prescriptions: { id: string; label: string }[]; disabled?: boolean };

function href(templateId: string, query: Record<string, string>, versionId: string | null): string {
  const params = new URLSearchParams(versionId ? { ...query, version: versionId } : query);
  return `/templates/${templateId}/preview?${params.toString()}`;
}

/** Opens previews in a new tab (spec section 10.1 step 5). Real-patient previews are audited by the server; designers get no patient list. */
export function PreviewPanel({ templateId, versionId, prescriptions, disabled = false }: Props) {
  const [rx, setRx] = useState("");
  const dirty = useEditorDirty();
  const off = disabled || dirty;
  const link = (label: string, query: Record<string, string>) => (
    <Button asChild variant="outline" size="sm" key={label}>
      <a href={off ? undefined : href(templateId, query, versionId)} target="_blank" rel="noopener noreferrer" aria-disabled={off}>
        {label}
      </a>
    </Button>
  );
  return (
    <section aria-label="Preview" className="space-y-3 rounded-md border p-3 text-sm">
      <h2 className="font-medium">Preview</h2>
      {off ? <p>Save the draft to preview your changes.</p> : null}
      <p className="text-muted-foreground">Sample previews are marked SAMPLE and show a placeholder doctor.</p>
      <div className="flex flex-wrap gap-2">
        {link("3 medicines", { sample: "short" })}
        {link("12 medicines (page 2)", { sample: "long" })}
        {link("Blank pad", { sample: "blank" })}
        {link("12 medicines as PDF", { sample: "long", format: "pdf" })}
      </div>
      {prescriptions.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col">
            With a real patient (shown as a draft; recorded in the audit log)
            <select value={rx} onChange={(e) => setRx(e.target.value)} className="rounded border p-1">
              <option value="">Choose a recent prescription</option>
              {prescriptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {rx ? link("Preview with this patient", { prescriptionId: rx }) : null}
        </div>
      ) : null}
    </section>
  );
}

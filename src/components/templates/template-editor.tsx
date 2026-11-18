"use client";

import "@fontsource/noto-sans-devanagari/400.css";
import "@fontsource/noto-sans-devanagari/700.css";
import { useEffect, useMemo, useReducer, useState } from "react";
import { useRouter } from "next/navigation";
import { BOX_FIELD_KEYS, TEMPLATE_FIELDS, type BoxFieldKey } from "@/lib/rx-render/fields";
import { overlayGeometryIssues, type OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import type { LabelLanguage, PaperSize } from "@/lib/rx-render/types";
import { boxLimitReason, editorReducer, initialEditorState } from "@/lib/templates/editor-state";
import { discardTemplateDraftAction, saveTemplateDraftAction } from "@/server/actions/templates";
import { Button } from "@/components/ui/button";
import { BoxCanvas } from "./box-canvas";
import { BoxInspector } from "./box-inspector";
import { FlowInspector } from "./flow-inspector";
import { useOverflowWarnings } from "./use-overflow-warnings";

type Props = {
  templateId: string;
  name: string;
  fileId: string;
  paper: PaperSize;
  labels: LabelLanguage;
  definition: OverlayDefinition;
  revision: number;
  /** Preview, publish and assign panels (Task 18), shown under the editor; they read only saved drafts. */
  children?: React.ReactNode;
};

export function TemplateEditor({ templateId, name, fileId, paper, labels: initialLabels, definition, revision: initialRevision, children }: Props) {
  const router = useRouter();
  const [state, dispatch] = useReducer(editorReducer, undefined, () => initialEditorState(definition, paper));
  const [labels, setLabels] = useState(initialLabels);
  const [labelsDirty, setLabelsDirty] = useState(false);
  const [revision, setRevision] = useState(initialRevision);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [addField, setAddField] = useState<BoxFieldKey>("doctor.name");
  const warnings = useOverflowWarnings(state.definition, labels);
  // The server's own rule (placement, body size, and the effective-page spacer limit of override 21a); never re-implemented here.
  const issues = useMemo(() => overlayGeometryIssues(state.definition, paper), [state.definition, paper]);
  const dirty = state.dirty || labelsDirty;
  const selected = state.definition.boxes.find((b) => b.id === state.selected) ?? null;
  const addBlocked = boxLimitReason(state.definition.boxes, addField);
  const position = selected ? `${TEMPLATE_FIELDS[selected.field].en}: ${selected.xMm} by ${selected.yMm} mm, ${selected.wMm} by ${selected.hMm} mm.` : "";

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function save() {
    setSaving(true);
    setMessage(null);
    setConflict(false);
    const result = await saveTemplateDraftAction(templateId, { definition: state.definition, labels, baseRevision: revision });
    setSaving(false);
    if (result.ok && typeof result.revision === "number") {
      setRevision(result.revision);
      dispatch({ type: "saved" });
      setLabelsDirty(false);
      setMessage("Saved.");
      router.refresh();
    } else if (result.currentRevision !== undefined) {
      setConflict(true);
      setMessage(`${result.error ?? "This pad was changed in another window."} (Reload the page.)`);
    } else {
      setMessage(result.error ?? "Could not save.");
    }
  }

  async function discard() {
    const result = await discardTemplateDraftAction(templateId);
    if (result.ok) router.push("/templates");
    else {
      setConfirmDiscard(false);
      setMessage(result.error ?? "Could not discard the draft.");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{name}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => void save()} disabled={saving || !dirty || issues.length > 0} aria-describedby={issues.length > 0 ? "box-issues" : undefined}>
            {saving ? "Saving…" : dirty ? "Save draft" : "Saved"}
          </Button>
          {confirmDiscard ? (
            <>
              <span className="text-sm">Throw away this draft?</span>
              <Button type="button" variant="destructive" onClick={() => void discard()}>
                Yes, discard
              </Button>
              <Button type="button" variant="outline" onClick={() => setConfirmDiscard(false)}>
                Keep editing
              </Button>
            </>
          ) : (
            <Button type="button" variant="outline" onClick={() => setConfirmDiscard(true)}>
              Discard draft
            </Button>
          )}
        </div>
      </div>
      <p role="status" aria-live="polite" className="text-sm">
        {message}
        {conflict ? (
          <>
            {" "}
            <Button type="button" variant="link" className="h-auto p-0" onClick={() => window.location.reload()}>
              Reload now
            </Button>
          </>
        ) : null}
      </p>
      <p aria-live="polite" className="sr-only" data-testid="box-position">
        {position}
      </p>
      <p id="box-keys-help" className="text-xs text-muted-foreground">
        Drag a box, or Tab to it and use the arrow keys (1 mm; hold Shift for 5 mm; hold Alt to resize). Delete removes the box, Escape leaves it.
      </p>
      {issues.length > 0 ? (
        <section id="box-issues" aria-label="Fix before saving" className="rounded-md border border-destructive p-3 text-sm">
          <p className="font-medium">Fix these before you can save:</p>
          <ul className="list-disc pl-5">
            {issues.map((issue) => (
              <li key={`${issue.path}-${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <BoxCanvas fileId={fileId} paper={paper} definition={state.definition} selected={state.selected} warnings={warnings} dispatch={dispatch} />
        <div className="space-y-4">
          <div className="flex items-end gap-2">
            <label className="flex flex-1 flex-col text-xs">
              Add a box for
              <select value={addField} onChange={(e) => setAddField(e.target.value as BoxFieldKey)} className="rounded border p-1">
                {BOX_FIELD_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {TEMPLATE_FIELDS[k].en}
                  </option>
                ))}
              </select>
            </label>
            <Button type="button" variant="outline" disabled={addBlocked !== null} onClick={() => dispatch({ type: "add", field: addField })}>
              Add
            </Button>
          </div>
          {addBlocked ? <p className="text-xs text-muted-foreground">{addBlocked}</p> : null}
          {selected ? (
            <BoxInspector box={selected} others={state.definition.boxes.filter((b) => b.id !== selected.id)} warn={warnings.has(selected.id)} dispatch={dispatch} />
          ) : (
            <p className="text-sm text-muted-foreground">Select a box to change it, or drag it on the pad.</p>
          )}
          <FlowInspector
            definition={state.definition}
            labels={labels}
            onLabels={(l) => {
              setLabels(l);
              setLabelsDirty(true);
            }}
            dispatch={dispatch}
          />
        </div>
      </div>
      {dirty ? <p className="text-sm text-muted-foreground">Save the draft to preview or publish these changes.</p> : null}
      {children}
    </div>
  );
}

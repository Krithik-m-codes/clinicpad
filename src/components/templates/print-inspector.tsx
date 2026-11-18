"use client";

import { OVERLAY_LIMITS, spacerLimitMm, type OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import type { PaperSize } from "@/lib/rx-render/types";
import type { EditorAction } from "@/lib/templates/editor-state";
import { PRINT_PDF_HINT } from "@/lib/templates/print-support";
import { NumberField } from "./number-field";

type Props = { templateId: string; paper: PaperSize; definition: OverlayDefinition; dirty: boolean; dispatch: (a: EditorAction) => void };


/** Pre-printed stationery (decision 12): paper prints only the data; downloads and shares keep the background. */
export function PrintInspector({ templateId, paper, definition, dirty, dispatch }: Props) {
  const preprinted = definition.background.printMode === "pdf_only";
  const offset = definition.printOffsetMm;
  const limit = spacerLimitMm(paper, definition.pageNumbers.bandMm, offset.y);
  const setOffset = (axis: "x" | "y", n: number) => dispatch({ type: "options", patch: { printOffsetMm: { ...offset, [axis]: Math.round(n * 10) / 10 } } });
  return (
    <section aria-label="Printing" className="space-y-3 rounded-md border p-3 text-sm">
      <h2 className="font-medium">Printing</h2>
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={preprinted} onChange={(e) => dispatch({ type: "options", patch: e.target.checked ? { background: { printMode: "pdf_only" } } : { background: { printMode: "always" }, printOffsetMm: { x: 0, y: 0 } } })} />
        <span>We print on our pre-printed pads (print only the data; PDFs sent to patients still show the letterhead)</span>
      </label>
      {preprinted ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <NumberField label="Move right (mm, −10 to 10)" value={offset.x} min={-OVERLAY_LIMITS.maxOffsetMm} max={OVERLAY_LIMITS.maxOffsetMm} onValue={(n) => setOffset("x", n)} />
            <NumberField label="Move down (mm, −10 to 10)" value={offset.y} min={-OVERLAY_LIMITS.maxOffsetMm} max={OVERLAY_LIMITS.maxOffsetMm} onValue={(n) => setOffset("y", n)} />
          </div>
          <p className="text-xs text-muted-foreground">
            The space above and below the body, plus the move down, can be at most {limit} mm each. Printing moves everything by this adjustment. A new adjustment applies to
            prescriptions finalized after you publish it; earlier ones keep the adjustment of the pad version they were finalized on.
          </p>
          <p className="text-xs text-muted-foreground">{PRINT_PDF_HINT}</p>
          {dirty ? (
            <p className="text-xs">Save the draft, then print the alignment check.</p>
          ) : (
            <a className="text-xs underline" href={`/templates/${templateId}/alignment`} target="_blank" rel="noopener noreferrer">
              Print the alignment check on one of your pads
            </a>
          )}
        </>
      ) : null}
    </section>
  );
}

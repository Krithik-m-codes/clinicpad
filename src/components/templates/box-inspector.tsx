"use client";

import { BOX_FIELD_KEYS, TEMPLATE_FIELDS, type BoxFieldKey } from "@/lib/rx-render/fields";
import type { OverlayBox } from "@/lib/rx-render/overlay-definition";
import { boxLimitReason, type EditorAction } from "@/lib/templates/editor-state";
import { OVERLAY_LIMITS } from "@/lib/rx-render/overlay-definition";
import { Button } from "@/components/ui/button";
import { NumberField } from "./number-field";

const GROUPS = ["patient", "visit", "doctor", "clinic", "vitals", "clinical"] as const;

type Props = { box: OverlayBox; others: readonly OverlayBox[]; warn: boolean; dispatch: (a: EditorAction) => void };

export function BoxInspector({ box, others, warn, dispatch }: Props) {
  const set = (patch: Partial<OverlayBox>) => dispatch({ type: "set", id: box.id, patch });
  const length = (key: "xMm" | "yMm" | "wMm" | "hMm", label: string, min: number) => <NumberField label={label} value={box[key]} min={min} onValue={(n) => set({ [key]: n })} />;
  return (
    <section aria-label="Selected box" className="space-y-3 rounded-md border p-3">
      <label className="flex flex-col text-sm">
        Prints
        <select value={box.field} onChange={(e) => set({ field: e.target.value as BoxFieldKey })} className="rounded border p-1">
          {GROUPS.map((group) => (
            <optgroup key={group} label={group[0].toUpperCase() + group.slice(1)}>
              {BOX_FIELD_KEYS.filter((k) => TEMPLATE_FIELDS[k].group === group).map((k) => (
                <option key={k} value={k} disabled={k !== box.field && boxLimitReason(others, k) !== null}>
                  {TEMPLATE_FIELDS[k].en}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-4 gap-2">
        {length("xMm", "Left (mm)", 0)}
        {length("yMm", "Top (mm)", 0)}
        {length("wMm", "Width (mm)", OVERLAY_LIMITS.minBoxMm)}
        {length("hMm", "Height (mm)", OVERLAY_LIMITS.minBoxMm)}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <NumberField label="Size (pt)" value={box.fontPt} min={OVERLAY_LIMITS.minFontPt} max={OVERLAY_LIMITS.maxFontPt} step={0.5} className="w-20 rounded border p-1" onValue={(n) => set({ fontPt: n })} />
        <label className="flex flex-col text-xs">
          Align
          <select value={box.align} onChange={(e) => set({ align: e.target.value === "center" ? "center" : e.target.value === "right" ? "right" : "left" })} className="rounded border p-1">
            <option value="left">Left</option>
            <option value="center">Centre</option>
            <option value="right">Right</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={box.bold} onChange={(e) => set({ bold: e.target.checked })} /> Bold
        </label>
        <label className="flex flex-col text-xs">
          On
          <select value={box.repeat} onChange={(e) => set({ repeat: e.target.value === "first_page" ? "first_page" : "every_page" })} className="rounded border p-1">
            <option value="every_page">Every page</option>
            <option value="first_page">First page only</option>
          </select>
        </label>
      </div>
      {warn ? <p className="text-xs text-destructive">A long value does not fit this box: it will print past its edge. Make the box bigger or the text smaller.</p> : null}
      <Button type="button" variant="outline" size="sm" onClick={() => dispatch({ type: "remove", id: box.id })}>
        Remove box
      </Button>
    </section>
  );
}

"use client";

import { BOX_FIELD_KEYS, TEMPLATE_FIELDS, type BoxFieldKey } from "@/lib/rx-render/fields";
import type { OverlayBox } from "@/lib/rx-render/overlay-definition";
import { boxLimitReason, type EditorAction } from "@/lib/templates/editor-state";
import { Button } from "@/components/ui/button";

const GROUPS = ["patient", "visit", "doctor", "clinic", "vitals", "clinical"] as const;
const num = (value: string) => (value.trim() === "" ? Number.NaN : Number(value));

type Props = { box: OverlayBox; others: readonly OverlayBox[]; warn: boolean; dispatch: (a: EditorAction) => void };

export function BoxInspector({ box, others, warn, dispatch }: Props) {
  const set = (patch: Partial<OverlayBox>) => dispatch({ type: "set", id: box.id, patch });
  const length = (key: "xMm" | "yMm" | "wMm" | "hMm", label: string) => (
    <label className="flex flex-col text-xs">
      {label}
      <input type="number" step={0.5} value={box[key]} onChange={(e) => Number.isFinite(num(e.target.value)) && set({ [key]: num(e.target.value) })} className="rounded border p-1" />
    </label>
  );
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
        {length("xMm", "Left (mm)")}
        {length("yMm", "Top (mm)")}
        {length("wMm", "Width (mm)")}
        {length("hMm", "Height (mm)")}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs">
          Size (pt)
          <input type="number" min={6} max={24} step={0.5} value={box.fontPt} onChange={(e) => Number.isFinite(num(e.target.value)) && set({ fontPt: num(e.target.value) })} className="w-20 rounded border p-1" />
        </label>
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

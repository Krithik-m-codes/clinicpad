"use client";

import { useEffect, useMemo, useState } from "react";
import type { TextFieldKey } from "@/lib/rx-render/fields";
import type { OverlayBox, OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { SAMPLE_LETTERHEAD, sampleDocument } from "@/lib/rx-render/samples";
import { toTemplateData } from "@/lib/rx-render/template-data";
import type { LabelLanguage } from "@/lib/rx-render/types";

const PX_PER_MM = 96 / 25.4;

/** The ids of boxes whose long sample text does not fit; `measure` answers "does this text overflow this box?". */
export function overflowingBoxes(boxes: readonly OverlayBox[], text: Partial<Record<string, string>>, measure: (box: OverlayBox, value: string) => boolean): Set<string> {
  const out = new Set<string>();
  for (const box of boxes) {
    const value = text[box.field];
    if (typeof value === "string" && value !== "" && measure(box, value)) out.add(box.id);
  }
  return out;
}

/** Long values for every text field: the long sample visit plus the long letterhead and doctor (display only, never printed). */
export function longSampleText(labels: LabelLanguage): Record<TextFieldKey, string> {
  const base = { ...SAMPLE_LETTERHEAD, layout: { ...SAMPLE_LETTERHEAD.layout, labels } };
  const doc = sampleDocument("long", base);
  return toTemplateData({ ...doc, snapshot: { ...doc.snapshot, doctor: SAMPLE_LETTERHEAD.doctor } }, labels).text;
}

/**
 * Live overflow warnings with the long sample (spec section 6.4). The probe uses the renderer's own box CSS (overlay-css:
 * line-height 1.2, overflow-wrap anywhere, white-space pre-line, the embedded Noto Sans Devanagari), so the editor
 * and the print agree on what "does not fit" means.
 */
export function useOverflowWarnings(definition: OverlayDefinition, labels: LabelLanguage): Set<string> {
  const text = useMemo(() => longSampleText(labels), [labels]);
  const [warnings, setWarnings] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    const probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    Object.assign(probe.style, {
      position: "absolute",
      left: "-10000px",
      top: "0",
      visibility: "hidden",
      boxSizing: "content-box",
      fontFamily: '"Noto Sans Devanagari", sans-serif',
      lineHeight: "1.2",
      overflowWrap: "anywhere",
      whiteSpace: "pre-line",
      overflow: "hidden",
    });
    document.body.appendChild(probe);
    const measure = (box: OverlayBox, value: string) => {
      probe.style.width = `${box.wMm * PX_PER_MM}px`;
      probe.style.height = `${box.hMm * PX_PER_MM}px`;
      probe.style.fontSize = `${(box.fontPt * 4) / 3}px`;
      probe.style.fontWeight = box.bold ? "700" : "400";
      probe.textContent = value;
      return probe.scrollHeight > probe.clientHeight + 1 || probe.scrollWidth > probe.clientWidth + 1;
    };
    void document.fonts.ready.then(() => {
      if (!cancelled) setWarnings(overflowingBoxes(definition.boxes, text, measure));
    });
    return () => {
      cancelled = true;
      probe.remove();
    };
  }, [definition.boxes, text]);
  return warnings;
}

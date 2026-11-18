"use client";

import type { LabelLanguage } from "@/lib/rx-render/types";
import { SECTION_KEYS, type OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import type { SectionKey } from "@/lib/rx-render/templates";
import type { EditorAction } from "@/lib/templates/editor-state";

const SECTION_LABELS: Record<SectionKey, string> = {
  vitals: "Vitals",
  chiefComplaint: "Chief complaint",
  complaints: "Complaints",
  medicalHistory: "Medical history",
  drugHistory: "Drug history",
  examination: "Examination",
  diagnosis: "Diagnosis",
  medicines: "Medicines",
  investigations: "Tests",
  advice: "Advice",
  followUp: "Follow-up",
};
const num = (v: string) => (v.trim() === "" ? Number.NaN : Number(v));

type Props = { definition: OverlayDefinition; labels: LabelLanguage; onLabels: (l: LabelLanguage) => void; dispatch: (a: EditorAction) => void };

export function FlowInspector({ definition, labels, onLabels, dispatch }: Props) {
  const flow = definition.flow;
  const inset = (key: "topMm" | "bottomMm" | "leftMm" | "rightMm", label: string) => (
    <label className="flex flex-col text-xs">
      {label}
      <input type="number" step={0.5} value={flow[key]} onChange={(e) => Number.isFinite(num(e.target.value)) && dispatch({ type: "flow", patch: { [key]: num(e.target.value) } })} className="rounded border p-1" />
    </label>
  );
  const toggle = (key: SectionKey, on: boolean) => {
    const next = on ? SECTION_KEYS.filter((k) => k === key || flow.sections.includes(k)) : flow.sections.filter((k) => k !== key);
    if (next.length > 0) dispatch({ type: "flow", patch: { sections: next } });
  };
  const hasSignatureBox = definition.boxes.some((b) => b.field === "doctor.signature");
  return (
    <section aria-label="Prescription body" className="space-y-3 rounded-md border p-3">
      <h2 className="text-sm font-medium">Prescription body (blue area)</h2>
      <div className="grid grid-cols-4 gap-2">
        {inset("topMm", "From top (mm)")}
        {inset("bottomMm", "From bottom (mm)")}
        {inset("leftMm", "From left (mm)")}
        {inset("rightMm", "From right (mm)")}
      </div>
      <label className="flex flex-col text-xs">
        Style of the medicine table
        <select
          value={flow.bodyStyle}
          onChange={(e) => dispatch({ type: "flow", patch: { bodyStyle: e.target.value === "paediatric" ? "paediatric" : e.target.value === "derma" ? "derma" : "general" } })}
          className="rounded border p-1"
        >
          <option value="general">General (morning, noon, evening, night)</option>
          <option value="paediatric">Paediatric (dose and schedule)</option>
          <option value="derma">Dermatology (how to use)</option>
        </select>
      </label>
      <fieldset className="grid grid-cols-2 gap-1 text-xs">
        <legend className="mb-1 font-medium">Print these sections</legend>
        {SECTION_KEYS.map((key) => (
          <label key={key} className="flex items-center gap-1">
            <input type="checkbox" checked={flow.sections.includes(key)} onChange={(e) => toggle(key, e.target.checked)} /> {SECTION_LABELS[key]}
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-1 text-xs">
        <input type="checkbox" checked={flow.showRxMark} onChange={(e) => dispatch({ type: "flow", patch: { showRxMark: e.target.checked } })} /> Print the &#8478; mark
      </label>
      <fieldset className="space-y-1 text-xs">
        <legend className="font-medium">Signature</legend>
        <label className="flex items-center gap-1">
          <input type="radio" name="sig" checked={definition.signature.mode === "end_of_content"} onChange={() => dispatch({ type: "options", patch: { signature: { mode: "end_of_content" } } })} /> After the prescription, with the doctor&apos;s name and
          registration
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" name="sig" checked={definition.signature.mode === "box"} disabled={!hasSignatureBox} onChange={() => dispatch({ type: "options", patch: { signature: { mode: "box" } } })} /> In my
          signature box (add a &ldquo;Signature&rdquo; box first)
        </label>
      </fieldset>
      <label className="flex flex-col text-xs">
        Page numbers
        <select value={definition.pageNumbers.bandMm} onChange={(e) => dispatch({ type: "options", patch: { pageNumbers: { bandMm: Number(e.target.value) } } })} className="rounded border p-1">
          <option value={0}>Off (most pads are one page)</option>
          <option value={8}>On, in a blank 8 mm strip at the bottom</option>
          <option value={12}>On, in a blank 12 mm strip at the bottom</option>
        </select>
      </label>
      <label className="flex flex-col text-xs">
        Headings
        <select value={labels} onChange={(e) => onLabels(e.target.value === "hi" ? "hi" : e.target.value === "bilingual" ? "bilingual" : "en")} className="rounded border p-1">
          <option value="en">English</option>
          <option value="hi">Hindi</option>
          <option value="bilingual">English and Hindi</option>
        </select>
      </label>
    </section>
  );
}

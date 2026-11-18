"use client";

import type { LabelLanguage } from "@/lib/rx-render/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StepHeading } from "./step-heading";

type Props = { name: string; labels: LabelLanguage; busy: boolean; onName: (n: string) => void; onLabels: (l: LabelLanguage) => void; onCreate: () => void };

const asLabels = (v: string): LabelLanguage => (v === "hi" ? "hi" : v === "bilingual" ? "bilingual" : "en");

export function NameStep({ name, labels, busy, onName, onLabels, onCreate }: Props) {
  return (
    <div className="space-y-3">
      <StepHeading>Name the pad</StepHeading>
      <label className="block space-y-1">
        <span className="font-medium">Name of this pad</span>
        <Input value={name} onChange={(e) => onName(e.target.value)} maxLength={120} />
      </label>
      <label className="block space-y-1">
        <span className="font-medium">Headings on the prescription</span>
        <select value={labels} onChange={(e) => onLabels(asLabels(e.target.value))} className="block rounded border p-1">
          <option value="en">English</option>
          <option value="hi">हिन्दी</option>
          <option value="bilingual">English + हिन्दी</option>
        </select>
      </label>
      <Button type="button" onClick={onCreate} disabled={busy || name.trim() === ""}>
        {busy ? "Creating…" : "Place the boxes"}
      </Button>
    </div>
  );
}

"use client";

import { Input } from "@/components/ui/input";
import { bmi } from "@/lib/domain/rx-format";
import type { EditorState, VitalKey } from "@/lib/rx/editor-state";

const FIELDS: { key: VitalKey; label: string; step: string }[] = [
  { key: "bpSystolic", label: "BP systolic (mmHg)", step: "1" },
  { key: "bpDiastolic", label: "BP diastolic (mmHg)", step: "1" },
  { key: "pulse", label: "Pulse (/min)", step: "1" },
  { key: "temperatureF", label: "Temperature (°F)", step: "0.1" },
  { key: "spo2", label: "SpO₂ (%)", step: "1" },
  { key: "respiratoryRate", label: "Respiratory rate (/min)", step: "1" },
  { key: "weightKg", label: "Weight (kg)", step: "0.1" },
  { key: "heightCm", label: "Height (cm)", step: "0.1" },
  { key: "bloodSugarMgDl", label: "Blood sugar (mg/dL)", step: "1" },
];

type Props = {
  vitals: EditorState["vitals"];
  notes: string;
  onChange: (key: VitalKey, value: string) => void;
  onNotesChange: (value: string) => void;
};

export function VitalsSection({ vitals, notes, onChange, onNotesChange }: Props) {
  const index = bmi(Number(vitals.weightKg) || null, Number(vitals.heightCm) || null);
  return (
    <section className="space-y-3" aria-labelledby="vitals-heading">
      <h2 id="vitals-heading" className="font-medium">
        Vitals
      </h2>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {FIELDS.map((field) => (
          <div key={field.key} className="space-y-1">
            <label htmlFor={`vital-${field.key}`} className="text-xs text-muted-foreground">
              {field.label}
            </label>
            <Input
              id={`vital-${field.key}`}
              type="number"
              inputMode="decimal"
              step={field.step}
              className="h-9 px-2"
              value={vitals[field.key]}
              onWheel={(e) => e.currentTarget.blur()}
              onChange={(e) => onChange(field.key, e.target.value)}
            />
          </div>
        ))}
        <div className="space-y-1">
          <span className="block text-xs text-muted-foreground">BMI</span>
          <output aria-label="BMI" className="block h-9 py-2 text-sm">
            {index ?? "—"}
          </output>
        </div>
      </div>
      <div className="space-y-1">
        <label htmlFor="vital-notes" className="text-xs text-muted-foreground">
          Vitals notes
        </label>
        <Input
          id="vital-notes"
          className="h-9"
          maxLength={200}
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
        />
      </div>
    </section>
  );
}

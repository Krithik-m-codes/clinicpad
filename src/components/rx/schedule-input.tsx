"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SCHEDULE_PRESETS } from "@/lib/domain/rx-options";
import { applySchedulePreset, scheduleLabel, type EditorMedicine } from "@/lib/rx/editor-state";

type SlotKey = "doseMorning" | "doseAfternoon" | "doseEvening" | "doseNight";

const SLOTS: { key: SlotKey; label: string; short: string }[] = [
  { key: "doseMorning", label: "Morning dose", short: "Morning" },
  { key: "doseAfternoon", label: "Afternoon dose", short: "Afternoon" },
  { key: "doseEvening", label: "Evening dose", short: "Evening" },
  { key: "doseNight", label: "Night dose", short: "Night" },
];

type Props = { medicine: EditorMedicine; onChange: (patch: Partial<EditorMedicine>) => void };

/** Doses per time of day (quarter steps) with one-click presets such as 1-0-1. */
export function ScheduleInput({ medicine, onChange }: Props) {
  const summary = scheduleLabel(medicine);
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium text-muted-foreground">Schedule{summary ? `: ${summary}` : ""}</legend>
      <div className="flex flex-wrap gap-1">
        {SCHEDULE_PRESETS.map((preset) => (
          <Button
            key={preset}
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            aria-label={`Schedule ${preset}`}
            onClick={() => {
              const next = applySchedulePreset(medicine, preset);
              onChange({
                doseMorning: next.doseMorning,
                doseAfternoon: next.doseAfternoon,
                doseEvening: next.doseEvening,
                doseNight: next.doseNight,
              });
            }}
          >
            {preset}
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-4 gap-2">
        {SLOTS.map((slot) => (
          <div key={slot.key} className="space-y-1">
            <span className="block text-xs text-muted-foreground">{slot.short}</span>
            <Input
              aria-label={slot.label}
              type="number"
              inputMode="decimal"
              min={0}
              max={99}
              step={0.25}
              className="h-9 px-2"
              value={medicine[slot.key]}
              onWheel={(e) => e.currentTarget.blur()}
              onChange={(e) => {
                const patch: Partial<EditorMedicine> = {};
                patch[slot.key] = e.target.value;
                onChange(patch);
              }}
            />
          </div>
        ))}
      </div>
    </fieldset>
  );
}

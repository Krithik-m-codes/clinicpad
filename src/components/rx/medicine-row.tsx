"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DURATION_UNITS,
  FOOD_RELATIONS,
  FOOD_RELATION_LABELS,
  PERIODICITIES,
  PERIODICITY_LABELS,
  type DurationUnit,
} from "@/lib/domain/rx-options";
import type { EditorMedicine } from "@/lib/rx/editor-state";
import type { MedicineHit } from "@/server/services/catalogue";
import { MedicineCombobox } from "./medicine-combobox";
import { ScheduleInput } from "./schedule-input";

export const selectClass = "flex h-9 w-full rounded-md border-2 border-gray-200 bg-white px-2 text-sm";

type Props = {
  index: number;
  medicine: EditorMedicine;
  canAddToClinic: boolean;
  onPatch: (patch: Partial<EditorMedicine>) => void;
  onPick: (hit: MedicineHit) => void;
  onRemove: () => void;
  /** Resolves with a short message to show next to the row. */
  onSaveFavourite: () => Promise<string>;
  onAddToClinic: (name: string) => Promise<string>;
};

export function MedicineRow({ index, medicine, canAddToClinic, onPatch, onPick, onRemove, onSaveFavourite, onAddToClinic }: Props) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  // The ref closes the gap before `pending` re-renders, so a fast double click cannot start two tasks.
  const busy = useRef(false);
  const report = async (task: () => Promise<string>) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setNote("Working…");
    try {
      setNote(await task());
    } catch {
      // Never surface the underlying error text; it may carry server detail.
      setNote("Could not save. Try again.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-start gap-2">
        <span className="mt-3 w-6 text-sm text-muted-foreground">{index + 1}.</span>
        <div className="grid flex-1 gap-2 sm:grid-cols-6">
          <div className="sm:col-span-3">
            <MedicineCombobox
              value={medicine.drugName}
              onTextChange={(drugName) => onPatch({ drugName })}
              onPick={onPick}
              onAddToClinic={canAddToClinic ? (name) => void report(() => onAddToClinic(name)) : undefined}
            />
          </div>
          <Input
            aria-label="Generic name"
            placeholder="Generic / salt"
            className="sm:col-span-3"
            maxLength={300}
            value={medicine.genericName}
            onChange={(e) => onPatch({ genericName: e.target.value })}
          />
          <Input
            aria-label="Strength"
            placeholder="Strength"
            className="h-9 sm:col-span-2"
            maxLength={60}
            value={medicine.strength}
            onChange={(e) => onPatch({ strength: e.target.value })}
          />
          <Input
            aria-label="Dose"
            placeholder="Dose (1 tab, 5 ml)"
            className="h-9 sm:col-span-2"
            maxLength={60}
            value={medicine.dose}
            onChange={(e) => onPatch({ dose: e.target.value })}
          />
          <select
            aria-label="Food"
            className={`${selectClass} sm:col-span-2`}
            value={medicine.foodRelation}
            onChange={(e) => onPatch({ foodRelation: e.target.value })}
          >
            <option value="">Food: not stated</option>
            {FOOD_RELATIONS.map((code) => (
              <option key={code} value={code}>
                {FOOD_RELATION_LABELS[code]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <ScheduleInput medicine={medicine} onChange={onPatch} />
        <div className="grid grid-cols-2 content-start gap-2">
          <Input
            aria-label="Duration"
            type="number"
            min={1}
            max={365}
            step={1}
            placeholder="Duration"
            className="h-9"
            value={medicine.durationValue}
            onWheel={(e) => e.currentTarget.blur()}
            onChange={(e) => onPatch({ durationValue: e.target.value })}
          />
          <select
            aria-label="Duration unit"
            className={selectClass}
            value={medicine.durationUnit}
            onChange={(e) => onPatch({ durationUnit: e.target.value as DurationUnit })}
          >
            {DURATION_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
          </select>
          <select
            aria-label="Periodicity"
            className={selectClass}
            value={medicine.periodicity}
            onChange={(e) => onPatch({ periodicity: e.target.value })}
          >
            <option value="">How often: not stated</option>
            {PERIODICITIES.map((code) => (
              <option key={code} value={code}>
                {PERIODICITY_LABELS[code]}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={medicine.isSos}
              onChange={(e) => onPatch({ isSos: e.target.checked })}
            />
            SOS (only if needed)
          </label>
          <Input
            aria-label="Other frequency"
            placeholder="Other frequency (e.g. every 6 hours)"
            className="col-span-2 h-9"
            maxLength={60}
            value={medicine.timing}
            onChange={(e) => onPatch({ timing: e.target.value })}
          />
        </div>
      </div>

      <Input
        aria-label="Remarks"
        placeholder="Remarks"
        className="h-9"
        maxLength={300}
        value={medicine.remarks}
        onChange={(e) => onPatch({ remarks: e.target.value })}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending || medicine.drugName.trim() === ""}
          onClick={() => void report(onSaveFavourite)}
        >
          Save as favourite
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
          Remove
        </Button>
        {/* Always mounted so screen readers announce the text when it changes. */}
        <span role="status" className="text-xs text-muted-foreground">
          {note}
        </span>
      </div>
    </div>
  );
}

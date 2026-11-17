"use client";

import { Label } from "@/components/ui/label";
import { IMPORT_FIELDS, IMPORT_FIELD_LABELS, type ColumnMapping } from "@/lib/import/patient-columns";

const selectClass = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm";

type Props = { headers: string[]; mapping: ColumnMapping; onChange: (mapping: ColumnMapping) => void; disabled: boolean };

/** One select per patient field: which column of the file holds it, or "Not imported". Header text is rendered as text only. */
export function ImportMapping({ headers, mapping, onChange, disabled }: Props) {
  return (
    <fieldset className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
      <legend className="px-1 font-medium">Which column holds what</legend>
      {IMPORT_FIELDS.map((field) => (
        <div key={field} className="space-y-1">
          <Label htmlFor={`map-${field}`}>
            {IMPORT_FIELD_LABELS[field]}
            {field === "name" ? " (required)" : ""}
          </Label>
          <select
            id={`map-${field}`}
            className={selectClass}
            disabled={disabled}
            value={mapping[field] === null ? "" : String(mapping[field])}
            onChange={(event) => onChange({ ...mapping, [field]: event.target.value === "" ? null : Number(event.target.value) })}
          >
            <option value="">Not imported</option>
            {headers.map((header, index) => (
              <option key={index} value={index}>
                {header}
              </option>
            ))}
          </select>
        </div>
      ))}
    </fieldset>
  );
}

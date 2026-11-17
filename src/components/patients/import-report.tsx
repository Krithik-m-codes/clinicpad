"use client";

import type { RefObject } from "react";
import { Button } from "@/components/ui/button";
import { IMPORT_FIELD_LABELS } from "@/lib/import/patient-columns";
import type { DuplicateMatch, ImportDecision, ImportReport, ImportRowReport } from "@/server/services/patient-import";

type Props = {
  report: ImportReport;
  decisions: Record<string, ImportDecision>;
  onDecide: (row: number, decision: ImportDecision) => void;
  onDownloadProblems: () => void;
  disabled: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
};

type Duplicate = Extract<ImportRowReport, { status: "duplicate" }>;
type Invalid = Extract<ImportRowReport, { status: "invalid" }>;
type Fresh = Extract<ImportRowReport, { status: "new" }>;

const fieldLabel = (field: Invalid["field"]) => (field === "row" ? "Row" : IMPORT_FIELD_LABELS[field]);
const details = (dob: string | null, gender: string | null) =>
  [dob ? `born ${dob}` : null, gender && gender !== "unknown" ? gender : null].filter(Boolean).join(", ") || "no details";

function matchText(m: DuplicateMatch): string {
  return `Patient #${m.patientNo ?? "?"} ${m.name} (${details(m.dob, m.gender)})`;
}

function DecisionChoice({ r, value, onDecide, disabled }: { r: Duplicate; value: ImportDecision; onDecide: Props["onDecide"]; disabled: boolean }) {
  const options: { decision: ImportDecision; label: string; allowed: boolean }[] = [
    { decision: "skip", label: "Skip", allowed: true },
    { decision: "create", label: "Register as a new patient", allowed: r.canCreate },
    ...(r.canFill ? [{ decision: "fill" as const, label: "Add the missing details to the existing patient", allowed: true }] : []),
  ];
  return (
    <fieldset className="flex flex-wrap gap-3">
      <legend className="sr-only">{`Row ${r.row}: ${r.name}`}</legend>
      {options.map((o) => (
        <label key={o.decision} className="flex items-center gap-1">
          <input
            type="radio"
            name={`decision-${r.row}`}
            aria-label={`Row ${r.row}: ${o.label}`}
            checked={value === o.decision}
            disabled={disabled || !o.allowed}
            onChange={() => onDecide(r.row, o.decision)}
          />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

/** The check result: totals, problems (downloadable), duplicates with a decision each, and a preview of new rows. All text from the file is rendered as text. */
export function ImportReportView({ report, decisions, onDecide, onDownloadProblems, disabled, headingRef }: Props) {
  const problems = report.rows.filter((r): r is Invalid => r.status === "invalid");
  const duplicates = report.rows.filter((r): r is Duplicate => r.status === "duplicate");
  const fresh = report.rows.filter((r): r is Fresh => r.status === "new");
  const { totals } = report;

  return (
    <section aria-labelledby="import-report-heading" className="space-y-4">
      <h2 id="import-report-heading" ref={headingRef} tabIndex={-1} className="text-lg font-medium">
        Check result
      </h2>
      <ul className="grid gap-2 text-sm sm:grid-cols-4">
        <li className="rounded border p-2">{totals.new} ready to import</li>
        <li className="rounded border p-2">
          {totals.duplicate} possible {totals.duplicate === 1 ? "duplicate" : "duplicates"}
        </li>
        <li className="rounded border p-2">{totals.alreadyImported} already imported</li>
        <li className="rounded border p-2">{totals.invalid} with problems</li>
      </ul>
      <p className="text-sm text-muted-foreground">Dates are read as day/month/year. Check the dates below before importing.</p>
      {report.ageColumns.length > 0 ? (
        <p role="note" className="text-sm">
          Not imported: {report.ageColumns.join(", ")}. ClinicPad needs a date of birth and never guesses one from an age.
        </p>
      ) : null}

      {problems.length > 0 ? (
        <div className="space-y-2">
          <h3 className="font-medium">Rows with problems (not imported)</h3>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-2">Row</th>
                <th className="p-2">Field</th>
                <th className="p-2">Problem</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {problems.map((r) => (
                <tr key={r.row}>
                  <td className="p-2">{r.row}</td>
                  <td className="p-2">{fieldLabel(r.field)}</td>
                  <td className="p-2">{r.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Button type="button" variant="outline" onClick={onDownloadProblems}>
            Download problem rows
          </Button>
        </div>
      ) : null}

      {duplicates.length > 0 ? (
        <div className="space-y-2">
          <h3 className="font-medium">Possible duplicates (skipped unless you choose otherwise)</h3>
          <ul className="divide-y rounded border text-sm">
            {duplicates.map((r) => (
              <li key={r.row} className="space-y-1 p-2">
                <p>
                  Row {r.row}: <span className="font-medium">{r.name}</span> ({details(r.rowDob, r.rowGender)})
                </p>
                <p className="text-muted-foreground">
                  Possibly the same as:{" "}
                  {[...r.matches.map(matchText), ...(r.duplicateOfRow !== null ? [`row ${r.duplicateOfRow} of this file`] : [])].join("; ")}
                </p>
                <DecisionChoice r={r} value={decisions[String(r.row)] ?? "skip"} onDecide={onDecide} disabled={disabled} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {fresh.length > 0 ? (
        <div className="space-y-2">
          <h3 className="font-medium">New patients{totals.new > fresh.length ? ` (first ${fresh.length} of ${totals.new})` : ""}</h3>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-2">Row</th>
                <th className="p-2">Name</th>
                <th className="p-2">Date of birth</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {fresh.map((r) => (
                <tr key={r.row}>
                  <td className="p-2">{r.row}</td>
                  <td className="p-2">{r.name}</td>
                  <td className="p-2">{r.dob ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

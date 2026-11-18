"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { serializeCsv } from "@/lib/csv";
import { commitFields } from "@/lib/import/commit-choices";
import { IMPORT_FIELD_LABELS, PATIENT_TEMPLATE_ROWS, type ColumnMapping } from "@/lib/import/patient-columns";
import { IMPORT_LIMITS, IMPORT_MESSAGES } from "@/lib/import/patient-rows";
import { commitImportAction, dryRunImportAction } from "@/server/actions/patient-import";
import type { CommitSummary, ImportDecision, ImportReport } from "@/server/services/patient-import";
import { ImportMapping } from "./import-mapping";
import { ImportReportView } from "./import-report";

const NO_FILE = "Choose a CSV file first.";
const FAILED = "Something went wrong. Please try again.";

/** Hands a CSV to the browser as a download (no server round trip; the text never leaves the page). */
export function downloadCsv(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const same = (a: ColumnMapping | null, b: ColumnMapping | null) => JSON.stringify(a) === JSON.stringify(b);
const patients = (n: number) => `${n} patient${n === 1 ? "" : "s"}`;

function summaryText(s: CommitSummary): string {
  const parts = [`Imported ${patients(s.created)}${s.firstPatientNo !== null ? ` (#${s.firstPatientNo} to #${s.lastPatientNo})` : ""}.`];
  if (s.filled > 0) parts.push(`Added missing details to ${s.filled}.`);
  if (s.skipped > 0) parts.push(`Skipped ${s.skipped}.`);
  if (s.alreadyImported > 0) parts.push(`${s.alreadyImported} were already imported.`);
  if (s.invalid > 0) parts.push(`${s.invalid} rows with problems were not imported.`);
  return parts.join(" ");
}

/**
 * Stateless import: the browser keeps the file and sends it to the check and again to the import, which refuses a
 * different file or mapping (check token) and any duplicate row whose matches changed (fingerprint).
 * Nothing is written until "Import".
 */
export function ImportWizard() {
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [decisions, setDecisions] = useState<Record<string, ImportDecision>>({});
  const [summary, setSummary] = useState<CommitSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const headingRef = useRef<HTMLHeadingElement>(null);

  const stale = report !== null && !same(mapping, report.mapping);
  const chosen = (r: ImportReport["rows"][number], choice: ImportDecision) =>
    r.status === "duplicate" && decisions[String(r.row)] === choice && (choice === "create" ? r.canCreate : r.canFill);
  const creates = report ? report.totals.new + report.rows.filter((r) => chosen(r, "create")).length : 0;
  const fills = report ? report.rows.filter((r) => chosen(r, "fill")).length : 0;

  function choose(next: File | null) {
    setFile(next);
    setReport(null);
    setMapping(null);
    setDecisions({});
    setSummary(null);
    setError(next && next.size > IMPORT_LIMITS.maxBytes ? IMPORT_MESSAGES.tooLarge : null);
  }

  function check(withMapping: ColumnMapping | null) {
    if (!file) return setError(NO_FILE);
    if (file.size > IMPORT_LIMITS.maxBytes) return setError(IMPORT_MESSAGES.tooLarge);
    const form = new FormData();
    form.set("file", file);
    if (withMapping) form.set("mapping", JSON.stringify(withMapping));
    startTransition(async () => {
      try {
        const result = await dryRunImportAction(form);
        if (!result.report) return setError(result.error ?? FAILED);
        setError(null);
        setReport(result.report);
        setMapping(result.report.mapping);
        setDecisions({});
        setSummary(null);
        requestAnimationFrame(() => headingRef.current?.focus());
      } catch {
        setError(FAILED);
      }
    });
  }

  function commit() {
    if (!file || !report || !mapping) return;
    const { choices, dups } = commitFields(report.rows, decisions);
    const form = new FormData();
    form.set("file", file);
    form.set("mapping", JSON.stringify(mapping));
    form.set("choices", choices);
    form.set("dups", dups);
    form.set("sha", report.fileSha256);
    form.set("token", report.checkToken);
    startTransition(async () => {
      try {
        const result = await commitImportAction(form);
        if (!result.summary) return setError(result.error ?? FAILED);
        setError(null);
        setSummary(result.summary);
      } catch {
        setError(FAILED);
      }
    });
  }

  function downloadProblems() {
    if (!report) return;
    const rows = report.rows.flatMap((r) =>
      r.status === "invalid" ? [[...r.cells, String(r.row), `${r.field === "row" ? "Row" : IMPORT_FIELD_LABELS[r.field]}: ${r.message}`]] : [],
    );
    downloadCsv("import-problems.csv", serializeCsv([[...report.headers, "Row", "Problem"], ...rows]));
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="import-file">CSV file</Label>
        <input
          id="import-file"
          type="file"
          accept=".csv,text/csv,.txt,text/plain"
          className="block text-sm"
          onChange={(event) => choose(event.target.files?.[0] ?? null)}
          aria-describedby="import-file-hint"
        />
        <p id="import-file-hint" className="text-xs text-muted-foreground">
          In Excel choose File, Save As, CSV UTF-8 (Comma delimited). Up to 900 KB and 5,000 patients. Dates as day/month/year.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => check(stale ? mapping : null)} disabled={pending || !file}>
            {stale ? "Check again" : "Check file"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => downloadCsv("patients-template.csv", serializeCsv(PATIENT_TEMPLATE_ROWS))}>
            Download the template
          </Button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {report && mapping ? (
        <>
          <ImportMapping headers={report.headers} mapping={mapping} onChange={setMapping} disabled={pending || summary !== null} />
          {report.needsName ? <p className="text-sm">Choose the column that holds the patient&apos;s name, then check again.</p> : null}
          {!report.needsName && !stale ? (
            <ImportReportView
              report={report}
              decisions={decisions}
              onDecide={(row, decision) => setDecisions((d) => ({ ...d, [String(row)]: decision }))}
              onDownloadProblems={downloadProblems}
              disabled={pending || summary !== null}
              headingRef={headingRef}
            />
          ) : null}
          {!report.needsName && !stale && summary === null ? (
            <Button type="button" onClick={commit} disabled={pending || creates + fills === 0}>
              {creates + fills === 0 ? "Nothing to import" : `Import ${patients(creates)}${fills > 0 ? ` and update ${fills}` : ""}`}
            </Button>
          ) : null}
        </>
      ) : null}

      {summary ? (
        <div role="status" className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
          <p>{summaryText(summary)}</p>
          {summary.staleCount > 0 ? (
            <p className="font-medium">
              {summary.staleCount} {summary.staleCount === 1 ? "row was" : "rows were"} skipped because the matching patients changed after the
              check{summary.staleRows.length > 0 ? ` (rows ${summary.staleRows.join(", ")}${summary.staleCount > summary.staleRows.length ? " and more" : ""})` : ""}.
              Review them again: choose the file again and check it.
            </p>
          ) : null}
          <Link className="underline" href="/patients">
            Open the patient list
          </Link>
        </div>
      ) : null}
    </div>
  );
}

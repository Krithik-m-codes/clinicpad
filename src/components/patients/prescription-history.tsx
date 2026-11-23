import Link from "next/link";
import { DEFAULT_TIME_ZONE, isValidTimeZone, pdfFileName } from "@/lib/rx-render/format";
import { HISTORY_PAGE_SIZE, type HistoryFilters, type HistoryPage, type HistoryRow } from "@/server/services/patient-history";
import { repeatAction } from "@/server/actions/prescriptions";
import { OutputActions } from "@/components/rx/output-actions";
import { RepeatForm } from "@/components/rx/repeat-form";
import { Button } from "@/components/ui/button";
import { HistoryFiltersForm } from "./history-filters";

type Props = { patientId: string; page: HistoryPage; canRepeat: boolean };

const STATUS_TEXT: Record<string, string> = { draft: "Draft", finalized: "Finalized", amended: "Superseded" };

/** The patient page URL for these filters at `offset` (only set filters are written). */
export function historyHref(patientId: string, filters: HistoryFilters, offset: number): string {
  const params = new URLSearchParams();
  for (const key of ["from", "to", "doctor", "status", "q"] as const) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  if (offset > 0) params.set("offset", String(offset));
  const query = params.toString();
  return query ? `/patients/${patientId}?${query}` : `/patients/${patientId}`;
}

function label(row: HistoryRow): string {
  if (row.status === "draft") return row.version > 1 ? `Draft amendment (v${row.version})` : "Draft";
  return `Rx #${row.rxNo ?? "?"} v${row.version}`;
}

function dateText(row: HistoryRow, timeZone: string): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: zone }).format(row.finalizedAt ?? row.createdAt);
}

/** One patient's prescriptions: filters, the list with Open / Print / Download / Repeat, and pagination. */
export function PrescriptionHistory({ patientId, page, canRepeat }: Props) {
  const { rows, hasMore, filters, doctors, timeZone } = page;
  const filtered = Boolean(filters.from || filters.to || filters.doctor || filters.status || filters.q);
  const empty = filtered ? "No prescriptions match these filters." : filters.offset > 0 ? "No more prescriptions." : "No prescriptions yet.";

  return (
    <section className="space-y-3" aria-labelledby="history-heading">
      <h2 id="history-heading" className="font-medium">
        Prescriptions
      </h2>
      <HistoryFiltersForm patientId={patientId} filters={filters} doctors={doctors} />
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {empty}{" "}
          {filtered ? (
            <Link className="underline" href={`/patients/${patientId}`}>
              Clear filters
            </Link>
          ) : null}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {rows.map((r) => (
            <li key={r.id} className="space-y-2 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Link className="font-medium underline-offset-2 hover:underline" href={`/prescriptions/${r.id}`}>
                  {label(r)}
                </Link>
                <span className="text-muted-foreground">{dateText(r, timeZone)}</span>
                <span className="rounded bg-muted px-2 py-0.5 text-xs">{STATUS_TEXT[r.status] ?? r.status}</span>
              </div>
              <p className="text-muted-foreground">
                {[r.doctorName, r.diagnosis.slice(0, 3).join(", ") || null, r.chiefComplaint].filter(Boolean).join(" · ")}
              </p>
              {r.status !== "draft" ? (
                <div className="flex flex-wrap items-start gap-3">
                  <OutputActions prescriptionId={r.id} fileName={pdfFileName(r)} printsOnOverlay={r.templateVersionId !== null} />
                  {canRepeat && r.status === "finalized" ? <RepeatForm action={repeatAction.bind(null, r.id)} /> : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {filters.offset > 0 || hasMore ? (
        <nav aria-label="Prescription pages" className="flex items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground">{rows.length > 0 ? `Showing ${filters.offset + 1}-${filters.offset + rows.length}` : ""}</span>
          <span className="flex gap-2">
            {filters.offset > 0 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={historyHref(patientId, filters, Math.max(0, filters.offset - HISTORY_PAGE_SIZE))}>Previous</Link>
              </Button>
            ) : null}
            {hasMore ? (
              <Button asChild variant="outline" size="sm">
                <Link href={historyHref(patientId, filters, filters.offset + HISTORY_PAGE_SIZE)}>Next</Link>
              </Button>
            ) : null}
          </span>
        </nav>
      ) : null}
    </section>
  );
}

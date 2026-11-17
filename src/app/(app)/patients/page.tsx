import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { ageLabel } from "@/lib/domain/age";
import { searchPatients } from "@/server/services/patients";
import { clinicLocalDate } from "@/lib/domain/clinic-date";
import { getClinicTimeZone } from "@/server/services/clinic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;
const MAX_OFFSET = 10_000;

type RawParam = string | string[] | undefined;

/** A repeated query param arrives as an array; use the first value. */
function firstParam(value: RawParam): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Non-negative whole number; anything else becomes 0. */
function parseOffset(value: RawParam): number {
  const raw = firstParam(value)?.trim() ?? "";
  if (!/^\d{1,9}$/.test(raw)) return 0;
  return Math.min(Number(raw), MAX_OFFSET);
}

function pageHref(q: string | undefined, offset: number, archived: boolean): string {
  const params = new URLSearchParams();
  if (archived) params.set("archived", "1");
  if (q) params.set("q", q);
  if (offset > 0) params.set("offset", String(offset));
  const query = params.toString();
  return query ? `/patients?${query}` : "/patients";
}

export default async function PatientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: RawParam; offset?: RawParam; archived?: RawParam; notice?: RawParam }>;
}) {
  const session = await requireSession();
  if (!can(session.role, "patient.read")) redirect("/dashboard");

  const params = await searchParams;
  const q = firstParam(params.q);
  const offset = parseOffset(params.offset);
  const showArchived = firstParam(params.archived) === "1" && can(session.role, "patient.archive");
  // Ask for one extra row to learn whether a next page exists.
  const result = await searchPatients(session, { q, limit: PAGE_SIZE + 1, offset, archived: showArchived });
  const fetched = result.ok ? result.value : [];
  const rows = fetched.slice(0, PAGE_SIZE);
  const hasNext = fetched.length > PAGE_SIZE;
  const today = clinicLocalDate(new Date(), await getClinicTimeZone(session));

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{showArchived ? "Archived patients" : "Patients"}</h1>
        {can(session.role, "patient.write") ? (
          <Button asChild>
            <Link href="/patients/new">New patient</Link>
          </Button>
        ) : null}
        {can(session.role, "patient.import") && !showArchived ? (
          <Button asChild variant="outline">
            <Link href="/patients/import">Import from CSV</Link>
          </Button>
        ) : null}
        {can(session.role, "patient.archive") ? (
          <Link className="text-sm underline" href={showArchived ? "/patients" : "/patients?archived=1"}>
            {showArchived ? "Back to the active list" : "Show archived"}
          </Link>
        ) : null}
      </header>

      <form method="get" className="flex max-w-md gap-2" role="search">
        {showArchived ? <input type="hidden" name="archived" value="1" /> : null}
        <Input name="q" defaultValue={q ?? ""} placeholder="Search name, phone, or patient number" aria-label="Search patients" />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>

      {firstParam(params.notice) === "archived" ? (
        <p role="status" className="rounded-md border bg-muted/40 p-3 text-sm">
          Patient archived. The owner can restore them from Show archived.
        </p>
      ) : null}

      {!result.ok ? <p className="text-sm text-destructive">{result.message}</p> : null}

      {result.ok && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {offset > 0
            ? "No more patients."
            : q
              ? "No patients match that search."
              : showArchived
                ? "No archived patients."
                : "No patients yet. Register your first patient to get started."}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3">#</th>
                <th className="p-3">Name</th>
                <th className="p-3">Phone</th>
                <th className="p-3">Age</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="p-3 text-muted-foreground">{p.patientNo ?? "—"}</td>
                  <td className="p-3">
                    <Link className="font-medium underline-offset-2 hover:underline" href={`/patients/${p.id}`}>
                      {p.name}
                    </Link>
                  </td>
                  <td className="p-3">{p.phone ?? "—"}</td>
                  <td className="p-3">{p.dob ? ageLabel(p.dob, today) || "—" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {offset > 0 || hasNext ? (
        <nav aria-label="Pagination" className="flex items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground">
            {rows.length > 0 ? `Showing ${offset + 1}-${offset + rows.length}` : ""}
          </span>
          <span className="flex gap-2">
            {offset > 0 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={pageHref(q, Math.max(0, offset - PAGE_SIZE), showArchived)}>Previous</Link>
              </Button>
            ) : null}
            {hasNext ? (
              <Button asChild variant="outline" size="sm">
                <Link href={pageHref(q, offset + PAGE_SIZE, showArchived)}>Next</Link>
              </Button>
            ) : null}
          </span>
        </nav>
      ) : null}
    </div>
  );
}

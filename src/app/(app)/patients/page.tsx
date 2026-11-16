import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { ageLabel } from "@/lib/domain/age";
import { searchPatients } from "@/server/services/patients";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const dynamic = "force-dynamic";

export default async function PatientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await requireSession();
  if (!can(session.role, "patient.read")) redirect("/dashboard");

  const { q } = await searchParams;
  const result = await searchPatients(session, { q });
  const rows = result.ok ? result.value : [];
  const now = new Date();

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Patients</h1>
        {can(session.role, "patient.write") ? (
          <Button asChild>
            <Link href="/patients/new">New patient</Link>
          </Button>
        ) : null}
      </header>

      <form method="get" className="flex max-w-md gap-2" role="search">
        <Input name="q" defaultValue={q ?? ""} placeholder="Search name, phone, or patient number" aria-label="Search patients" />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>

      {!result.ok ? <p className="text-sm text-destructive">{result.message}</p> : null}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {q ? "No patients match that search." : "No patients yet. Register your first patient to get started."}
        </p>
      ) : (
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
                  <td className="p-3">{p.dob ? ageLabel(p.dob, now) || "—" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

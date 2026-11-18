import Link from "next/link";
import { redirect } from "next/navigation";
import { count, eq } from "drizzle-orm";
import { can } from "@/lib/domain/permissions";
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/rx-render/format";
import { requireSession } from "@/server/auth/session";
import { withTenant } from "@/server/db/tenant";
import { clinics, patients, prescriptions, visits } from "@/server/db/schema";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await requireSession();
  // A designer sets up pad templates only: no patient, prescription or clinic numbers (Plan 2A).
  if (session.role === "designer") redirect("/templates");
  const { tenantId } = session;

  const data = await withTenant(tenantId, async (tx) => {
    const [clinic] = await tx.select().from(clinics).limit(1);
    const [patientCount] = await tx.select({ value: count() }).from(patients);
    const [visitCount] = await tx.select({ value: count() }).from(visits);
    const [rxCount] = await tx
      .select({ value: count() })
      .from(prescriptions)
      .where(eq(prescriptions.status, "finalized"));
    return {
      clinic,
      patients: patientCount.value,
      visits: visitCount.value,
      prescriptions: rxCount.value,
    };
  });

  const zone = data.clinic?.timezone;
  const timezone = isValidTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
  const now = new Intl.DateTimeFormat("en-IN", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date());

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{data.clinic?.name ?? "Your clinic"}</h1>
        <p className="text-sm text-muted-foreground">{now}</p>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <Stat label="Patients" value={data.patients} />
        <Stat label="Visits" value={data.visits} />
        <Stat label="Finalized prescriptions" value={data.prescriptions} />
      </section>

      <section className="space-y-2 rounded-lg border p-6">
        <h2 className="font-medium">{data.patients === 0 ? "Get started" : "Your clinic is set up"}</h2>
        <p className="text-sm text-muted-foreground">Times are shown in {timezone}.</p>
        {data.patients === 0 ? (
          <div className="flex flex-wrap gap-3 text-sm">
            {can(session.role, "patient.write") ? (
              <Link className="underline" href="/patients/new">
                Register your first patient
              </Link>
            ) : null}
            {can(session.role, "patient.import") ? (
              <Link className="underline" href="/patients/import">
                Import from CSV
              </Link>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}

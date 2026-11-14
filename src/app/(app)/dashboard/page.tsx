import { count, eq } from "drizzle-orm";
import { requireSession } from "@/server/auth/session";
import { withTenant } from "@/server/db/tenant";
import { clinics, patients, prescriptions, visits } from "@/server/db/schema";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { tenantId } = await requireSession();

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

  const timezone = data.clinic?.timezone ?? "Asia/Kolkata";
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

      <section className="rounded-lg border p-6">
        <h2 className="font-medium">Your clinic is set up</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Times are shown in {timezone}. Patients and prescriptions arrive in Phase 1.
        </p>
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

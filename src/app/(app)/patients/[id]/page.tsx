import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { ageLabel } from "@/lib/domain/age";
import { getPatient } from "@/server/services/patients";
import { updatePatientAction } from "@/server/actions/patients";
import { clinicLocalDate } from "@/lib/domain/clinic-date";
import { getClinicTimeZone } from "@/server/services/clinic";
import { PatientForm } from "@/components/patients/patient-form";
import { AllergyBanner } from "@/components/patients/allergy-banner";
import { listPrescriptionsForPatient } from "@/server/services/prescriptions";
import { startPrescriptionAction } from "@/server/actions/prescriptions";
import { RedirectError } from "@/components/rx/redirect-error";
import { SubmitButton } from "@/components/rx/submit-button";

export const dynamic = "force-dynamic";

export default async function PatientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireSession();
  if (!can(session.role, "patient.read")) redirect("/dashboard");

  const { id } = await params;
  const { error } = await searchParams;
  const result = await getPatient(session, id);
  if (!result.ok) notFound();
  const p = result.value;
  const today = clinicLocalDate(new Date(), await getClinicTimeZone(session));
  const age = p.dob ? ageLabel(p.dob, today) : "";
  const canWrite = can(session.role, "patient.write");
  const history = can(session.role, "rx.read") ? await listPrescriptionsForPatient(session, p.id) : null;

  return (
    <div className="space-y-6">
      <RedirectError code={error} />
      <header>
        <h1 className="text-2xl font-semibold">{p.name}</h1>
        <p className="text-sm text-muted-foreground">
          {[p.patientNo ? `Patient #${p.patientNo}` : null, age, p.gender && p.gender !== "unknown" ? p.gender : null, p.phone]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <AllergyBanner allergies={p.allergies} />
        {can(session.role, "rx.draft") ? (
          <form action={startPrescriptionAction.bind(null, p.id)} className="mt-3">
            <SubmitButton>New prescription</SubmitButton>
          </form>
        ) : null}
      </header>

      {canWrite ? (
        <section className="space-y-3">
          <h2 className="font-medium">Details</h2>
          <PatientForm
            action={updatePatientAction.bind(null, p.id)}
            submitLabel="Save changes"
            initial={{
              name: p.name,
              phone: p.phone ?? "",
              gender: p.gender ?? "unknown",
              dob: p.dob ?? "",
              address: p.address ?? "",
              allergies: (p.allergies ?? []).join(", "),
              notes: p.notes ?? "",
            }}
          />
        </section>
      ) : (
        <section className="space-y-3">
          <h2 className="font-medium">Details</h2>
          <dl className="grid max-w-xl gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">Date of birth</dt>
            <dd>{p.dob ? `${p.dob}${age ? ` (${age})` : ""}` : "—"}</dd>
            <dt className="text-muted-foreground">Address</dt>
            <dd>{p.address || "—"}</dd>
            <dt className="text-muted-foreground">Notes</dt>
            <dd className="whitespace-pre-wrap">{p.notes || "—"}</dd>
          </dl>
        </section>
      )}

      {history?.ok ? (
        <section className="space-y-2">
          <h2 className="font-medium">Prescriptions</h2>
          {history.value.length === 0 ? (
            <p className="text-sm text-muted-foreground">No prescriptions yet.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {history.value.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                  <Link className="font-medium underline-offset-2 hover:underline" href={`/prescriptions/${r.id}`}>
                    {r.rxNo ? `Rx #${r.rxNo} v${r.version}` : "Draft"}
                  </Link>
                  <span className="text-muted-foreground">{r.chiefComplaint ?? ""}</span>
                  <span className="rounded bg-muted px-2 py-0.5 text-xs">{r.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}

import { notFound, redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { ageLabel } from "@/lib/domain/age";
import { clinicLocalDate } from "@/lib/domain/clinic-date";
import { getPatient } from "@/server/services/patients";
import { getClinicTimeZone } from "@/server/services/clinic";
import { listPatientPrescriptions } from "@/server/services/patient-history";
import { archivePatientAction, restorePatientAction, updatePatientAction } from "@/server/actions/patients";
import { startPrescriptionAction } from "@/server/actions/prescriptions";
import { getSharingConsent } from "@/server/services/consent";
import { ConsentCard } from "@/components/patients/consent-card";
import { PatientForm } from "@/components/patients/patient-form";
import { AllergyBanner } from "@/components/patients/allergy-banner";
import { PrescriptionHistory } from "@/components/patients/prescription-history";
import { DiscardDraftForm } from "@/components/rx/discard-draft-form";
import { RedirectError } from "@/components/rx/redirect-error";
import { SubmitButton } from "@/components/rx/submit-button";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;
const firstOf = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function PatientPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const session = await requireSession();
  if (!can(session.role, "patient.read")) redirect("/dashboard");

  const { id } = await params;
  const search = await searchParams;
  const canArchive = can(session.role, "patient.archive");
  const result = await getPatient(session, id, { includeArchived: canArchive });
  if (!result.ok) notFound();
  const p = result.value;
  const archived = p.deletedAt !== null;
  const timeZone = await getClinicTimeZone(session);
  const today = clinicLocalDate(new Date(), timeZone);
  const age = p.dob ? ageLabel(p.dob, today) : "";
  const canWrite = can(session.role, "patient.write") && !archived;
  const history = can(session.role, "rx.read") ? await listPatientPrescriptions(session, p.id, search) : null;

  const consent = await getSharingConsent(session, p.id);

  return (
    <div className="space-y-6">
      <RedirectError code={firstOf(search.error)} />
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{p.name}</h1>
        <p className="text-sm text-muted-foreground">
          {[p.patientNo ? `Patient #${p.patientNo}` : null, age, p.gender && p.gender !== "unknown" ? p.gender : null, p.phone]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {archived ? (
          <div role="note" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
            <p>
              Archived on {clinicLocalDate(p.deletedAt as Date, timeZone)}. This patient is hidden from search and cannot get new
              prescriptions. Their records are kept.
            </p>
            <form action={restorePatientAction.bind(null, p.id)} className="mt-2">
              <SubmitButton variant="outline">Restore patient</SubmitButton>
            </form>
          </div>
        ) : null}
        <AllergyBanner allergies={p.allergies} />
        {!archived && can(session.role, "rx.draft") ? (
          <form action={startPrescriptionAction.bind(null, p.id)}>
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

      {consent.ok ? (
        <ConsentCard patientId={p.id} consent={consent.value} canCapture={can(session.role, "consent.capture")} archived={archived} timeZone={timeZone} />
      ) : null}

      {history?.ok ? <PrescriptionHistory patientId={p.id} page={history.value} canRepeat={!archived && can(session.role, "rx.draft")} /> : null}

      {canArchive && !archived ? (
        <section className="space-y-2 border-t pt-4">
          <DiscardDraftForm
            action={archivePatientAction.bind(null, p.id)}
            label="Archive patient"
            warning="The patient is hidden from search and cannot get new prescriptions. Every record is kept, and you can restore the patient later from Show archived on the Patients page."
          />
        </section>
      ) : null}
    </div>
  );
}

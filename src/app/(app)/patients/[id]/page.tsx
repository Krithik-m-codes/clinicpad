import { notFound, redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { ageLabel } from "@/lib/domain/age";
import { getPatient } from "@/server/services/patients";
import { updatePatientAction } from "@/server/actions/patients";
import { PatientForm } from "@/components/patients/patient-form";

export const dynamic = "force-dynamic";

export default async function PatientPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!can(session.role, "patient.read")) redirect("/dashboard");

  const { id } = await params;
  const result = await getPatient(session, id);
  if (!result.ok) notFound();
  const p = result.value;
  const age = p.dob ? ageLabel(p.dob, new Date()) : "";

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{p.name}</h1>
        <p className="text-sm text-muted-foreground">
          {[p.patientNo ? `Patient #${p.patientNo}` : null, age, p.gender && p.gender !== "unknown" ? p.gender : null, p.phone]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {p.allergies?.length ? (
          <p className="mt-2 inline-block rounded bg-red-50 px-2 py-1 text-sm text-red-800">
            Allergies: {p.allergies.join(", ")}
          </p>
        ) : null}
      </header>

      {can(session.role, "patient.write") ? (
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
      ) : null}
    </div>
  );
}

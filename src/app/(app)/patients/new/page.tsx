import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { createPatientAction } from "@/server/actions/patients";
import { PatientForm } from "@/components/patients/patient-form";

export default async function NewPatientPage() {
  const session = await requireSession();
  if (!can(session.role, "patient.write")) redirect("/patients");

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">New patient</h1>
      <PatientForm action={createPatientAction} submitLabel="Register patient" allowDuplicateConfirm />
    </div>
  );
}

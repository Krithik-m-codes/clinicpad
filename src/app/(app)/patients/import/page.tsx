import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { ImportWizard } from "@/components/patients/import-wizard";

export const dynamic = "force-dynamic";

export default async function ImportPatientsPage() {
  const session = await requireSession();
  if (!can(session.role, "patient.import")) redirect("/patients");
  return (
    <div className="max-w-4xl space-y-4">
      <h1 className="text-2xl font-semibold">Import from CSV</h1>
      <p className="text-sm text-muted-foreground">
        Upload your patient list. ClinicPad checks every row first and imports nothing until you press Import. Patients who
        look like someone already registered are skipped unless you choose otherwise. Running the same file again never
        creates duplicates.
      </p>
      <ImportWizard />
    </div>
  );
}

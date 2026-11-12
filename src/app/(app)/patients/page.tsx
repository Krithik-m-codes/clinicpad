import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";

const ALLOWED = ["owner", "doctor", "reception", "nurse"];

export default async function PatientsPage() {
  const { role } = await requireSession();
  if (!ALLOWED.includes(role)) redirect("/dashboard");

  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">Patients</h1>
      <p className="text-sm text-muted-foreground">Patient management arrives in Phase 1.</p>
    </div>
  );
}

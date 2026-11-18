import { redirect } from "next/navigation";
import { can } from "@/lib/domain/permissions";
import { PDF_INTAKE_ENABLED } from "@/lib/templates/pdf-intake";
import { requireSession } from "@/server/auth/session";
import { NewTemplateWizard } from "@/components/templates/new-template-wizard";

export const dynamic = "force-dynamic";

export default async function NewTemplatePage() {
  const session = await requireSession();
  if (!can(session.role, "template.write")) redirect("/templates");
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Use my own pad</h1>
      <NewTemplateWizard pdfEnabled={PDF_INTAKE_ENABLED} />
    </div>
  );
}

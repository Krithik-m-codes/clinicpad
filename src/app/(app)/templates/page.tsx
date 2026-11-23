import Link from "next/link";
import { redirect } from "next/navigation";
import { can } from "@/lib/domain/permissions";
import { requireSession } from "@/server/auth/session";
import { listTemplates } from "@/server/services/templates";
import { listTemplateDoctors } from "@/server/services/template-assign";
import { TemplateList } from "@/components/templates/template-list";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const session = await requireSession();
  if (!can(session.role, "template.read")) redirect("/dashboard");
  const [templates, doctors] = await Promise.all([listTemplates(session), listTemplateDoctors(session)]);
  if (!templates.ok) throw new Error("templates could not be listed");
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Pad templates</h1>
          <p className="text-sm text-muted-foreground">Print prescriptions on your own letterhead. Until a pad is published and chosen, the standard ClinicPad pad is used.</p>
        </div>
        {can(session.role, "template.write") ? (
          <Button asChild>
            <Link href="/templates/new">Use my own pad</Link>
          </Button>
        ) : null}
      </div>
      <TemplateList templates={templates.value} doctors={doctors.ok ? doctors.value : []} canArchive={can(session.role, "template.publish")} />
    </div>
  );
}

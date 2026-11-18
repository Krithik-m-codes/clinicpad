import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { can } from "@/lib/domain/permissions";
import { requireSession } from "@/server/auth/session";
import { getTemplateEditor } from "@/server/services/templates";
import { StartDraftButton } from "@/components/templates/start-draft-button";
import { TemplateEditor } from "@/components/templates/template-editor";

export const dynamic = "force-dynamic";

export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!can(session.role, "template.read")) redirect("/dashboard");
  const { id } = await params;
  const view = await getTemplateEditor(session, id);
  if (!view.ok) {
    if (view.code === "invalid") {
      return (
        <div className="space-y-3">
          <Link href="/templates" className="text-sm underline">
            Back to pad templates
          </Link>
          <p className="text-sm">{view.message}</p>
        </div>
      );
    }
    notFound();
  }
  const { summary, draft } = view.value;
  const editable = can(session.role, "template.write") && summary.canWrite && summary.status === "active";
  if (!draft || !editable) {
    return (
      <div className="space-y-4">
        <Link href="/templates" className="text-sm underline">
          Back to pad templates
        </Link>
        <h1 className="text-xl font-semibold">{summary.name}</h1>
        <p className="text-sm text-muted-foreground">{summary.current ? `Published version ${summary.current.version}.` : "Nothing published yet."}</p>
        {summary.status === "archived" ? <p className="text-sm">This pad is archived. Restore it from the list to edit it.</p> : null}
        {summary.status === "active" && !summary.canWrite ? <p className="text-sm">You can view this pad but not change it.</p> : null}
        {!draft && editable ? <StartDraftButton templateId={id} /> : null}
      </div>
    );
  }
  return <TemplateEditor templateId={id} name={summary.name} fileId={draft.fileId} paper={draft.paperSize} labels={draft.labels} definition={draft.definition} revision={draft.revision} />;
}

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { can } from "@/lib/domain/permissions";
import { requireSession } from "@/server/auth/session";
import { listTemplateDoctors } from "@/server/services/template-assign";
import { getTemplateEditor } from "@/server/services/templates";
import { AssignPanel } from "@/components/templates/assign-panel";
import { PreviewPanel } from "@/components/templates/preview-panel";
import { PublishPanel } from "@/components/templates/publish-panel";
import { StartDraftButton } from "@/components/templates/start-draft-button";
import { TemplateEditor } from "@/components/templates/template-editor";
import { VersionHistory } from "@/components/templates/version-history";

export const dynamic = "force-dynamic";

export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!can(session.role, "template.read")) redirect("/dashboard");
  const { id } = await params;
  const [view, doctors] = await Promise.all([getTemplateEditor(session, id), listTemplateDoctors(session)]);
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
  const { summary, draft, history } = view.value;
  const doctorList = doctors.ok ? doctors.value : [];
  // Patient names for the real-patient preview are fetched when the user asks for them, not on every page view.
  const canPreviewReal = can(session.role, "rx.read") && can(session.role, "template.read");
  const canPublish = can(session.role, "template.publish");
  const assign =
    summary.current && summary.status === "active" && can(session.role, "template.assign") ? (
      <AssignPanel templateId={id} identity={summary.identity} boundDoctorId={summary.boundDoctorId} role={session.role} doctors={doctorList} />
    ) : null;
  const versionHistory = (hasDraft: boolean) => (
    <VersionHistory
      hasDraft={hasDraft}
      templateId={id}
      currentVersionId={summary.current?.versionId ?? null}
      versions={history.map((v) => ({ versionId: v.versionId, version: v.version, publishedAt: v.publishedAt.toISOString() }))}
      canPublish={canPublish && summary.status === "active"}
    />
  );
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
        {summary.current ? <PreviewPanel templateId={id} versionId={summary.current.versionId} canPreviewReal={canPreviewReal} /> : null}
        {assign}
        {versionHistory(false)}
      </div>
    );
  }
  return (
    <TemplateEditor templateId={id} name={summary.name} fileId={draft.fileId} paper={draft.paperSize} labels={draft.labels} definition={draft.definition} revision={draft.revision}>
      <div className="grid gap-4 lg:grid-cols-2">
        <PreviewPanel templateId={id} versionId={null} canPreviewReal={canPreviewReal} />
        <PublishPanel templateId={id} definition={draft.definition} paper={draft.paperSize} revision={draft.revision} doctors={doctorList} canPublish={canPublish} />
        {assign}
        {versionHistory(true)}
      </div>
    </TemplateEditor>
  );
}

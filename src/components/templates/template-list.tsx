import Link from "next/link";
import type { TemplateSummary } from "@/server/services/templates";
import { Badge } from "@/components/ui/badge";
import { TemplateRowActions } from "./template-row-actions";

type Props = { templates: TemplateSummary[]; doctors: { id: string; name: string }[]; canArchive: boolean };

function usedBy(t: TemplateSummary, doctors: Props["doctors"]): string {
  const names = t.assignedDoctorIds.map((id) => doctors.find((d) => d.id === id)?.name ?? "a doctor");
  const parts = [...(t.assignedToClinic ? ["the whole clinic"] : []), ...names];
  return parts.length > 0 ? `Used by ${parts.join(", ")}` : "Not in use";
}

export function TemplateList({ templates, doctors, canArchive }: Props) {
  if (templates.length === 0) {
    return <p className="rounded-md border p-6 text-sm text-muted-foreground">No pads yet. Upload a photo, scan or PDF of the pad you already use.</p>;
  }
  return (
    <ul className="divide-y rounded-md border" aria-label="Pad templates">
      {templates.map((t) => (
        <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0 space-y-1">
            <Link href={`/templates/${t.id}`} className="break-words font-medium hover:underline">
              {t.name}
            </Link>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {t.status === "archived" ? <Badge variant="secondary">Archived</Badge> : null}
              {t.current ? <Badge>Published v{t.current.version}</Badge> : <Badge variant="outline">Not published</Badge>}
              {t.draft ? <Badge variant="outline">Draft v{t.draft.version}</Badge> : null}
              {t.identity === "bound" ? <span>Letterhead of one doctor</span> : null}
              <span>{usedBy(t, doctors)}</span>
            </div>
          </div>
          {canArchive ? <TemplateRowActions templateId={t.id} archived={t.status === "archived"} inUse={t.assignedToClinic || t.assignedDoctorIds.length > 0} /> : null}
        </li>
      ))}
    </ul>
  );
}

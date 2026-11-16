import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { getPrescription } from "@/server/services/prescriptions";
import { amendAction, repeatAction, saveDraftAction } from "@/server/actions/prescriptions";
import { DraftEditor, type EditorInitial } from "@/components/rx/draft-editor";
import { AmendForm } from "@/components/rx/amend-form";
import { ReadOnlyView } from "@/components/rx/read-only-view";
import { RepeatForm } from "@/components/rx/repeat-form";

export const dynamic = "force-dynamic";

export default async function PrescriptionPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;

  // Forbidden, malformed, unknown and foreign ids all look the same: a plain not-found.
  const result = await getPrescription(session, id);
  if (!result.ok) notFound();
  const rx = result.value;

  const isDraft = rx.status === "draft";
  const label = rx.rxNo ? `Rx #${rx.rxNo}` : "Prescription";
  const heading = isDraft
    ? rx.version > 1
      ? `Draft amendment (v${rx.version})`
      : "Draft prescription"
    : `${label}${rx.version > 1 ? ` v${rx.version}` : ""}`;

  const initial: EditorInitial = {
    visitType: rx.visit.visitType === "follow-up" ? "follow-up" : "new",
    chiefComplaint: rx.visit.chiefComplaint ?? "",
    diagnosis: rx.visit.diagnosis.join(", "),
    advice: rx.visit.advice ?? "",
    followUpDate: rx.visit.followUpDate ?? "",
    items: rx.items.map((i) => ({
      drugName: i.drugName,
      strength: i.strength ?? "",
      form: i.form ?? "",
      route: i.route ?? "",
      dose: i.dose ?? "",
      timing: i.timing ?? "",
      foodRelation: i.foodRelation ?? "",
      durationDays: i.durationDays?.toString() ?? "",
      remarks: i.remarks ?? "",
    })),
  };

  return (
    <div className="max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{heading}</h1>
        <p className="text-sm text-muted-foreground">
          <Link className="underline" href={`/patients/${rx.patient.id}`}>
            {rx.patient.name}
          </Link>
          {rx.patient.patientNo ? ` · Patient #${rx.patient.patientNo}` : ""} · {rx.status}
        </p>
        {rx.amendmentReason ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Amendment reason: </span>
            {rx.amendmentReason}
          </p>
        ) : null}
      </header>

      {isDraft && can(session.role, "rx.draft") ? (
        <DraftEditor action={saveDraftAction.bind(null, rx.id)} initial={initial} />
      ) : (
        <ReadOnlyView rx={rx} />
      )}

      {!isDraft ? (
        <div className="flex flex-wrap items-start gap-6 border-t pt-4">
          {rx.status === "finalized" && can(session.role, "rx.amend") ? (
            <AmendForm action={amendAction.bind(null, rx.id)} />
          ) : null}
          {rx.status === "finalized" && can(session.role, "rx.draft") ? (
            <RepeatForm action={repeatAction.bind(null, rx.id)} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

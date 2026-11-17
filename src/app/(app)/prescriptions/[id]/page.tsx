import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { getPrescription } from "@/server/services/prescriptions";
import { listFavourites } from "@/server/services/catalogue";
import { amendAction, repeatAction } from "@/server/actions/prescriptions";
import { AllergyBanner } from "@/components/patients/allergy-banner";
import { AmendForm } from "@/components/rx/amend-form";
import { ClinicalEditor } from "@/components/rx/clinical-editor";
import { PrescriptionReadOnly } from "@/components/rx/prescription-view";
import { RepeatForm } from "@/components/rx/repeat-form";

export const dynamic = "force-dynamic";

export default async function PrescriptionPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;

  // Forbidden, malformed, unknown and foreign ids all look the same: a plain not-found.
  const result = await getPrescription(session, id);
  if (!result.ok && result.code === "conflict") {
    // A save landed in the middle of the read: not a missing prescription.
    return (
      <div className="max-w-xl space-y-3">
        <h1 className="text-xl font-semibold">This prescription changed while loading</h1>
        <p className="text-sm text-muted-foreground">It was saved from another window. Refresh to see the latest version.</p>
        <Link className="underline" href={`/prescriptions/${id}`} prefetch={false}>
          Refresh
        </Link>
      </div>
    );
  }
  if (!result.ok) notFound();
  const rx = result.value;

  const isDraft = rx.status === "draft";
  // Clinical content is editable only by roles with rx.draft (owner, doctor); everyone else reads.
  const canEdit = isDraft && can(session.role, "rx.draft");
  const favourites = canEdit ? await listFavourites(session) : null;
  const label = rx.rxNo ? `Rx #${rx.rxNo}` : "Prescription";
  const heading = isDraft
    ? rx.version > 1
      ? `Draft amendment (v${rx.version})`
      : "Draft prescription"
    : `${label}${rx.version > 1 ? ` v${rx.version}` : ""}`;

  return (
    <div className="max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{heading}</h1>
        <p className="text-sm text-muted-foreground">
          <Link className="underline" href={`/patients/${rx.patient.id}`}>
            {rx.patient.name}
          </Link>
          {rx.patient.patientNo ? ` · Patient #${rx.patient.patientNo}` : ""} · {rx.status}
        </p>
        <AllergyBanner allergies={rx.patient.allergies} showWhenEmpty />
        {rx.amendmentReason ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Amendment reason: </span>
            {rx.amendmentReason}
          </p>
        ) : null}
      </header>

      {canEdit ? (
        <ClinicalEditor
          key={rx.id}
          prescriptionId={rx.id}
          visit={rx.visit}
          items={rx.items}
          revision={rx.revision}
          favourites={favourites?.ok ? favourites.value : []}
          canAddToClinic={can(session.role, "catalogue.write")}
          canFinalize={can(session.role, "rx.finalize")}
        />
      ) : (
        <PrescriptionReadOnly rx={rx} />
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

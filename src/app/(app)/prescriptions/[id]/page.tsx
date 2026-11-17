import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { pdfFileName } from "@/lib/rx-render/format";
import { getPrescription } from "@/server/services/prescriptions";
import { listFavourites } from "@/server/services/catalogue";
import { getPadReadiness } from "@/server/services/pad-settings";
import { getVersionLinks, loadRxDocument } from "@/server/services/rx-documents";
import { listPrescriptionOutputs } from "@/server/services/rx-output";
import { amendAction, discardDraftAction, repeatAction } from "@/server/actions/prescriptions";
import { AllergyBanner } from "@/components/patients/allergy-banner";
import { AmendForm } from "@/components/rx/amend-form";
import { ClinicalEditor } from "@/components/rx/clinical-editor";
import { DiscardDraftForm } from "@/components/rx/discard-draft-form";
import { PrescriptionReadOnly } from "@/components/rx/prescription-view";
import { RepeatForm } from "@/components/rx/repeat-form";
import { RxOutputPanel, type PrintGap } from "@/components/rx/rx-output-panel";

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
        <h1 className="text-xl font-semibold">This prescription changed while loading.</h1>
        <p className="text-sm text-muted-foreground">It was saved from another window. Refresh to see the latest version.</p>
        {/* A plain link on purpose: a full page load, not a client-side navigation that could reuse this state. */}
        <a className="underline" href={`/prescriptions/${id}`}>
          Refresh
        </a>
      </div>
    );
  }
  if (!result.ok) notFound();
  const rx = result.value;

  const isDraft = rx.status === "draft";
  // Clinical content is editable only by roles with rx.draft (owner, doctor); everyone else reads.
  const canEdit = isDraft && can(session.role, "rx.draft");
  // Independent reads, in parallel. A failed or thrown one only drops its notice; it never fails the page.
  const settle = async <T,>(read: Promise<T> | null): Promise<T | null> => {
    try {
      return await read;
    } catch {
      return null;
    }
  };
  const [favourites, links, readiness, outputs, printable] = await Promise.all([
    settle(canEdit ? listFavourites(session) : null),
    settle(getVersionLinks(session, rx.id)),
    settle(canEdit ? getPadReadiness(session) : null),
    settle(isDraft ? null : listPrescriptionOutputs(session, rx.id)),
    settle(isDraft ? null : loadRxDocument(session, rx.id, { withAssets: false })),
  ]);
  // A finalized version shows the record as finalized (ADR-0032). The allergy banner stays live on purpose:
  // it is a safety prompt for whoever acts on the prescription today.
  const frozen =
    printable?.ok && printable.value.document.snapshotSource === "finalize" ? printable.value.document.snapshot : null;
  const patientName = frozen ? frozen.patient.name : rx.patient.name;
  const printedWithout: PrintGap[] = [];
  if (frozen && !frozen.doctor.name.trim()) printedWithout.push("doctorName");
  if (frozen && !frozen.doctor.registrationNo?.trim()) printedWithout.push("registrationNo");
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
            {patientName}
          </Link>
          {frozen && frozen.patient.name !== rx.patient.name ? ` (now recorded as ${rx.patient.name})` : ""}
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

      <RxOutputPanel
        prescriptionId={rx.id}
        isDraft={isDraft}
        canEdit={canEdit}
        fileName={pdfFileName(rx)}
        supersededBy={links?.ok ? links.value.supersededBy : null}
        replaces={links?.ok ? links.value.replaces : null}
        missingProfile={readiness?.ok ? readiness.value.missing : []}
        printedWithout={printedWithout}
        outputs={outputs?.ok ? outputs.value : null}
        timeZone={printable?.ok ? printable.value.document.snapshot.clinic.timezone : "Asia/Kolkata"}
      />

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

      {canEdit ? (
        <div className="border-t pt-4">
          <DiscardDraftForm
            action={discardDraftAction.bind(null, rx.id)}
            label={rx.parentPrescriptionId ? "Withdraw amendment" : "Discard draft"}
            warning={
              rx.parentPrescriptionId
                ? "The correction is deleted and the original prescription stays exactly as it is. This cannot be undone."
                : "This draft and everything in it are deleted. This cannot be undone."
            }
          />
        </div>
      ) : null}

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

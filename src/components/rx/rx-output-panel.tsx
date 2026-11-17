import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { ProfileGap } from "@/server/services/pad-settings";
import type { VersionRef } from "@/server/services/rx-documents";
import type { OutputSummary } from "@/server/services/rx-output";
import { OutputActions } from "./output-actions";

/** What a finalized copy prints without, read from its finalize snapshot. */
export type PrintGap = "doctorName" | "registrationNo";

export type RxOutputPanelProps = {
  prescriptionId: string;
  isDraft: boolean;
  /** The viewer may edit this draft (rx.draft). A draft shown to anyone else is marked as not a prescription. */
  canEdit: boolean;
  fileName: string;
  supersededBy: VersionRef | null;
  replaces: VersionRef | null;
  missingProfile: ProfileGap[];
  printedWithout: PrintGap[];
  outputs: OutputSummary | null;
  timeZone: string;
};

const GAP_TEXT: Record<Exclude<ProfileGap, "noDoctorProfile">, string> = {
  doctorName: "your printed name",
  registrationNo: "your registration number",
};
const PRINT_GAP_TEXT: Record<PrintGap, string> = { doctorName: "a doctor's name", registrationNo: "a registration number" };

const note = "rounded-md border p-3 text-sm";
const warn = `${note} border-amber-300 bg-amber-50`;

function lastPrinted(outputs: OutputSummary | null, timeZone: string): string {
  if (!outputs || outputs.count === 0) return "Not printed or downloaded yet.";
  const times = `${outputs.count} time${outputs.count === 1 ? "" : "s"}`;
  if (!outputs.lastAt) return `Printed or downloaded ${times}.`;
  const when = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone }).format(outputs.lastAt);
  return `Printed or downloaded ${times}, last on ${when}.`;
}

function ProfileWarning({ missing }: { missing: ProfileGap[] }) {
  if (missing.includes("noDoctorProfile")) {
    return (
      <div role="note" className={warn}>
        You have no doctor profile in this clinic, so prescriptions you finalize print without a doctor&apos;s name, registration
        number, or signature.
      </div>
    );
  }
  const gaps = missing.filter((gap): gap is Exclude<ProfileGap, "noDoctorProfile"> => gap !== "noDoctorProfile");
  if (gaps.length === 0) return null;
  return (
    <div role="note" className={warn}>
      Your doctor profile is missing {gaps.map((gap) => GAP_TEXT[gap]).join(" and ")}. Prescriptions you finalize now will print
      without {gaps.length > 1 ? "them" : "it"}.{" "}
      <Link className="font-medium underline" href="/settings/profile">
        Complete your profile
      </Link>
    </div>
  );
}

/** Version and draft notices, profile warnings, preview for drafts, print and download for finalized and superseded versions. */
export function RxOutputPanel(p: RxOutputPanelProps) {
  return (
    <section className="space-y-3">
      {p.supersededBy ? (
        <div role="note" className={`${note} border-red-300 bg-red-50`}>
          Superseded by{" "}
          <Link className="font-medium underline" href={`/prescriptions/${p.supersededBy.id}`}>
            version {p.supersededBy.version}
          </Link>
          . This version is kept as history; printed copies carry a SUPERSEDED marker.
        </div>
      ) : null}
      {p.replaces ? (
        <p className="text-sm text-muted-foreground">
          Replaces{" "}
          <Link className="underline" href={`/prescriptions/${p.replaces.id}`}>
            version {p.replaces.version}
          </Link>
          .
        </p>
      ) : null}
      {p.isDraft && !p.canEdit ? (
        <div role="note" className={warn}>
          This draft is not a prescription yet. It is not valid for dispensing until a doctor finalizes it.
        </div>
      ) : null}
      {p.isDraft && p.canEdit ? <ProfileWarning missing={p.missingProfile} /> : null}
      {p.printedWithout.length > 0 ? (
        <div role="note" className={warn}>
          {`This copy prints without ${p.printedWithout.map((gap) => PRINT_GAP_TEXT[gap]).join(" and ")}: ${p.printedWithout.length > 1 ? "they were missing from" : "it was missing from"} the doctor profile when the prescription was finalized.`}
        </div>
      ) : null}
      {p.isDraft ? (
        <Button asChild variant="outline">
          <a href={`/prescriptions/${p.prescriptionId}/document?purpose=preview`} target="_blank" rel="noopener noreferrer">
            Preview pad
          </a>
        </Button>
      ) : (
        <>
          <OutputActions prescriptionId={p.prescriptionId} fileName={p.fileName} />
          <p className="text-xs text-muted-foreground">{lastPrinted(p.outputs, p.timeZone)}</p>
        </>
      )}
    </section>
  );
}

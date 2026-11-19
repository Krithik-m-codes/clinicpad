"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { omittedSections, sectionNames } from "@/lib/rx-render/omitted";
import type { PaperSize } from "@/lib/rx-render/types";
import { overlayPublishIssues, type PublishIdentity } from "@/lib/templates/publish-rules";
import { publishTemplateAction } from "@/server/actions/templates";
import { Button } from "@/components/ui/button";
import { useEditorDirty } from "./editor-dirty";

type Doctor = { id: string; name: string; isMe: boolean };
type Props = {
  templateId: string;
  definition: OverlayDefinition;
  paper: PaperSize;
  revision: number;
  doctors: Doctor[];
  canPublish: boolean;
  dirty?: boolean;
};

/**
 * The publisher answers the letterhead question explicitly (override 2: the binding is part of the VERSION, nothing is
 * preselected, and a doctor's own letterhead needs a named doctor and a confirmation). The server re-checks everything.
 */
export function PublishPanel({ templateId, definition, paper, revision, doctors, canPublish, dirty = false }: Props) {
  const router = useRouter();
  const editorDirty = useEditorDirty();
  const unsaved = dirty || editorDirty;
  const [identity, setIdentity] = useState<"dynamic" | "bound" | null>(null);
  const [doctorId, setDoctorId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [ackedList, setAckedList] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const doctor = doctors.find((d) => d.id === doctorId) ?? null;
  const asked: PublishIdentity | null = identity === null ? null : identity === "dynamic" ? { kind: "dynamic" } : { kind: "bound", doctorId: doctor?.id ?? null, confirmed };
  // Sections the pad leaves off are listed and need a ticked confirmation (override 24); the server re-computes the list.
  const omitted: string[] = omittedSections(definition);
  // The confirmation belongs to one list: editing the pad so the list changes asks again.
  const omittedOk = ackedList === omitted.join(",");
  const issues = asked ? overlayPublishIssues(definition, paper, asked) : [];

  // The confirmation is about one doctor's letterhead: a new answer or a new doctor starts again.
  function chooseIdentity(next: "dynamic" | "bound") {
    setIdentity(next);
    setDoctorId("");
    setConfirmed(false);
  }
  function chooseDoctor(next: string) {
    setDoctorId(next);
    setConfirmed(false);
  }

  if (!canPublish) return <p className="rounded-md border p-3 text-sm">The clinic owner publishes pads. Save your draft and ask them to review and publish it.</p>;

  async function publish() {
    if (!asked) return;
    setBusy(true);
    const result = await publishTemplateAction(templateId, {
      identity: asked.kind,
      boundDoctorId: asked.kind === "bound" ? asked.doctorId : null,
      confirmLetterhead: asked.kind === "bound" ? asked.confirmed : false,
      acknowledgedOmitted: omitted,
      baseRevision: revision,
    });
    setBusy(false);
    const detail = result.issues && result.issues.length > 0 ? ` ${result.issues.join(" ")}` : "";
    setMessage(result.ok ? "Published. Choose who uses it below." : `${result.error ?? "Could not publish."}${detail}`);
    if (result.ok) router.refresh();
  }

  return (
    <section aria-label="Publish" className="space-y-3 rounded-md border p-3">
      <h2 className="font-medium">Publish</h2>
      <fieldset className="space-y-1 text-sm">
        <legend>Does the printed letterhead show a doctor&apos;s name or registration number?</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="identity" checked={identity === "dynamic"} onChange={() => chooseIdentity("dynamic")} /> No, it does not show a doctor: ClinicPad prints the signing doctor&apos;s details
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="identity" checked={identity === "bound"} onChange={() => chooseIdentity("bound")} /> Yes, it shows one doctor: only that doctor&apos;s prescriptions use it
        </label>
      </fieldset>
      {identity === "bound" ? (
        <div className="space-y-2 text-sm">
          <label className="flex flex-col">
            Whose letterhead is it?
            <select value={doctorId} onChange={(e) => chooseDoctor(e.target.value)} className="rounded border p-1">
              <option value="">Choose a doctor</option>
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          {doctor ? (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> The letterhead shows {doctor.name}&apos;s name and registration number
            </label>
          ) : null}
        </div>
      ) : null}
      {omitted.length > 0 ? (
        <div className="space-y-1 text-sm">
          <p>This pad does not print these sections: {sectionNames(omitted)}. Anything a doctor writes in them is kept in the record but will not appear on the printed copy or the PDF.</p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={omittedOk} onChange={(e) => setAckedList(e.target.checked ? omitted.join(",") : null)} /> Publish this pad without these sections
          </label>
        </div>
      ) : null}
      {issues.length > 0 ? (
        <ul className="list-disc pl-5 text-sm text-destructive">
          {issues.map((issue) => (
            <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>
          ))}
        </ul>
      ) : null}
      {unsaved ? <p className="text-sm">Save the draft before publishing.</p> : null}
      <Button type="button" onClick={() => void publish()} disabled={busy || unsaved || asked === null || issues.length > 0 || (omitted.length > 0 && !omittedOk)}>
        Publish
      </Button>
      <p role="status" aria-live="polite" className="text-sm">
        {message}
      </p>
    </section>
  );
}

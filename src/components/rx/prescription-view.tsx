import { formatDuration, formatSchedule, vitalsLine } from "@/lib/domain/rx-format";
import { FOOD_RELATION_LABELS, PERIODICITY_LABELS } from "@/lib/domain/rx-options";
import type { PrescriptionView } from "@/server/services/prescriptions";

function labelFor(labels: Record<string, string>, code: string | null): string {
  if (!code) return "";
  return Object.hasOwn(labels, code) ? labels[code] : code;
}

/** Finalized (or not-editable) prescription. All text is rendered as plain text by React. */
export function PrescriptionReadOnly({ rx }: { rx: PrescriptionView }) {
  const v = rx.visit;
  const tests = v.investigations.map((t) => (t.instructions ? `${t.name} (${t.instructions})` : t.name)).join(", ");
  return (
    <div className="space-y-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <Row label="Visit type" value={v.visitType === "follow-up" ? "Follow-up" : "New"} />
        <Row label="Chief complaint" value={v.chiefComplaint} />
        <Row label="Complaints" value={v.complaints.join(", ")} />
        <Row label="Diagnosis" value={v.diagnosis.join(", ")} />
        <Row label="Medical history" value={v.medicalHistory.join(", ")} />
        <Row label="Drug history" value={v.drugHistory.join(", ")} />
        <Row label="Vitals" value={vitalsLine(v.vitals)} />
        <Row label="Examination" value={v.examinationNotes} />
        <Row label="Investigations" value={tests} />
        <Row label="Advice" value={v.advice} />
        <Row label="Follow-up" value={[v.followUpDate, v.followUpReason].filter(Boolean).join(" — ")} />
      </dl>

      {rx.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No medicines.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-2">#</th>
                <th className="p-2">Medicine</th>
                <th className="p-2">Dose and schedule</th>
                <th className="p-2">Food</th>
                <th className="p-2">Duration</th>
                <th className="p-2">Remarks</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rx.items.map((i, index) => (
                <tr key={index} className="align-top">
                  <td className="p-2 text-muted-foreground">{index + 1}</td>
                  <td className="p-2">
                    <span className="font-medium">{i.drugName}</span>
                    {i.strength ? ` ${i.strength}` : ""}
                    {i.isSos ? <span className="ml-2 rounded bg-amber-100 px-1 text-xs font-semibold">SOS</span> : null}
                    {i.genericName ? <span className="block text-xs text-muted-foreground">{i.genericName}</span> : null}
                  </td>
                  <td className="p-2">
                    {[
                      i.dose,
                      formatSchedule({ morning: i.doseMorning, afternoon: i.doseAfternoon, evening: i.doseEvening, night: i.doseNight }),
                      i.timing,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </td>
                  <td className="p-2">{labelFor(FOOD_RELATION_LABELS, i.foodRelation)}</td>
                  <td className="p-2">
                    {[formatDuration(i.durationValue, i.durationUnit), labelFor(PERIODICITY_LABELS, i.periodicity)]
                      .filter(Boolean)
                      .join(" · ")}
                  </td>
                  <td className="p-2">{i.remarks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap">{value || "—"}</dd>
    </div>
  );
}

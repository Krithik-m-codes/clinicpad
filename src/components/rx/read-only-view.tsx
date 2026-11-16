import type { PrescriptionView } from "@/server/services/prescriptions";

/** Renders a prescription as plain text. All clinical text goes through JSX, so it is escaped. */
export function ReadOnlyView({ rx }: { rx: PrescriptionView }) {
  return (
    <div className="space-y-4">
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <Row label="Chief complaint" value={rx.visit.chiefComplaint} />
        <Row label="Diagnosis" value={rx.visit.diagnosis.join(", ")} />
        <Row label="Follow-up" value={rx.visit.followUpDate} />
        <Row label="Advice" value={rx.visit.advice} />
      </dl>
      <ol className="divide-y rounded-lg border">
        {rx.items.length === 0 ? <li className="p-3 text-sm text-muted-foreground">No medicines.</li> : null}
        {rx.items.map((i, index) => (
          <li key={index} className="p-3 text-sm">
            <span className="font-medium">{i.drugName}</span>
            {i.strength ? ` ${i.strength}` : ""}
            <span className="text-muted-foreground">
              {[i.dose, i.timing, i.durationDays ? `${i.durationDays} days` : null, i.remarks]
                .filter(Boolean)
                .map((s) => ` · ${s}`)
                .join("")}
            </span>
          </li>
        ))}
      </ol>
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

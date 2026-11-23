import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { HistoryDoctor, HistoryFilters } from "@/server/services/patient-history";

const selectClass = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm";

/** A plain GET form: filters live in the URL, so they survive reloads and can be shared inside the clinic. */
export function HistoryFiltersForm({ patientId, filters, doctors }: { patientId: string; filters: HistoryFilters; doctors: HistoryDoctor[] }) {
  return (
    <form method="get" action={`/patients/${patientId}`} aria-label="Filter prescriptions" className="grid gap-3 rounded-lg border p-3 sm:grid-cols-3 lg:grid-cols-6">
      <div className="space-y-1">
        <Label htmlFor="history-from">From</Label>
        <Input id="history-from" name="from" type="date" defaultValue={filters.from ?? ""} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="history-to">To</Label>
        <Input id="history-to" name="to" type="date" defaultValue={filters.to ?? ""} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="history-doctor">Doctor</Label>
        <select id="history-doctor" name="doctor" defaultValue={filters.doctor ?? ""} className={selectClass}>
          <option value="">Any doctor</option>
          {doctors.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="history-status">Status</Label>
        <select id="history-status" name="status" defaultValue={filters.status ?? ""} className={selectClass}>
          <option value="">Any status</option>
          <option value="finalized">Finalized</option>
          <option value="amended">Superseded</option>
          <option value="draft">Draft</option>
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="history-q">Diagnosis or complaint</Label>
        <Input id="history-q" name="q" defaultValue={filters.q ?? ""} maxLength={60} />
      </div>
      <div className="flex items-end gap-3">
        <Button type="submit" variant="outline">
          Apply
        </Button>
        <Link className="pb-2 text-sm underline" href={`/patients/${patientId}`}>
          Clear
        </Link>
      </div>
    </form>
  );
}

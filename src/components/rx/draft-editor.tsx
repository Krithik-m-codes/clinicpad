"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { DraftFormState } from "@/server/actions/prescriptions";

export type EditorItem = {
  drugName: string;
  strength: string;
  form: string; // kept so a cloned or amended draft does not lose it, not edited here yet
  route: string; // same
  dose: string;
  timing: string;
  foodRelation: string; // same
  durationDays: string;
  remarks: string;
};

export type EditorInitial = {
  visitType: "new" | "follow-up";
  chiefComplaint: string;
  diagnosis: string;
  advice: string;
  followUpDate: string;
  items: EditorItem[];
};

const emptyItem = (): EditorItem => ({
  drugName: "",
  strength: "",
  form: "",
  route: "",
  dose: "",
  timing: "",
  foodRelation: "",
  durationDays: "",
  remarks: "",
});

const TIMING_OPTIONS = ["OD", "BD", "TDS", "QID", "HS", "SOS", "Stat"];

type Props = {
  action: (prev: DraftFormState, formData: FormData) => Promise<DraftFormState>;
  initial: EditorInitial;
};

export function DraftEditor({ action, initial }: Props) {
  const [state, formAction, pending] = useActionState(action, {} as DraftFormState);
  const [form, setForm] = useState<EditorInitial>({
    ...initial,
    items: initial.items.length > 0 ? initial.items : [emptyItem()],
  });

  const setField = <K extends keyof EditorInitial>(key: K, value: EditorInitial[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setItem = (index: number, patch: Partial<EditorItem>) =>
    setForm((f) => ({ ...f, items: f.items.map((it, i) => (i === index ? { ...it, ...patch } : it)) }));
  const removeItem = (index: number) =>
    setForm((f) => ({ ...f, items: f.items.length > 1 ? f.items.filter((_, i) => i !== index) : [emptyItem()] }));

  // Untouched blank rows are dropped; a row with anything in it is sent so the service can validate it.
  const payload = JSON.stringify({
    visitType: form.visitType,
    chiefComplaint: form.chiefComplaint,
    diagnosis: form.diagnosis
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean),
    advice: form.advice,
    followUpDate: form.followUpDate,
    items: form.items
      .filter((it) => Object.values(it).some((v) => v.trim() !== ""))
      .map((it) => ({
        ...it,
        durationDays: it.durationDays.trim() === "" ? null : Number(it.durationDays),
      })),
  });

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="payload" value={payload} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="chiefComplaint">Chief complaint</Label>
          <Input
            id="chiefComplaint"
            value={form.chiefComplaint}
            onChange={(e) => setField("chiefComplaint", e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="diagnosis">Diagnosis</Label>
          <Input
            id="diagnosis"
            placeholder="Comma separated"
            value={form.diagnosis}
            onChange={(e) => setField("diagnosis", e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="followUpDate">Follow-up date</Label>
          <Input
            id="followUpDate"
            type="date"
            value={form.followUpDate}
            onChange={(e) => setField("followUpDate", e.target.value)}
          />
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="font-medium">Medicines</h2>
        <datalist id="timing-options">
          {TIMING_OPTIONS.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        {form.items.map((item, index) => (
          <div key={index} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-6">
            <Input
              aria-label="Medicine name"
              placeholder="Medicine"
              className="sm:col-span-2"
              value={item.drugName}
              onChange={(e) => setItem(index, { drugName: e.target.value })}
            />
            <Input
              aria-label="Strength"
              placeholder="Strength"
              value={item.strength}
              onChange={(e) => setItem(index, { strength: e.target.value })}
            />
            <Input
              aria-label="Dose"
              placeholder="Dose"
              value={item.dose}
              onChange={(e) => setItem(index, { dose: e.target.value })}
            />
            <Input
              aria-label="Timing"
              placeholder="Timing"
              list="timing-options"
              value={item.timing}
              onChange={(e) => setItem(index, { timing: e.target.value })}
            />
            <Input
              aria-label="Days"
              placeholder="Days"
              type="number"
              min={1}
              max={365}
              value={item.durationDays}
              onChange={(e) => setItem(index, { durationDays: e.target.value })}
            />
            <Input
              aria-label="Remarks"
              placeholder="Remarks (e.g. after food)"
              className="sm:col-span-5"
              value={item.remarks}
              onChange={(e) => setItem(index, { remarks: e.target.value })}
            />
            <Button type="button" variant="ghost" onClick={() => removeItem(index)}>
              Remove
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          onClick={() => setForm((f) => ({ ...f, items: [...f.items, emptyItem()] }))}
        >
          Add medicine
        </Button>
      </section>

      <div className="space-y-2">
        <Label htmlFor="advice">Advice</Label>
        <Textarea id="advice" rows={3} value={form.advice} onChange={(e) => setField("advice", e.target.value)} />
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.savedAt ? (
        <p role="status" className="text-sm text-muted-foreground">
          Saved at {new Date(state.savedAt).toLocaleTimeString()}.
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" name="intent" value="save" variant="outline" disabled={pending}>
          Save draft
        </Button>
        <Button type="submit" name="intent" value="finalize" disabled={pending}>
          Finalize
        </Button>
      </div>
    </form>
  );
}

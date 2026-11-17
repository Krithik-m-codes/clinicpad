"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { saveClinicPadAction, type SettingsFormState } from "@/server/actions/settings";
import { TEMPLATE_DEFINITIONS } from "@/lib/rx-render/templates";
import type { ClinicPadView } from "@/server/services/pad-settings";

const selectClass = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm";

const TEXT_FIELDS = [
  ["name", "Clinic name"],
  ["addressLine1", "Address line 1"],
  ["addressLine2", "Address line 2"],
  ["city", "City"],
  ["state", "State"],
  ["pincode", "PIN code"],
  ["phone", "Phone on pad"],
  ["email", "Email on pad"],
] as const;

export function ClinicPadForm({ initial }: { initial: ClinicPadView }) {
  const [state, formAction, pending] = useActionState(saveClinicPadAction, {} as SettingsFormState);
  const v: Record<string, string> = state.values ?? {
    name: initial.name,
    addressLine1: initial.addressLine1,
    addressLine2: initial.addressLine2,
    city: initial.city,
    state: initial.state,
    pincode: initial.pincode,
    phone: initial.phone,
    email: initial.email,
    padFooter: initial.padFooter,
    rxTemplate: initial.rxTemplate,
    rxPaperSize: initial.rxPaperSize,
    rxLabels: initial.rxLabels,
  };

  return (
    <form action={formAction} className="max-w-2xl space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {TEXT_FIELDS.map(([name, label]) => (
          <div key={name} className="space-y-2">
            <Label htmlFor={`pad-${name}`}>{label}</Label>
            <Input id={`pad-${name}`} name={name} defaultValue={v[name] ?? ""} aria-invalid={state.field === name} />
          </div>
        ))}
      </div>
      <div className="space-y-2">
        <Label htmlFor="pad-padFooter">Footer lines</Label>
        <Textarea id="pad-padFooter" name="padFooter" rows={3} defaultValue={v.padFooter ?? ""} aria-invalid={state.field === "padFooter"} />
        <p className="text-xs text-muted-foreground">Up to 4 lines, printed at the bottom of every page (timings, holidays, notes).</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="pad-rxTemplate">Template</Label>
          <select id="pad-rxTemplate" name="rxTemplate" className={selectClass} defaultValue={v.rxTemplate}>
            {Object.values(TEMPLATE_DEFINITIONS).map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="pad-rxPaperSize">Paper size</Label>
          <select id="pad-rxPaperSize" name="rxPaperSize" className={selectClass} defaultValue={v.rxPaperSize}>
            <option value="A4">A4</option>
            <option value="A5">A5</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="pad-rxLabels">Label language</Label>
          <select id="pad-rxLabels" name="rxLabels" className={selectClass} defaultValue={v.rxLabels}>
            <option value="en">English</option>
            <option value="hi">Hindi</option>
            <option value="bilingual">English + Hindi</option>
          </select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Changes apply to prescriptions finalized from now on. Finalized prescriptions keep the pad they were finalized with.
      </p>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.saved ? (
        <p role="status" className="text-sm text-muted-foreground">
          Saved.
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save pad"}
      </Button>
    </form>
  );
}

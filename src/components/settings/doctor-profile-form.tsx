"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveDoctorProfileAction, type SettingsFormState } from "@/server/actions/settings";
import type { DoctorProfileView } from "@/server/services/pad-settings";

const FIELDS = [
  ["displayName", "Name on prescriptions"],
  ["qualifications", "Qualifications"],
  ["designation", "Designation"],
  ["registrationNo", "Registration number"],
  ["registrationCouncil", "Registration council"],
] as const;

export function DoctorProfileForm({ initial }: { initial: DoctorProfileView }) {
  // Saved. describes the form as it was submitted; the first edit afterwards clears it.
  const [dirty, setDirty] = useState(false);
  const [state, formAction, pending] = useActionState(async (prev: SettingsFormState, formData: FormData) => {
    setDirty(false);
    return saveDoctorProfileAction(prev, formData);
  }, {} as SettingsFormState);
  const v: Record<string, string> = state.values ?? {
    displayName: initial.displayName,
    qualifications: initial.qualifications,
    designation: initial.designation,
    registrationNo: initial.registrationNo,
    registrationCouncil: initial.registrationCouncil,
  };

  return (
    <form action={formAction} onChange={() => setDirty(true)} className="max-w-xl space-y-4">
      {FIELDS.map(([name, label]) => (
        <div key={name} className="space-y-2">
          <Label htmlFor={`doc-${name}`}>{label}</Label>
          <Input id={`doc-${name}`} name={name} defaultValue={v[name] ?? ""} aria-invalid={state.field === name} />
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Printed in the pad header and under your signature. Prescriptions you already finalized keep the details they were finalized with.
      </p>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.saved && !dirty ? (
        <p role="status" className="text-sm text-muted-foreground">
          Saved.
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save profile"}
      </Button>
    </form>
  );
}

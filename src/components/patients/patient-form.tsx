"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { PatientFormState, PatientFormValues } from "@/server/actions/patients";

type Props = {
  action: (prev: PatientFormState, formData: FormData) => Promise<PatientFormState>;
  initial?: PatientFormValues;
  submitLabel: string;
  /** Show the "register anyway" button when the server reports duplicate candidates. */
  allowDuplicateConfirm?: boolean;
};

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm";

function FieldError({ state, field }: { state: PatientFormState; field: string }) {
  if (state.field !== field || !state.error) return null;
  return (
    <p id={`${field}-error`} className="text-sm text-destructive">
      {state.error}
    </p>
  );
}

/** aria props that tie an input to its inline error. */
function invalidProps(state: PatientFormState, field: string) {
  const invalid = state.field === field && Boolean(state.error);
  return invalid
    ? ({ "aria-invalid": true, "aria-describedby": `${field}-error` } as const)
    : ({} as const);
}

export function PatientForm({ action, initial, submitLabel, allowDuplicateConfirm }: Props) {
  const [state, formAction, pending] = useActionState(action, {} as PatientFormState);
  const v = state.values ?? initial ?? {};
  // Errors without a field (duplicates, permissions, not found) are shown at the form level.
  const formLevelError = state.error && !state.field ? state.error : null;

  return (
    <form action={formAction} className="max-w-xl space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          name="name"
          required
          minLength={2}
          defaultValue={v.name ?? ""}
          {...invalidProps(state, "name")}
        />
        <FieldError state={state} field="name" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="phone">Phone</Label>
          <Input
            id="phone"
            name="phone"
            type="tel"
            autoComplete="off"
            defaultValue={v.phone ?? ""}
            {...invalidProps(state, "phone")}
          />
          <FieldError state={state} field="phone" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="gender">Gender</Label>
          <select
            id="gender"
            name="gender"
            className={selectClass}
            defaultValue={v.gender || "unknown"}
            {...invalidProps(state, "gender")}
          >
            <option value="unknown">Not stated</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="other">Other</option>
          </select>
          <FieldError state={state} field="gender" />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="dob">Date of birth</Label>
          <Input id="dob" name="dob" type="date" defaultValue={v.dob ?? ""} {...invalidProps(state, "dob")} />
          <FieldError state={state} field="dob" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="allergies">Allergies</Label>
          <Input
            id="allergies"
            name="allergies"
            placeholder="Comma separated"
            defaultValue={v.allergies ?? ""}
            {...invalidProps(state, "allergies")}
          />
          <FieldError state={state} field="allergies" />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="address">Address</Label>
        <Input id="address" name="address" defaultValue={v.address ?? ""} {...invalidProps(state, "address")} />
        <FieldError state={state} field="address" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" name="notes" rows={3} defaultValue={v.notes ?? ""} {...invalidProps(state, "notes")} />
        <FieldError state={state} field="notes" />
      </div>

      {formLevelError ? (
        <p role="alert" className="text-sm text-destructive">
          {formLevelError}
        </p>
      ) : null}

      {state.candidates?.length ? (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="font-medium">Possible existing patients with this phone number:</p>
          <ul className="list-disc pl-5">
            {state.candidates.map((c) => (
              <li key={c.id}>
                <Link className="underline" href={`/patients/${c.id}`} target="_blank">
                  {c.name}
                </Link>
                {c.patientNo ? ` (#${c.patientNo})` : ""}
                {c.sameName ? " — same name" : ""}
              </li>
            ))}
          </ul>
          {allowDuplicateConfirm ? (
            <Button type="submit" name="confirmDuplicate" value="yes" variant="outline" disabled={pending}>
              Register anyway — this is a different person
            </Button>
          ) : null}
        </div>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}

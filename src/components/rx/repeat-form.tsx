"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import type { RepeatFormState } from "@/server/actions/prescriptions";

export function RepeatForm({
  action,
}: {
  action: (prev: RepeatFormState) => Promise<RepeatFormState>;
}) {
  const [state, formAction, pending] = useActionState(action, {} as RepeatFormState);
  return (
    <form action={formAction} className="space-y-2">
      <Button type="submit" variant="outline" disabled={pending}>
        Repeat as new prescription
      </Button>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

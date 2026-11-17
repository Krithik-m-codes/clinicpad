"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import type { DiscardFormState } from "@/server/actions/prescriptions";

type Props = {
  action: (prev: DiscardFormState, formData: FormData) => Promise<DiscardFormState>;
  /** "Discard draft" or "Withdraw amendment". */
  label: string;
  /** What will happen, shown in the confirm step. */
  warning: string;
};

/** A destructive action behind an inline confirm step (no browser dialog). */
export function DiscardDraftForm({ action, label, warning }: Props) {
  const [state, formAction, pending] = useActionState(action, {} as DiscardFormState);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className="space-y-2">
        <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
          {label}
        </Button>
        {state.error ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={formAction} className="max-w-xl space-y-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm">
      <p>{warning}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="destructive" disabled={pending}>
          {pending ? "Working…" : `Yes, ${label.toLowerCase()}`}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
          Keep it
        </Button>
      </div>
      {state.error ? (
        <p role="alert" className="text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

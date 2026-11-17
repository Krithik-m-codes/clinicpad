"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
  const router = useRouter();
  const [state, formAction, pending] = useActionState(action, {} as DiscardFormState);
  const [confirming, setConfirming] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);

  // The safe choice gets focus when the confirm step appears.
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
  }, [confirming]);

  // A failed discard may mean the draft was finalized or discarded elsewhere: show what is true now.
  useEffect(() => {
    if (state.error) router.refresh();
  }, [state, router]);

  const error = state.error ? (
    <p role="alert" className="text-sm text-destructive">
      {state.error}
    </p>
  ) : null;

  return (
    <div className="space-y-2">
      {/* Always mounted, so a screen reader announces the warning when it appears. */}
      <div aria-live="polite" className="max-w-xl text-sm">
        {confirming ? warning : null}
      </div>
      {confirming ? (
        <form action={formAction} className="max-w-xl space-y-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm">
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? "Working…" : `Yes, ${label.toLowerCase()}`}
            </Button>
            <Button ref={keepRef} type="button" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </div>
          {error}
        </form>
      ) : (
        <>
          <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
            {label}
          </Button>
          {error}
        </>
      )}
    </div>
  );
}

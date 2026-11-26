"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DESIGNER_DEFAULT_DAYS, DESIGNER_MAX_DAYS } from "@/lib/domain/designer";
import { inviteDesignerAction, type DesignerFormState } from "@/server/actions/designers";

/** Creates the setup account and shows the hand-over note, with the one-time password, exactly once. */
export function InviteDesignerForm() {
  const [state, action, pending] = useActionState(inviteDesignerAction, {} as DesignerFormState);
  const [copied, setCopied] = useState(false);
  const [hidden, setHidden] = useState<string | null>(null);

  async function copy(note: string) {
    try {
      await navigator.clipboard.writeText(note);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-4">
      <form action={action} className="grid gap-3 text-sm sm:grid-cols-2" autoComplete="off">
        <div className="space-y-1">
          <Label htmlFor="designer-name">Name</Label>
          <Input id="designer-name" name="name" defaultValue="ClinicPad setup" maxLength={120} required />
        </div>
        <div className="space-y-1">
          <Label htmlFor="designer-email">Email</Label>
          <Input id="designer-email" name="email" type="email" maxLength={254} required aria-describedby="designer-email-hint" />
          <p id="designer-email-hint" className="text-xs text-muted-foreground">
            A new address with no ClinicPad account. Nothing is emailed to it.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="designer-days">Access lasts (days)</Label>
          <Input id="designer-days" name="days" type="number" inputMode="numeric" min={1} max={DESIGNER_MAX_DAYS} step={1} defaultValue={DESIGNER_DEFAULT_DAYS} required />
        </div>
        <div className="flex items-end">
          <Button type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create setup account"}
          </Button>
        </div>
        {state.error ? (
          <p className="text-destructive sm:col-span-2" data-testid="designer-error">
            {state.error}
          </p>
        ) : null}
      </form>

      {state.note && state.note !== hidden ? (
        <div className="space-y-2 rounded-lg border p-4" data-testid="handover-note">
          <p className="text-sm font-medium">Hand-over note. The password is shown only now: copy it before you leave this page.</p>
          <pre className="whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">{state.note}</pre>
          <Button type="button" variant="outline" onClick={() => copy(state.note ?? "")}>
            {copied ? "Copied" : "Copy note"}
          </Button>{" "}
          <Button type="button" variant="ghost" onClick={() => setHidden(state.note ?? null)}>
            Done, hide the note
          </Button>
        </div>
      ) : null}
    </div>
  );
}

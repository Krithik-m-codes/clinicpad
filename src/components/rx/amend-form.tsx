"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AmendFormState } from "@/server/actions/prescriptions";

export function AmendForm({
  action,
}: {
  action: (prev: AmendFormState, formData: FormData) => Promise<AmendFormState>;
}) {
  const [state, formAction, pending] = useActionState(action, {} as AmendFormState);
  return (
    <form action={formAction} className="w-full max-w-sm space-y-2">
      <Label htmlFor="reason">Reason for amendment</Label>
      <Input id="reason" name="reason" placeholder="Why is this being changed?" />
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" variant="outline" disabled={pending}>
        Start amendment
      </Button>
    </form>
  );
}

"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { saveSharingAction, type SettingsFormState } from "@/server/actions/settings";

/** Owner switch for sharing by link. Off by default; turning it off stops every link the clinic has sent. */
export function SharingForm({ enabled }: { enabled: boolean }) {
  const [state, action, pending] = useActionState(saveSharingAction, {} as SettingsFormState);
  return (
    <form action={action} className="space-y-2 text-sm">
      <label className="flex items-start gap-2">
        <input type="checkbox" name="sharingEnabled" defaultChecked={enabled} className="mt-1" />
        <span>
          Allow sharing prescriptions as links by WhatsApp and email. Staff must record each patient&apos;s consent first. Turning
          this off stops every link already sent.
        </span>
      </label>
      <Button type="submit" variant="outline" disabled={pending}>
        Save sharing
      </Button>
      {state.saved ? <p role="status">Saved.</p> : null}
      {state.error ? <p className="text-destructive">{state.error}</p> : null}
    </form>
  );
}

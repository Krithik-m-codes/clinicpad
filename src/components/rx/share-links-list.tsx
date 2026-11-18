"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/rx-render/format";
import { revokeShareLinkAction, type RevokeFormState } from "@/server/actions/sharing";
import type { ShareLinkView } from "@/server/services/share-links";

const CHANNEL: Record<ShareLinkView["channel"], string> = { whatsapp: "WhatsApp", email: "Email" };
const REVOKED: Record<string, string> = {
  user: "withdrawn",
  consent_withdrawn: "withdrawn (consent withdrawn)",
  patient_archived: "withdrawn (patient archived)",
  send_failed: "not sent (the email failed)",
};

function day(at: Date, timeZone: string): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: zone }).format(at);
}

function state(link: ShareLinkView, timeZone: string): string {
  if (link.status === "active") return `active until ${day(link.expiresAt, timeZone)}`;
  if (link.status === "expired") return "expired";
  if (link.status === "used_up") return "used up";
  return REVOKED[link.revokeReason ?? "user"] ?? "withdrawn";
}

function WithdrawLink({ prescriptionId, linkId }: { prescriptionId: string; linkId: string }) {
  const [result, action, pending] = useActionState(revokeShareLinkAction.bind(null, prescriptionId, linkId), {} as RevokeFormState);
  return (
    <form action={action} className="inline">
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        Withdraw link
      </Button>
      {result.error ? <span className="text-destructive">{result.error}</span> : null}
    </form>
  );
}

/** Every link of this version: to whom (masked), when, state, opens; active ones can be withdrawn. */
export function ShareLinksList({ prescriptionId, links, timeZone }: { prescriptionId: string; links: ShareLinkView[]; timeZone: string }) {
  if (links.length === 0) return <p className="text-sm text-muted-foreground">No links sent yet.</p>;
  return (
    <div className="space-y-1">
      <h3 id={`links-${prescriptionId}`} className="text-sm font-medium">
        Links sent
      </h3>
      <ul aria-labelledby={`links-${prescriptionId}`} className="divide-y rounded border text-sm">
        {links.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center gap-x-2 p-2">
            <span>
              {CHANNEL[l.channel]} to {l.recipientMasked ?? "an unknown recipient"} · sent {day(l.createdAt, timeZone)} · {state(l, timeZone)} · opened{" "}
              {l.openCount} of {l.maxOpens}
            </span>
            {l.status === "active" ? <WithdrawLink prescriptionId={prescriptionId} linkId={l.id} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/rx-render/format";
import { shareEmailAction, shareWhatsAppAction, type ShareFormState } from "@/server/actions/sharing";
import type { SharePanelData } from "@/server/services/sharing";
import { ConsentCard } from "@/components/patients/consent-card";
import { ShareLinksList } from "./share-links-list";

type Props = { data: SharePanelData; canCaptureConsent: boolean; isOwner: boolean };

function untilText(iso: string | undefined, timeZone: string): string {
  if (!iso) return "";
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: zone }).format(new Date(iso));
}

function WhatsAppForm({ prescriptionId, defaultPhone, timeZone }: { prescriptionId: string; defaultPhone: string; timeZone: string }) {
  const [state, action, pending] = useActionState(shareWhatsAppAction.bind(null, prescriptionId), {} as ShareFormState);
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  const copied = state.url !== undefined && copiedFor === state.url;
  async function copy() {
    if (!state.url) return;
    try {
      await navigator.clipboard.writeText(state.url);
      setCopiedFor(state.url);
    } catch {
      setCopiedFor(null); // the read-only field below can still be selected and copied by hand
    }
  }
  return (
    <form action={action} className="space-y-2">
      <Label htmlFor="share-phone">WhatsApp number</Label>
      <Input
        id="share-phone"
        name="phone"
        type="tel"
        inputMode="tel"
        autoComplete="off"
        defaultValue={defaultPhone}
        aria-invalid={state.field === "phone" || undefined}
        aria-describedby="share-phone-hint"
      />
      <p id="share-phone-hint" className="text-xs text-muted-foreground">
        Indian mobile numbers can be typed as 98765 43210. Other countries: start with + and the country code.
      </p>
      <Button type="submit" disabled={pending}>
        Create WhatsApp message
      </Button>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.waUrl && state.url ? (
        <div role="status" className="space-y-2 rounded-md border bg-muted/40 p-2 text-sm">
          <p>
            Message ready. The link works until {untilText(state.expiresAt, timeZone)}.
          </p>
          <p data-testid="share-confirm-number">
            Check before sending: this goes to <strong>{state.recipientDisplay ?? state.sentTo}</strong>
            {state.patientName ? (
              <>
                {" "}
                for <strong>{state.patientName}</strong>
              </>
            ) : null}
            . A wrong number sends the prescription link to a stranger.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <a href={state.waUrl} target="_blank" rel="noopener noreferrer">
                Open WhatsApp
              </a>
            </Button>
            <Button type="button" variant="outline" onClick={copy}>
              {copied ? "Link copied" : "Copy link"}
            </Button>
          </div>
          <Input readOnly aria-label="Share link" value={state.url} onFocus={(event) => event.currentTarget.select()} />
          <p className="text-xs text-muted-foreground">WhatsApp opens with the message filled in. Press send there; ClinicPad does not send it for you.</p>
        </div>
      ) : null}
    </form>
  );
}

function EmailForm({ prescriptionId, timeZone }: { prescriptionId: string; timeZone: string }) {
  const [state, action, pending] = useActionState(shareEmailAction.bind(null, prescriptionId), {} as ShareFormState);
  return (
    <form action={action} className="space-y-2">
      <Label htmlFor="share-email">Email address</Label>
      <Input id="share-email" name="email" type="email" autoComplete="off" aria-invalid={state.field === "email" || undefined} />
      <Button type="submit" variant="outline" disabled={pending}>
        Send by email
      </Button>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.sentTo ? (
        <p role="status" className="text-sm">
          Sent to {state.sentTo}. The link works until {untilText(state.expiresAt, timeZone)}.
        </p>
      ) : null}
    </form>
  );
}

/** Sharing a finalized prescription: the clinic switch, consent first, then WhatsApp or email, then the links sent. */
export function SharePanel({ data, canCaptureConsent, isOwner }: Props) {
  const heading = (
    <h2 id="share-heading" className="text-lg font-medium">
      Share with the patient
    </h2>
  );
  if (data.status === "amended") {
    return (
      <section aria-labelledby="share-heading" className="space-y-3 rounded-lg border p-3">
        {heading}
        <p role="note" className="text-sm">
          This version was replaced by a newer one, so it cannot be shared. Links sent earlier still open, marked SUPERSEDED.
        </p>
        <ShareLinksList prescriptionId={data.prescriptionId} links={data.links} timeZone={data.timeZone} />
      </section>
    );
  }
  if (data.archived) {
    return (
      <section aria-labelledby="share-heading" className="space-y-3 rounded-lg border p-3">
        {heading}
        <p role="note" className="text-sm">
          This patient is archived, so nothing can be shared. Restore the patient to share again. Links sent earlier were withdrawn.
        </p>
        <ShareLinksList prescriptionId={data.prescriptionId} links={data.links} timeZone={data.timeZone} />
      </section>
    );
  }
  if (!data.enabled) {
    return (
      <section aria-labelledby="share-heading" className="space-y-3 rounded-lg border p-3">
        {heading}
        <p role="note" className="text-sm">
          Sharing is turned off for this clinic.{" "}
          {isOwner ? (
            <Link className="underline" href="/settings">
              Turn it on in Settings
            </Link>
          ) : (
            "Ask the clinic owner to turn it on."
          )}
        </p>
      </section>
    );
  }
  const consented = data.consent !== null && data.consent.granted;
  return (
    <section aria-labelledby="share-heading" className="space-y-3 rounded-lg border p-3">
      {heading}
      {consented ? (
        <>
          <WhatsAppForm prescriptionId={data.prescriptionId} defaultPhone={data.defaultPhone} timeZone={data.timeZone} />
          {data.emailAvailable ? (
            <EmailForm prescriptionId={data.prescriptionId} timeZone={data.timeZone} />
          ) : (
            <p className="text-xs text-muted-foreground">Email sharing is not set up on this server.</p>
          )}
        </>
      ) : (
        <ConsentCard patientId={data.patientId} consent={data.consent} canCapture={canCaptureConsent} archived={false} timeZone={data.timeZone} />
      )}
      <ShareLinksList prescriptionId={data.prescriptionId} links={data.links} timeZone={data.timeZone} />
    </section>
  );
}

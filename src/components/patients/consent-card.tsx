"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CONSENT_TEXT, SHARING_CONSENT_VERSION } from "@/lib/domain/consent";
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/rx-render/format";
import { recordConsentAction, withdrawConsentAction, type ConsentFormState } from "@/server/actions/consent";
import type { ConsentView } from "@/server/services/consent";

type Props = { patientId: string; consent: ConsentView | null; canCapture: boolean; archived: boolean; timeZone: string };

function dateText(d: Date, timeZone: string): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: zone }).format(d);
}

function MethodChoice({ name, legend }: { name: string; legend: string }) {
  return (
    <fieldset className="flex flex-wrap gap-4 text-sm">
      <legend className="mb-1 text-muted-foreground">{legend}</legend>
      <label className="flex items-center gap-1">
        <input type="radio" name={name} value="verbal" defaultChecked /> Verbal
      </label>
      <label className="flex items-center gap-1">
        <input type="radio" name={name} value="written" /> Written
      </label>
    </fieldset>
  );
}

/** Sharing consent: what is on record, recording it (with the exact text shown), and withdrawing it behind a confirm step. */
export function ConsentCard({ patientId, consent, canCapture, archived, timeZone }: Props) {
  const [recordState, record, recording] = useActionState(recordConsentAction.bind(null, patientId), {} as ConsentFormState);
  const [withdrawState, withdraw, withdrawing] = useActionState(withdrawConsentAction.bind(null, patientId), {} as ConsentFormState);
  const [confirming, setConfirming] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const text = CONSENT_TEXT[SHARING_CONSENT_VERSION];
  const recordErrorId = `consent-record-error-${patientId}`;
  const withdrawErrorId = `consent-withdraw-error-${patientId}`;

  useEffect(() => {
    if (confirming) keepRef.current?.focus();
  }, [confirming]);

  const granted = consent !== null && consent.granted;
  return (
    <section aria-labelledby={`consent-${patientId}`} className="space-y-2 rounded-lg border p-3 text-sm">
      <h2 id={`consent-${patientId}`} className="font-medium">
        Consent to share by WhatsApp or email
      </h2>
      <p role="status">
        {consent === null
          ? "Not recorded. Nothing can be shared until the patient agrees."
          : consent.granted
            ? `Given (${consent.method}) on ${dateText(consent.recordedAt, timeZone)}.`
            : `Withdrawn on ${dateText(consent.recordedAt, timeZone)}. Nothing can be shared until consent is recorded again.`}
      </p>

      {canCapture && !archived && !granted ? (
        <form action={record} className="space-y-2">
          <blockquote className="space-y-1 border-l-2 pl-3">
            <p>{text.en}</p>
            <p lang="hi">{text.hi}</p>
          </blockquote>
          <MethodChoice name="method" legend="How the patient agreed" />
          <input type="hidden" name="version" value={SHARING_CONSENT_VERSION} />
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="confirmed"
              value="yes"
              aria-invalid={recordState.field === "confirmed" || undefined}
              aria-describedby={recordState.error ? recordErrorId : undefined}
            />
            The patient (or their guardian) agreed to this text.
          </label>
          <Button type="submit" disabled={recording}>
            Record consent
          </Button>
          {recordState.error ? (
            <p id={recordErrorId} role="alert" className="text-destructive">
              {recordState.error}
            </p>
          ) : null}
        </form>
      ) : null}

      {canCapture && granted ? (
        <div className="space-y-2">
          <div aria-live="polite">{confirming ? "Every link already sent for this patient stops working at once." : null}</div>
          {confirming ? (
            <form
              action={(formData) => {
                // Leave the confirm step as soon as the request is sent, so a later re-grant starts from a closed card.
                setConfirming(false);
                withdraw(formData);
              }}
              aria-describedby={withdrawState.error ? withdrawErrorId : undefined}
              className="space-y-2 rounded-md border border-red-200 bg-red-50 p-3"
            >
              <MethodChoice name="method" legend="How the patient withdrew" />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="destructive" disabled={withdrawing}>
                  Yes, withdraw consent
                </Button>
                <Button ref={keepRef} type="button" variant="ghost" onClick={() => setConfirming(false)} disabled={withdrawing}>
                  Keep it
                </Button>
              </div>
            </form>
          ) : (
            <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
              Withdraw consent
            </Button>
          )}
          {withdrawState.error ? (
            <p id={withdrawErrorId} role="alert" className="text-destructive">
              {withdrawState.error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

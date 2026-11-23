import { escapeHtml } from "@/lib/rx-render/html";
import type { ShareMessageParts } from "./whatsapp";
import { shareMessageText } from "./whatsapp";

export type EmailMessage = { to: string; subject: string; text: string; html: string };
export type EmailFailureCode = "email_unavailable" | "email_rejected" | "email_timeout";
export type EmailOutcome = { ok: true; providerMessageId: string | null } | { ok: false; code: EmailFailureCode };

/** Sends one message. Never throws: every failure is a code. Tests use a fake (tests/helpers/fake-email.ts). */
export interface EmailProvider {
  readonly name: "resend" | "fake";
  send(message: EmailMessage): Promise<EmailOutcome>;
}

const RESEND_URL = "https://api.resend.com/emails";

/**
 * The message body carries no tracking fields and the link is a plain anchor (no tracking redirect). Resend's open
 * and click tracking are domain-level settings and must stay OFF for the sending domain (human decision, ADR-0037):
 * a tracking redirect would route the share token through a third party.
 */
export function createResendProvider(opts: { apiKey: string; from: string; fetch?: typeof fetch; timeoutMs?: number }): EmailProvider {
  const fetchImpl = opts.fetch ?? fetch;
  return {
    name: "resend",
    async send(message) {
      let response: Response;
      try {
        response = await fetchImpl(RESEND_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: opts.from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        return { ok: false, code: timedOut ? "email_timeout" : "email_unavailable" };
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, code: "email_unavailable" };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, code: "email_rejected" };
      }
      try {
        const body = (await response.json()) as { id?: unknown };
        return { ok: true, providerMessageId: typeof body.id === "string" ? body.id.slice(0, 200) : null };
      } catch {
        return { ok: true, providerMessageId: null };
      }
    },
  };
}

/**
 * Email is available only when RESEND_API_KEY and a plausible EMAIL_FROM are both set (decision 10); otherwise null
 * and the Share panel says email is not set up. Building the adapter makes no network call.
 */
export function getEmailProvider(env: Readonly<Record<string, string | undefined>> = process.env): EmailProvider | null {
  const apiKey = (env.RESEND_API_KEY ?? "").trim();
  const from = (env.EMAIL_FROM ?? "").trim();
  if (apiKey === "" || from === "" || !from.includes("@") || /[\r\n]/.test(from)) return null;
  return createResendProvider({ apiKey, from });
}

const singleLine = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();

/** The email body: the same link and expiry as WhatsApp, no attachment, no patient data. */
export function shareEmailMessage(p: ShareMessageParts & { to: string; maxOpens: number }): EmailMessage {
  const clinic = singleLine(p.clinicName).slice(0, 80) || "your clinic";
  const intro = shareMessageText(p);
  const note = `This link opens the prescription as a PDF. It works ${p.maxOpens} times until ${p.expiresOn}. If you were not expecting this email, you can ignore it.`;
  return {
    to: p.to,
    subject: `Your prescription from ${clinic}`,
    text: `${intro}\n\n${note}\n`,
    html: `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(p.url)}">Open your prescription</a></p><p>${escapeHtml(note)}</p>`,
  };
}

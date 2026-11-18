import { and, countDistinct, eq, gte, isNull } from "drizzle-orm";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { emailRecipient, formatInternational, isLoggableMask, RECIPIENT_MESSAGES, whatsAppRecipient } from "@/lib/domain/recipient";
import { fail, ok, type Result } from "@/lib/result";
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/rx-render/format";
import { patients, prescriptionShares, prescriptions, shareLinks, visits } from "@/server/db/schema";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { getEmailProvider, shareEmailMessage, type EmailMessage, type EmailOutcome, type EmailProvider } from "@/server/messaging/email";
import { shareMessageText, waMeLink } from "@/server/messaging/whatsapp";
import { resolveAppUrl, shareUrl } from "@/server/sharing/config";
import { recordAudit } from "./audit";
import { currentSharingConsentIn, type ConsentView } from "./consent";
import type { ServiceContext } from "./context";
import { primaryClinic } from "./render-snapshot";
import { createShareLinkIn, listShareLinksIn, SHARE_LIMITS, type CreatedLink, type ShareLinkView } from "./share-links";

export type WhatsAppShare = {
  linkId: string;
  url: string;
  waUrl: string;
  expiresAt: Date;
  recipientMasked: string;
  /** The full number, for the clinic to confirm before opening WhatsApp; never logged or audited. */
  recipientDisplay: string;
  patientName: string;
};
export type EmailShare = { linkId: string; expiresAt: Date; recipientMasked: string };
export type SharePanelData = {
  prescriptionId: string;
  patientId: string;
  status: "finalized" | "amended";
  enabled: boolean;
  consent: ConsentView | null;
  links: ShareLinkView[];
  emailAvailable: boolean;
  defaultPhone: string;
  timeZone: string;
  archived: boolean;
};

export const EMAILS_PER_PRESCRIPTION_PER_DAY = 5;
const DAY_MS = 86_400_000;
const FORBIDDEN = "You cannot share prescriptions.";
const NOT_FOUND = "Prescription not found.";
const NO_APP_URL = "Sharing is not set up on this server (NEXT_PUBLIC_APP_URL).";
const NO_EMAIL = "Email sharing is not set up on this server.";
const EMAIL_FAILED = "The email could not be sent, so its link was withdrawn. Try again, or share by WhatsApp.";
const TOO_MANY_EMAILS = "Five emails were already sent for this prescription today. Try again tomorrow, or share by WhatsApp.";

function zoneOf(timezone: string | null | undefined): string {
  return isValidTimeZone(timezone) ? timezone : DEFAULT_TIME_ZONE;
}

function dayText(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone }).format(at);
}

/**
 * Creates a link and a WhatsApp message for the clinic to send from its own WhatsApp (decision 9). The full number
 * is used only to build the wa.me URL that goes back to the browser; the share log keeps the masked form.
 */
export async function shareByWhatsApp(
  ctx: ServiceContext,
  input: { prescriptionId: string; phone: unknown },
  deps: { appUrl?: string | null; now?: Date } = {},
): Promise<Result<WhatsAppShare>> {
  if (!can(ctx.role, "rx.share")) return fail("forbidden", FORBIDDEN);
  if (!isUuid(input.prescriptionId)) return fail("not_found", NOT_FOUND);
  const recipient = whatsAppRecipient(typeof input.phone === "string" ? input.phone : "");
  if (!recipient.ok) return fail("invalid", recipient.message, "phone");
  const appUrl = deps.appUrl === undefined ? resolveAppUrl(process.env) : deps.appUrl;
  if (!appUrl) return fail("unavailable", NO_APP_URL);
  const now = deps.now ?? new Date();

  return withTenant(ctx.tenantId, async (tx): Promise<Result<WhatsAppShare>> => {
    const link = await createShareLinkIn(tx, ctx, { prescriptionId: input.prescriptionId, channel: "whatsapp" }, now);
    if (!link.ok) return link;
    const clinic = await primaryClinic(tx, ctx.tenantId);
    const [patient] = await tx
      .select({ name: patients.name })
      .from(prescriptions)
      .innerJoin(visits, eq(visits.id, prescriptions.visitId))
      .innerJoin(patients, eq(patients.id, visits.patientId))
      .where(and(eq(prescriptions.tenantId, ctx.tenantId), eq(prescriptions.id, link.value.prescriptionId)))
      .limit(1);
    const [share] = await tx
      .insert(prescriptionShares)
      .values({
        tenantId: ctx.tenantId,
        prescriptionId: link.value.prescriptionId,
        shareLinkId: link.value.linkId,
        channel: "whatsapp",
        recipientMasked: recipient.masked,
        provider: "wa_link",
        status: "prepared",
        actorUserId: ctx.userId,
      })
      .returning({ id: prescriptionShares.id });
    await recordAudit(tx, ctx, {
      action: "prescription.shared",
      entityType: "prescription",
      entityId: link.value.prescriptionId,
      after: { linkId: link.value.linkId, shareId: share.id, channel: "whatsapp", status: "prepared" },
    });
    const url = shareUrl(link.value.token, appUrl);
    const text = shareMessageText({
      clinicName: clinic?.name ?? "",
      rxNo: link.value.rxNo,
      version: link.value.version,
      url,
      expiresOn: dayText(link.value.expiresAt, zoneOf(clinic?.timezone)),
    });
    return ok({ linkId: link.value.linkId, url, waUrl: waMeLink(recipient.digits, text), expiresAt: link.value.expiresAt, recipientMasked: recipient.masked, recipientDisplay: formatInternational(recipient.digits), patientName: patient?.name ?? "" });
  });
}

/**
 * Emails an expiring link (no attachment, decision 10). Transaction 1 checks the daily cap, creates the link and logs
 * a "prepared" row (so a send can never go unlogged and a retry cannot dodge the cap); the provider is then called
 * outside any transaction; transaction 2 appends the outcome ("sent" or "failed"; the log is insert-only) and a failed
 * send withdraws its link. If transaction 2 fails after a real send the email is still reported as sent: the prepared
 * row stays as the record and still counts against the cap.
 */
export async function shareByEmail(
  ctx: ServiceContext,
  input: { prescriptionId: string; email: unknown },
  deps: { email?: EmailProvider | null; appUrl?: string | null; now?: Date } = {},
): Promise<Result<EmailShare>> {
  if (!can(ctx.role, "rx.share")) return fail("forbidden", FORBIDDEN);
  if (!isUuid(input.prescriptionId)) return fail("not_found", NOT_FOUND);
  const provider = deps.email === undefined ? getEmailProvider() : deps.email;
  if (!provider) return fail("unavailable", NO_EMAIL);
  const recipient = emailRecipient(typeof input.email === "string" ? input.email : "");
  if (!recipient.ok) return fail("invalid", recipient.message, "email");
  // The mask must fit the share log before a message leaves: a send that cannot be logged must not happen.
  if (!isLoggableMask(recipient.masked)) return fail("invalid", RECIPIENT_MESSAGES.emailInvalid, "email");
  const appUrl = deps.appUrl === undefined ? resolveAppUrl(process.env) : deps.appUrl;
  if (!appUrl) return fail("unavailable", NO_APP_URL);
  const now = deps.now ?? new Date();

  const prepared = await withTenant(ctx.tenantId, async (tx): Promise<Result<{ link: CreatedLink; message: EmailMessage }>> => {
    // Attempts, not rows: every attempt has a prepared row and, later, an outcome row for the same link.
    const [{ value: attempts }] = await tx
      .select({ value: countDistinct(prescriptionShares.shareLinkId) })
      .from(prescriptionShares)
      .where(
        and(
          eq(prescriptionShares.tenantId, ctx.tenantId),
          eq(prescriptionShares.prescriptionId, input.prescriptionId),
          eq(prescriptionShares.channel, "email"),
          gte(prescriptionShares.createdAt, new Date(now.getTime() - DAY_MS)),
        ),
      );
    if (attempts >= EMAILS_PER_PRESCRIPTION_PER_DAY) return fail("unavailable", TOO_MANY_EMAILS);
    const link = await createShareLinkIn(tx, ctx, { prescriptionId: input.prescriptionId, channel: "email" }, now);
    if (!link.ok) return link;
    const clinic = await primaryClinic(tx, ctx.tenantId);
    const message = shareEmailMessage({
      to: recipient.address,
      clinicName: clinic?.name ?? "",
      rxNo: link.value.rxNo,
      version: link.value.version,
      url: shareUrl(link.value.token, appUrl),
      expiresOn: dayText(link.value.expiresAt, zoneOf(clinic?.timezone)),
      maxOpens: SHARE_LIMITS.maxOpens,
    });
    const [share] = await tx
      .insert(prescriptionShares)
      .values({
        tenantId: ctx.tenantId,
        prescriptionId: link.value.prescriptionId,
        shareLinkId: link.value.linkId,
        channel: "email",
        recipientMasked: recipient.masked,
        provider: provider.name,
        status: "prepared",
        actorUserId: ctx.userId,
      })
      .returning({ id: prescriptionShares.id });
    await recordAudit(tx, ctx, {
      action: "prescription.shared",
      entityType: "prescription",
      entityId: link.value.prescriptionId,
      after: { linkId: link.value.linkId, shareId: share.id, channel: "email", status: "prepared" },
    });
    return ok({ link: link.value, message });
  });
  if (!prepared.ok) return prepared;
  const { link, message } = prepared.value;

  // Outside any transaction: a network call must never hold a database transaction open.
  let outcome: EmailOutcome;
  try {
    outcome = await provider.send(message);
  } catch {
    outcome = { ok: false, code: "email_unavailable" };
  }

  const withdraw = (tx: TenantTx) =>
    tx
      .update(shareLinks)
      .set({ revokedAt: new Date(), revokedBy: ctx.userId, revokeReason: "send_failed" })
      .where(and(eq(shareLinks.tenantId, ctx.tenantId), eq(shareLinks.id, link.linkId), isNull(shareLinks.revokedAt)));
  const delivered: Result<EmailShare> = ok({ linkId: link.linkId, expiresAt: link.expiresAt, recipientMasked: recipient.masked });
  try {
    return await withTenant(ctx.tenantId, async (tx): Promise<Result<EmailShare>> => {
      const [share] = await tx
        .insert(prescriptionShares)
        .values({
          tenantId: ctx.tenantId,
          prescriptionId: link.prescriptionId,
          shareLinkId: link.linkId,
          channel: "email",
          recipientMasked: recipient.masked,
          provider: provider.name,
          status: outcome.ok ? "sent" : "failed",
          providerMessageId: outcome.ok ? outcome.providerMessageId : null,
          errorCode: outcome.ok ? null : outcome.code,
          actorUserId: ctx.userId,
        })
        .returning({ id: prescriptionShares.id });
      if (!outcome.ok) await withdraw(tx);
      await recordAudit(tx, ctx, {
        action: "prescription.shared",
        entityType: "prescription",
        entityId: link.prescriptionId,
        after: { linkId: link.linkId, shareId: share.id, channel: "email", status: outcome.ok ? "sent" : "failed" },
      });
      return outcome.ok ? delivered : fail("unavailable", EMAIL_FAILED);
    });
  } catch (error) {
    console.error("shareByEmail outcome not logged", error instanceof Error ? error.name : typeof error);
    if (outcome.ok) return delivered; // delivered; the prepared row is the record
    try {
      await withTenant(ctx.tenantId, (tx) => withdraw(tx));
    } catch {
      // the link reached nobody, and it expires on its own
    }
    return fail("unavailable", EMAIL_FAILED);
  }
}

/** Everything the Share panel shows for one signed version (drafts have no panel). */
export async function getSharePanel(
  ctx: ServiceContext,
  prescriptionId: string,
  deps: { email?: EmailProvider | null } = {},
): Promise<Result<SharePanelData>> {
  if (!can(ctx.role, "rx.share")) return fail("forbidden", FORBIDDEN);
  if (!isUuid(prescriptionId)) return fail("not_found", NOT_FOUND);
  const emailAvailable = (deps.email === undefined ? getEmailProvider() : deps.email) !== null;
  return withTenant(ctx.tenantId, async (tx): Promise<Result<SharePanelData>> => {
    const [rx] = await tx
      .select({ id: prescriptions.id, status: prescriptions.status, patientId: visits.patientId })
      .from(prescriptions)
      .innerJoin(visits, eq(visits.id, prescriptions.visitId))
      .where(and(eq(prescriptions.tenantId, ctx.tenantId), eq(prescriptions.id, prescriptionId)))
      .limit(1);
    if (!rx || (rx.status !== "finalized" && rx.status !== "amended")) return fail("not_found", NOT_FOUND);
    const [patient] = await tx.select({ phone: patients.phone, deletedAt: patients.deletedAt }).from(patients).where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, rx.patientId))).limit(1);
    const clinic = await primaryClinic(tx, ctx.tenantId);
    return ok({
      prescriptionId: rx.id,
      patientId: rx.patientId,
      status: rx.status,
      enabled: clinic?.sharingEnabled ?? false,
      consent: await currentSharingConsentIn(tx, ctx.tenantId, rx.patientId),
      links: await listShareLinksIn(tx, ctx.tenantId, rx.id, new Date()),
      emailAvailable,
      defaultPhone: patient?.phone ?? "",
      timeZone: zoneOf(clinic?.timezone),
      archived: patient?.deletedAt != null,
    });
  });
}

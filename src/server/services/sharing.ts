import { and, count, eq, gte, isNull } from "drizzle-orm";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { emailRecipient, whatsAppRecipient } from "@/lib/domain/recipient";
import { fail, ok, type Result } from "@/lib/result";
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/rx-render/format";
import { patients, prescriptionShares, prescriptions, shareLinks, visits } from "@/server/db/schema";
import { withTenant } from "@/server/db/tenant";
import { getEmailProvider, shareEmailMessage, type EmailMessage, type EmailProvider } from "@/server/messaging/email";
import { shareMessageText, waMeLink } from "@/server/messaging/whatsapp";
import { resolveAppUrl, shareUrl } from "@/server/sharing/config";
import { recordAudit } from "./audit";
import { currentSharingConsentIn, type ConsentView } from "./consent";
import type { ServiceContext } from "./context";
import { primaryClinic } from "./render-snapshot";
import { createShareLinkIn, listShareLinksIn, SHARE_LIMITS, type CreatedLink, type ShareLinkView } from "./share-links";

export type WhatsAppShare = { linkId: string; url: string; waUrl: string; expiresAt: Date; recipientMasked: string };
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
    return ok({ linkId: link.value.linkId, url, waUrl: waMeLink(recipient.digits, text), expiresAt: link.value.expiresAt, recipientMasked: recipient.masked });
  });
}

/**
 * Emails an expiring link (no attachment, decision 10). The link is created first (one transaction), the provider
 * is called outside any transaction, and the outcome is logged in a second one; a failed send withdraws its link.
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
  const appUrl = deps.appUrl === undefined ? resolveAppUrl(process.env) : deps.appUrl;
  if (!appUrl) return fail("unavailable", NO_APP_URL);
  const now = deps.now ?? new Date();

  const prepared = await withTenant(ctx.tenantId, async (tx): Promise<Result<{ link: CreatedLink; message: EmailMessage }>> => {
    const [{ value: sentToday }] = await tx
      .select({ value: count() })
      .from(prescriptionShares)
      .where(
        and(
          eq(prescriptionShares.tenantId, ctx.tenantId),
          eq(prescriptionShares.prescriptionId, input.prescriptionId),
          eq(prescriptionShares.channel, "email"),
          gte(prescriptionShares.createdAt, new Date(now.getTime() - DAY_MS)),
        ),
      );
    if (sentToday >= EMAILS_PER_PRESCRIPTION_PER_DAY) return fail("unavailable", TOO_MANY_EMAILS);
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
    return ok({ link: link.value, message });
  });
  if (!prepared.ok) return prepared;
  const { link, message } = prepared.value;

  // Outside any transaction: a network call must never hold a database transaction open.
  const outcome = await provider.send(message);

  return withTenant(ctx.tenantId, async (tx): Promise<Result<EmailShare>> => {
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
    if (!outcome.ok) {
      await tx
        .update(shareLinks)
        .set({ revokedAt: new Date(), revokedBy: ctx.userId, revokeReason: "send_failed" })
        .where(and(eq(shareLinks.tenantId, ctx.tenantId), eq(shareLinks.id, link.linkId), isNull(shareLinks.revokedAt)));
    }
    await recordAudit(tx, ctx, {
      action: "prescription.shared",
      entityType: "prescription",
      entityId: link.prescriptionId,
      after: { linkId: link.linkId, shareId: share.id, channel: "email", status: outcome.ok ? "sent" : "failed" },
    });
    return outcome.ok
      ? ok({ linkId: link.linkId, expiresAt: link.expiresAt, recipientMasked: recipient.masked })
      : fail("unavailable", EMAIL_FAILED);
  });
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

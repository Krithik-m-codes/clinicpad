import { and, count, desc, eq, gt, gte, inArray, isNull, lt } from "drizzle-orm";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { fail, ok, type Result } from "@/lib/result";
import { patients, prescriptionShares, prescriptions, shareLinks, visits } from "@/server/db/schema";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { newShareToken, shareTokenHash } from "@/server/sharing/token";
import { recordAudit } from "./audit";
import { currentSharingConsentIn } from "./consent";
import type { ServiceContext } from "./context";
import { primaryClinic } from "./render-snapshot";
import { SHARE_LIMITS, hasFinalSnapshot, linkStatus, type CreatedLink, type ShareChannel, type ShareLinkView } from "./share-link-core";

export { SHARE_LIMITS, linkStatus } from "./share-link-core";
export type { CreatedLink, ShareChannel, ShareLinkStatus, ShareLinkSummary, ShareLinkView } from "./share-link-core";
export { openSharedPrescription, resolveShareLink } from "./share-open";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MESSAGES = {
  notFound: "Prescription not found.",
  draft: "Finalize this prescription before sharing it.",
  superseded: "This version was replaced by a newer one. Share the latest version.",
  noSnapshot: "This prescription was finalized before print snapshots were recorded, so it cannot be shared as a link. Print it or amend it to share a new version.",
  off: "Sharing is turned off for this clinic. The owner can turn it on in Settings.",
  consent: "Record the patient's consent to sharing first.",
  tooManyActive: "This prescription already has 10 active links. Withdraw one first.",
  tooManyRecent: "Too many links were created in the last hour. Try again later.",
  linkNotFound: "Link not found.",
  alreadyRevoked: "This link was already withdrawn.",
} as const;

/**
 * Creates a link inside the caller's transaction (the sharing service writes its share-log row in the same one).
 * Order: the prescription (finalized only), the patient row FOR SHARE (decision 13: a concurrent consent withdrawal
 * or archive, which lock it FOR UPDATE, either ran first or waits for this transaction), the clinic switch, the
 * consent, the rate limits, the insert. The caller has checked rx.share.
 */
export async function createShareLinkIn(
  tx: TenantTx,
  ctx: ServiceContext,
  input: { prescriptionId: string; channel: ShareChannel },
  now: Date,
): Promise<Result<CreatedLink>> {
  const [rx] = await tx
    .select({ id: prescriptions.id, status: prescriptions.status, rxNo: prescriptions.rxNo, renderSnapshot: prescriptions.renderSnapshot, version: prescriptions.version, patientId: visits.patientId })
    .from(prescriptions)
    .innerJoin(visits, eq(visits.id, prescriptions.visitId))
    .where(and(eq(prescriptions.tenantId, ctx.tenantId), eq(prescriptions.id, input.prescriptionId)))
    .limit(1);
  if (!rx) return fail("not_found", MESSAGES.notFound);
  if (rx.status === "draft") return fail("conflict", MESSAGES.draft);
  if (rx.status !== "finalized" || rx.rxNo === null) return fail("conflict", MESSAGES.superseded);
  if (!hasFinalSnapshot(rx.status, rx.renderSnapshot)) return fail("conflict", MESSAGES.noSnapshot);

  const [patient] = await tx
    .select({ id: patients.id })
    .from(patients)
    .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, rx.patientId), isNull(patients.deletedAt)))
    .limit(1)
    .for("share");
  if (!patient) return fail("not_found", "Patient not found.");
  const clinic = await primaryClinic(tx, ctx.tenantId);
  if (!clinic?.sharingEnabled) return fail("unavailable", MESSAGES.off);
  const consent = await currentSharingConsentIn(tx, ctx.tenantId, rx.patientId);
  if (!consent?.granted) return fail("conflict", MESSAGES.consent, "consent");

  const [{ value: recent }] = await tx
    .select({ value: count() })
    .from(shareLinks)
    .where(and(eq(shareLinks.tenantId, ctx.tenantId), eq(shareLinks.createdBy, ctx.userId), gte(shareLinks.createdAt, new Date(now.getTime() - HOUR_MS))));
  if (recent >= SHARE_LIMITS.linksPerUserPerHour) return fail("unavailable", MESSAGES.tooManyRecent);
  const [{ value: active }] = await tx
    .select({ value: count() })
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.tenantId, ctx.tenantId),
        eq(shareLinks.prescriptionId, rx.id),
        isNull(shareLinks.revokedAt),
        gt(shareLinks.expiresAt, now),
        lt(shareLinks.openCount, shareLinks.maxOpens),
      ),
    );
  if (active >= SHARE_LIMITS.activeLinksPerPrescription) return fail("conflict", MESSAGES.tooManyActive);

  const token = newShareToken();
  const expiresAt = new Date(now.getTime() + SHARE_LIMITS.ttlDays * DAY_MS);
  const [link] = await tx
    .insert(shareLinks)
    .values({
      tenantId: ctx.tenantId,
      prescriptionId: rx.id,
      consentId: consent.id,
      tokenHash: shareTokenHash(token),
      channel: input.channel,
      createdBy: ctx.userId,
      createdAt: now,
      expiresAt,
      maxOpens: SHARE_LIMITS.maxOpens,
    })
    .returning({ id: shareLinks.id });
  await recordAudit(tx, ctx, {
    action: "prescription.share_link_created",
    entityType: "prescription",
    entityId: rx.id,
    after: { linkId: link.id, channel: input.channel, expiresAt: expiresAt.toISOString(), maxOpens: SHARE_LIMITS.maxOpens },
  });
  return ok({ linkId: link.id, token, expiresAt, prescriptionId: rx.id, patientId: rx.patientId, rxNo: rx.rxNo, version: rx.version });
}

/** The links of one prescription, newest first, each with the masked recipient of its latest share-log row. */
export async function listShareLinksIn(tx: TenantTx, tenantId: string, prescriptionId: string, now: Date): Promise<ShareLinkView[]> {
  const links = await tx
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.tenantId, tenantId), eq(shareLinks.prescriptionId, prescriptionId)))
    .orderBy(desc(shareLinks.createdAt), desc(shareLinks.id));
  if (links.length === 0) return [];
  const shares = await tx
    .select({ linkId: prescriptionShares.shareLinkId, recipientMasked: prescriptionShares.recipientMasked })
    .from(prescriptionShares)
    .where(and(eq(prescriptionShares.tenantId, tenantId), inArray(prescriptionShares.shareLinkId, links.map((l) => l.id))))
    .orderBy(desc(prescriptionShares.createdAt));
  const recipient = new Map<string, string>();
  for (const s of shares) if (!recipient.has(s.linkId)) recipient.set(s.linkId, s.recipientMasked);
  return links.map((l) => ({
    id: l.id,
    channel: l.channel as ShareChannel,
    recipientMasked: recipient.get(l.id) ?? null,
    createdAt: l.createdAt,
    expiresAt: l.expiresAt,
    openCount: l.openCount,
    maxOpens: l.maxOpens,
    status: linkStatus(l, now),
    revokeReason: l.revokeReason,
  }));
}

export async function listShareLinks(ctx: ServiceContext, prescriptionId: string): Promise<Result<ShareLinkView[]>> {
  if (!can(ctx.role, "rx.share")) return fail("forbidden", "You cannot share prescriptions.");
  if (!isUuid(prescriptionId)) return fail("not_found", MESSAGES.notFound);
  return withTenant(ctx.tenantId, async (tx) => ok(await listShareLinksIn(tx, ctx.tenantId, prescriptionId, new Date())));
}

/** Withdraws one link at once (the patient's copy stops opening). */
export async function revokeShareLink(ctx: ServiceContext, linkId: string): Promise<Result<null>> {
  if (!can(ctx.role, "rx.share")) return fail("forbidden", "You cannot share prescriptions.");
  if (!isUuid(linkId)) return fail("not_found", MESSAGES.linkNotFound);
  return withTenant(ctx.tenantId, async (tx): Promise<Result<null>> => {
    const [link] = await tx
      .select({ id: shareLinks.id, prescriptionId: shareLinks.prescriptionId, revokedAt: shareLinks.revokedAt })
      .from(shareLinks)
      .where(and(eq(shareLinks.tenantId, ctx.tenantId), eq(shareLinks.id, linkId)))
      .limit(1);
    if (!link) return fail("not_found", MESSAGES.linkNotFound);
    if (link.revokedAt !== null) return fail("conflict", MESSAGES.alreadyRevoked);
    const updated = await tx
      .update(shareLinks)
      .set({ revokedAt: new Date(), revokedBy: ctx.userId, revokeReason: "user" })
      .where(and(eq(shareLinks.id, linkId), isNull(shareLinks.revokedAt)))
      .returning({ id: shareLinks.id });
    if (updated.length === 0) return fail("conflict", MESSAGES.alreadyRevoked);
    await recordAudit(tx, ctx, { action: "prescription.share_revoked", entityType: "prescription", entityId: link.prescriptionId, after: { linkId } });
    return ok(null);
  });
}


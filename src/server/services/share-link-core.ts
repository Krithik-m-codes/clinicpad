import { fail } from "@/lib/result";

export const SHARE_LIMITS = { ttlDays: 7, maxOpens: 10, linksPerUserPerHour: 60, activeLinksPerPrescription: 10 } as const;
export type ShareChannel = "whatsapp" | "email";
export type ShareLinkStatus = "active" | "expired" | "used_up" | "revoked";
export type ShareLinkView = {
  id: string;
  channel: ShareChannel;
  recipientMasked: string | null;
  createdAt: Date;
  expiresAt: Date;
  openCount: number;
  maxOpens: number;
  status: ShareLinkStatus;
  revokeReason: string | null;
};
export type CreatedLink = { linkId: string; token: string; expiresAt: Date; prescriptionId: string; patientId: string; rxNo: number; version: number };
export type ShareLinkSummary = { linkId: string; tenantId: string; expiresAt: Date; remainingOpens: number; timeZone: string };

/** One message for every unusable link, whatever the reason (decision 6). */
export const linkGone = () => fail("not_found", "This link is not valid.");

export function linkStatus(link: { revokedAt: Date | null; expiresAt: Date; openCount: number; maxOpens: number }, now: Date): ShareLinkStatus {
  if (link.revokedAt !== null) return "revoked";
  if (link.expiresAt.getTime() <= now.getTime()) return "expired";
  if (link.openCount >= link.maxOpens) return "used_up";
  return "active";
}


/**
 * Only a signed copy that holds its finalize-time snapshot is shared. A row finalized before print snapshots existed
 * would be rendered from live data (today's clinic details on an old pad), which is not what the doctor signed.
 */
export function hasFinalSnapshot(status: string, renderSnapshot: unknown): boolean {
  return status !== "draft" && renderSnapshot !== null && renderSnapshot !== undefined;
}

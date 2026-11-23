import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
// patients and prescriptions are only used inside the lazy config callbacks below, so the import cycle with
// clinical.ts (which references shareLinks the same way) is safe.
import { patients, prescriptions } from "./clinical";
import { tenants } from "./tenancy";

const pk = () => uuid("id").primaryKey().$defaultFn(() => uuidv7());
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * DPDP-style consent as an append-only event log (Plan 1D): the latest row per patient and purpose is the current
 * state; withdrawal is a row with granted = false. Never updated or deleted (0022).
 */
export const patientConsents = pgTable(
  "patient_consents",
  {
    id: pk(),
    tenantId: tenantId(),
    patientId: uuid("patient_id").notNull(),
    purpose: text("purpose").notNull(),
    version: text("version").notNull(),
    granted: boolean("granted").notNull(),
    method: text("method").notNull(),
    capturedBy: uuid("captured_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("patient_consents_tenant_id_uq").on(t.tenantId, t.id),
    index("patient_consents_patient_idx").on(t.tenantId, t.patientId, t.purpose, t.createdAt),
    foreignKey({ name: "patient_consents_patient_fk", columns: [t.tenantId, t.patientId], foreignColumns: [patients.tenantId, patients.id] }),
    check("patient_consents_purpose_check", sql`purpose in ('sharing')`),
    check("patient_consents_method_check", sql`method in ('verbal', 'written')`),
    check("patient_consents_version_check", sql`version ~ '^[a-z]+-v[0-9]{1,3}$'`),
  ],
);

/**
 * A short-lived public link to one finalized prescription. Only the SHA-256 of the token is stored. The runtime role
 * may count an open (+1) and revoke once; nothing else changes and nothing is deleted (0022).
 */
export const shareLinks = pgTable(
  "share_links",
  {
    id: pk(),
    tenantId: tenantId(),
    prescriptionId: uuid("prescription_id").notNull(),
    consentId: uuid("consent_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    channel: text("channel").notNull(),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    maxOpens: integer("max_opens").notNull(),
    openCount: integer("open_count").notNull().default(0),
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    revokeReason: text("revoke_reason"),
  },
  (t) => [
    unique("share_links_tenant_id_uq").on(t.tenantId, t.id),
    unique("share_links_token_hash_uq").on(t.tokenHash),
    index("share_links_prescription_idx").on(t.tenantId, t.prescriptionId, t.createdAt),
    index("share_links_creator_idx").on(t.tenantId, t.createdBy, t.createdAt),
    index("share_links_consent_idx").on(t.tenantId, t.consentId),
    foreignKey({
      name: "share_links_prescription_fk",
      columns: [t.tenantId, t.prescriptionId],
      foreignColumns: [prescriptions.tenantId, prescriptions.id],
    }).onDelete("cascade"),
    foreignKey({ name: "share_links_consent_fk", columns: [t.tenantId, t.consentId], foreignColumns: [patientConsents.tenantId, patientConsents.id] }),
    check("share_links_channel_check", sql`channel in ('whatsapp', 'email')`),
    check("share_links_token_hash_check", sql`token_hash ~ '^[0-9a-f]{64}$'`),
    check("share_links_opens_check", sql`max_opens between 1 and 50 and open_count between 0 and max_opens`),
    check("share_links_expiry_check", sql`expires_at > created_at and expires_at <= created_at + interval '31 days'`),
    check("share_links_revoked_by_check", sql`revoked_by is null or revoked_at is not null`),
    check(
      "share_links_revocation_check",
      sql`(revoked_at is null) = (revoke_reason is null) and (revoke_reason is null or revoke_reason in ('user', 'consent_withdrawn', 'patient_archived', 'send_failed'))`,
    ),
  ],
);

/** Append-only share log: one row per WhatsApp message prepared or email sent/failed. Recipients are masked, never stored in full. */
export const prescriptionShares = pgTable(
  "prescription_shares",
  {
    id: pk(),
    tenantId: tenantId(),
    prescriptionId: uuid("prescription_id").notNull(),
    shareLinkId: uuid("share_link_id").notNull(),
    channel: text("channel").notNull(),
    recipientMasked: text("recipient_masked").notNull(),
    provider: text("provider").notNull(),
    status: text("status").notNull(),
    providerMessageId: text("provider_message_id"),
    errorCode: text("error_code"),
    actorUserId: uuid("actor_user_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("rx_shares_prescription_idx").on(t.tenantId, t.prescriptionId, t.createdAt),
    index("rx_shares_link_idx").on(t.tenantId, t.shareLinkId),
    foreignKey({
      name: "rx_shares_prescription_fk",
      columns: [t.tenantId, t.prescriptionId],
      foreignColumns: [prescriptions.tenantId, prescriptions.id],
    }).onDelete("cascade"),
    foreignKey({ name: "rx_shares_link_fk", columns: [t.tenantId, t.shareLinkId], foreignColumns: [shareLinks.tenantId, shareLinks.id] }).onDelete("cascade"),
    check("rx_shares_channel_check", sql`channel in ('whatsapp', 'email')`),
    check("rx_shares_provider_check", sql`provider in ('wa_link', 'resend', 'fake')`),
    check("rx_shares_status_check", sql`status in ('prepared', 'sent', 'failed')`),
    check("rx_shares_recipient_check", sql`char_length(recipient_masked) between 1 and 64`),
    check("rx_shares_recipient_masked_check", sql`recipient_masked like '%*%' and recipient_masked !~ '[0-9]{5}'`),
    check(
      "rx_shares_provider_channel_check",
      sql`(channel = 'whatsapp' and provider in ('wa_link', 'fake')) or (channel = 'email' and provider in ('resend', 'fake'))`,
    ),
    check("rx_shares_wa_link_check", sql`provider <> 'wa_link' or (status = 'prepared' and provider_message_id is null and error_code is null)`),
    check("rx_shares_failed_check", sql`error_code is null or status = 'failed'`),
    check("rx_shares_error_check", sql`error_code is null or error_code ~ '^[a-z_]{1,40}$'`),
    check("rx_shares_message_id_check", sql`provider_message_id is null or char_length(provider_message_id) <= 200`),
  ],
);

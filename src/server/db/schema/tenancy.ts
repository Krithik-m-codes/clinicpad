import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { bytea } from "./columns";
import { memberRole, memberStatus, tenantPlan } from "./enums";
// templates is only used inside the lazy config callbacks below (clinics.custom_template_id, doctors.template_id),
// so the import cycle with templates.ts (which references tenants and doctors the same way) is safe.
import { templates } from "./templates";

const pk = () => uuid("id").primaryKey().$defaultFn(() => uuidv7());
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable(
  "tenants",
  {
    id: pk(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    region: text("region").notNull().default("ap-south-1"),
    plan: tenantPlan("plan").notNull().default("free"),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [unique("tenants_slug_unique").on(t.slug)],
);

/**
 * Uploaded clinic images (logo, doctor signature). Immutable: the runtime role can insert
 * and read but never update or delete. Finalized prescriptions reference these ids in
 * their print snapshot, so a reprint keeps the image it was finalized with.
 */
export const clinicAssets = pgTable(
  "clinic_assets",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    mime: text("mime").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    bytes: bytea("bytes").notNull(),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    // Target of the composite same-tenant foreign keys from clinics and doctors (ADR-0025 pattern).
    unique("clinic_assets_tenant_id_uq").on(t.tenantId, t.id),
    unique("clinic_assets_dedupe_key").on(t.tenantId, t.kind, t.sha256),
    // Declared here as well as in SQL (0014, 0015) so drizzle-kit knows them; tests/integration/schema-checks.test.ts pins the list.
    check("clinic_assets_kind_check", sql`kind in ('logo', 'signature')`),
    check("clinic_assets_mime_check", sql`mime in ('image/png', 'image/jpeg')`),
    check("clinic_assets_size_check", sql`byte_size between 1 and 524288 and octet_length(bytes) = byte_size`),
    check("clinic_assets_dimensions_check", sql`width between 16 and 2000 and height between 16 and 2000`),
    check("clinic_assets_sha256_check", sql`sha256 ~ '^[0-9a-f]{64}$'`),
    check("clinic_assets_hash_matches_check", sql`sha256 = encode(sha256(bytes), 'hex')`),
  ],
);

export const clinics = pgTable(
  "clinics",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    addressLine1: text("address_line1"),
    city: text("city"),
    state: text("state"),
    pincode: text("pincode"),
    country: text("country").notNull().default("IN"),
    timezone: text("timezone").notNull().default("Asia/Kolkata"),
    currency: text("currency").notNull().default("INR"),
    logoUrl: text("logo_url"),
    addressLine2: text("address_line2"),
    phone: text("phone"),
    email: text("email"),
    padFooter: text("pad_footer"),
    rxTemplate: text("rx_template").notNull().default("general"),
    rxPaperSize: text("rx_paper_size").notNull().default("A4"),
    rxLabels: text("rx_labels").notNull().default("en"),
    logoAssetId: uuid("logo_asset_id"),
    /** Sharing by link (WhatsApp, email) is off until the owner turns it on (Plan 1D). Turning it off kills every link of the clinic. */
    sharingEnabled: boolean("sharing_enabled").notNull().default(false),
    /** The clinic's default custom pad (Plan 2A). null: the built-in rx_template applies, as before. */
    customTemplateId: uuid("custom_template_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("clinics_tenant_idx").on(t.tenantId),
    // Target of the composite same-tenant foreign keys (a foreign key needs a unique key to point at).
    unique("clinics_tenant_id_uq").on(t.tenantId, t.id),
    // Same-tenant reference to the current logo. NO ACTION: the runtime role can never delete assets.
    foreignKey({
      name: "clinics_logo_asset_fk",
      columns: [t.tenantId, t.logoAssetId],
      foreignColumns: [clinicAssets.tenantId, clinicAssets.id],
    }),
    index("clinics_tenant_custom_template_idx").on(t.tenantId, t.customTemplateId),
    foreignKey({ name: "clinics_custom_template_fk", columns: [t.tenantId, t.customTemplateId], foreignColumns: [templates.tenantId, templates.id] }),
    check("clinics_rx_template_check", sql`rx_template in ('general', 'paediatric', 'derma')`),
    check("clinics_rx_paper_size_check", sql`rx_paper_size in ('A4', 'A5')`),
    check("clinics_rx_labels_check", sql`rx_labels in ('en', 'hi', 'bilingual')`),
  ],
);

export const branches = pgTable(
  "branches",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clinicId: uuid("clinic_id").notNull(),
    name: text("name").notNull(),
    address: text("address"),
    phone: text("phone"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("branches_tenant_idx").on(t.tenantId),
    index("branches_clinic_idx").on(t.clinicId),
    unique("branches_tenant_id_uq").on(t.tenantId, t.id),
    // Same-tenant reference: a branch can only belong to a clinic of its own tenant.
    foreignKey({
      name: "branches_clinic_fk",
      columns: [t.tenantId, t.clinicId],
      foreignColumns: [clinics.tenantId, clinics.id],
    }).onDelete("cascade"),
  ],
);

export const users = pgTable(
  "users",
  {
    id: pk(),
    email: text("email").notNull(),
    phone: text("phone"),
    name: text("name").notNull(),
    passwordHash: text("password_hash"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique("users_email_unique").on(t.email),
    unique("users_phone_unique").on(t.phone),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull(),
    status: memberStatus("status").notNull().default("active"),
    // Set for temporary members (designers, Plan 2A); null means the membership does not expire.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("memberships_tenant_user_unique").on(t.tenantId, t.userId),
    index("memberships_user_idx").on(t.userId),
    // A designer (concierge template setup, Plan 2A) is a temporary member: the membership must expire. The role is
    // compared as text because a new enum value cannot be used in the migration that adds it (one transaction).
    check("memberships_designer_expiry_check", sql`role::text <> 'designer' or expires_at is not null`),
    check("memberships_expiry_check", sql`expires_at is null or expires_at > created_at`),
  ],
);

export const doctors = pgTable(
  "doctors",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    primaryBranchId: uuid("primary_branch_id"),
    regNo: text("reg_no"),
    qualifications: text("qualifications"),
    specialties: text("specialties").array(),
    signatureUrl: text("signature_url"),
    stampUrl: text("stamp_url"),
    displayName: text("display_name"),
    designation: text("designation"),
    registrationCouncil: text("registration_council"),
    signatureAssetId: uuid("signature_asset_id"),
    /** This doctor's own custom pad (Plan 2A); wins over the clinic default when usable (decision 9). */
    templateId: uuid("template_id"),
    consultationFeePaise: integer("consultation_fee_paise").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("doctors_tenant_idx").on(t.tenantId),
    index("doctors_user_idx").on(t.userId),
    // Target of the composite same-tenant foreign keys from visits.doctor_id and medicine_favourites.doctor_id.
    unique("doctors_tenant_id_uq").on(t.tenantId, t.id),
    // One doctor profile per user per clinic, so the user -> doctor lookup (doctorIdFor) is deterministic.
    unique("doctors_tenant_user_uq").on(t.tenantId, t.userId),
    // Same-tenant reference. The delete rule is ON DELETE SET NULL (primary_branch_id): a plain composite SET NULL
    // would also try to null tenant_id (NOT NULL). drizzle-kit cannot express the column list, so the migration
    // (0009) is hand-edited; keep it in step with this definition.
    foreignKey({
      name: "doctors_primary_branch_fk",
      columns: [t.tenantId, t.primaryBranchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("set null"),
    // Same-tenant reference to the current signature (NO ACTION, as for the clinic logo).
    foreignKey({
      name: "doctors_signature_asset_fk",
      columns: [t.tenantId, t.signatureAssetId],
      foreignColumns: [clinicAssets.tenantId, clinicAssets.id],
    }),
    index("doctors_tenant_template_idx").on(t.tenantId, t.templateId),
    foreignKey({ name: "doctors_template_fk", columns: [t.tenantId, t.templateId], foreignColumns: [templates.tenantId, templates.id] }),
  ],
);

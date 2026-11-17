import {
  boolean,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { memberRole, memberStatus, tenantPlan } from "./enums";

const pk = () => uuid("id").primaryKey().$defaultFn(() => uuidv7());
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * Raw bytes. postgres-js returns bytea as a Buffer, but it sends an untyped Buffer parameter as raw text
 * (a NUL byte, as in any PNG, then fails with 22021), so writes go as bytea hex text (`\x...`).
 */
const bytea = customType<{ data: Buffer; driverData: Buffer | string }>({
  dataType() {
    return "bytea";
  },
  toDriver(value) {
    return `\\x${value.toString("hex")}`;
  },
  fromDriver(value) {
    return typeof value === "string" ? Buffer.from(value.replace(/^\\x/, ""), "hex") : value;
  },
});

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
    createdAt: createdAt(),
  },
  (t) => [
    unique("memberships_tenant_user_unique").on(t.tenantId, t.userId),
    index("memberships_user_idx").on(t.userId),
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
  ],
);

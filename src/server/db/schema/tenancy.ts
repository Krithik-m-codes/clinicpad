import {
  boolean,
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
    createdAt: createdAt(),
  },
  (t) => [index("clinics_tenant_idx").on(t.tenantId)],
);

export const branches = pgTable(
  "branches",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    address: text("address"),
    phone: text("phone"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("branches_tenant_idx").on(t.tenantId),
    index("branches_clinic_idx").on(t.clinicId),
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
    primaryBranchId: uuid("primary_branch_id").references(() => branches.id, {
      onDelete: "set null",
    }),
    regNo: text("reg_no"),
    qualifications: text("qualifications"),
    specialties: text("specialties").array(),
    signatureUrl: text("signature_url"),
    stampUrl: text("stamp_url"),
    consultationFeePaise: integer("consultation_fee_paise").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("doctors_tenant_idx").on(t.tenantId),
    index("doctors_user_idx").on(t.userId),
  ],
);

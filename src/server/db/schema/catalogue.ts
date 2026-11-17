import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { doctors, memberships, tenants } from "./tenancy";

const pk = () => uuid("id").primaryKey().$defaultFn(() => uuidv7());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const doseSlot = (name: string) => numeric(name, { precision: 5, scale: 2, mode: "number" });

/**
 * Read-only reference medicines shared by every clinic, loaded from sample_data by
 * `npm run db:seed:catalogue`. No tenant_id by design: the app role can only SELECT.
 */
export const globalMedicines = pgTable(
  "global_medicines",
  {
    id: pk(),
    name: text("name").notNull(),
    genericName: text("generic_name"),
    nameKey: text("name_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("global_medicines_name_key_unique").on(t.nameKey)],
);

/** Read-only suggestion lists: kind is complaint | diagnosis | history | test. */
export const globalClinicalTerms = pgTable(
  "global_clinical_terms",
  {
    id: pk(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    icd10Code: text("icd10_code"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("global_terms_kind_key_unique").on(t.kind, t.nameKey),
    check("global_terms_kind_check", sql`kind in ('complaint', 'diagnosis', 'history', 'test')`),
  ],
);

/** Medicines a clinic added itself. Visible only inside that clinic (RLS). */
export const tenantMedicines = pgTable(
  "tenant_medicines",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    genericName: text("generic_name"),
    nameKey: text("name_key").notNull(),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("tenant_medicines_tenant_key_unique").on(t.tenantId, t.nameKey),
    // Same-tenant reference to the member who added it (ADR-0025 pattern on memberships' (tenant_id, user_id) key).
    // The delete rule is ON DELETE SET NULL (created_by), hand-written in 0018: a plain composite SET NULL would null tenant_id.
    foreignKey({
      name: "tenant_medicines_created_by_fk",
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }).onDelete("set null"),
  ],
);

/**
 * A doctor's saved default line for one medicine (one per medicine name per doctor profile).
 * The composite key keeps a favourite inside its doctor's clinic (ADR-0025); deleting the
 * doctor profile deletes its favourites.
 */
export const medicineFavourites = pgTable(
  "medicine_favourites",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    doctorId: uuid("doctor_id").notNull(),
    nameKey: text("name_key").notNull(),
    drugName: text("drug_name").notNull(),
    genericName: text("generic_name"),
    strength: text("strength"),
    form: text("form"),
    route: text("route"),
    dose: text("dose"),
    doseMorning: doseSlot("dose_morning"),
    doseAfternoon: doseSlot("dose_afternoon"),
    doseEvening: doseSlot("dose_evening"),
    doseNight: doseSlot("dose_night"),
    timing: text("timing"),
    foodRelation: text("food_relation"),
    periodicity: text("periodicity"),
    isSos: boolean("is_sos").notNull().default(false),
    durationValue: integer("duration_value"),
    durationUnit: text("duration_unit"),
    remarks: text("remarks"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("medicine_favourites_doctor_key_unique").on(t.tenantId, t.doctorId, t.nameKey),
    index("medicine_favourites_doctor_idx").on(t.tenantId, t.doctorId),
    // Same-tenant reference (ADR-0025); doctors_tenant_id_uq exists since migration 0010.
    foreignKey({
      name: "medicine_favourites_doctor_fk",
      columns: [t.tenantId, t.doctorId],
      foreignColumns: [doctors.tenantId, doctors.id],
    }).onDelete("cascade"),
    check("favourites_duration_unit_check", sql`duration_unit is null or duration_unit in ('days', 'weeks', 'months')`),
    check("favourites_periodicity_check", sql`periodicity is null or periodicity in ('daily', 'alternate_day', 'twice_weekly', 'weekly', 'every_5th_day', 'fortnightly', 'monthly', 'as_needed')`),
    check(
      "favourites_dose_slots_check",
      sql`(dose_morning is null or (dose_morning between 0 and 99 and dose_morning * 4 = trunc(dose_morning * 4))) and (dose_afternoon is null or (dose_afternoon between 0 and 99 and dose_afternoon * 4 = trunc(dose_afternoon * 4))) and (dose_evening is null or (dose_evening between 0 and 99 and dose_evening * 4 = trunc(dose_evening * 4))) and (dose_night is null or (dose_night between 0 and 99 and dose_night * 4 = trunc(dose_night * 4)))`,
    ),
    check("favourites_duration_value_check", sql`duration_value is null or duration_value between 1 and 365`),
  ],
);

import {
  boolean,
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
import { uuidv7 } from "uuidv7";
import { doctors, tenants } from "./tenancy";

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
  (t) => [unique("global_terms_kind_key_unique").on(t.kind, t.nameKey)],
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
  (t) => [unique("tenant_medicines_tenant_key_unique").on(t.tenantId, t.nameKey)],
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
  ],
);

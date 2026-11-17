import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Investigation, Vitals } from "../../../lib/domain/rx-options";
import { patientImports } from "./imports";
import { branches, doctors, tenants } from "./tenancy";

const pk = () => uuid("id").primaryKey().$defaultFn(() => uuidv7());
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const patients = pgTable(
  "patients",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    patientNo: integer("patient_no"),
    name: text("name").notNull(),
    phone: text("phone"),
    phoneNormalized: text("phone_normalized"),
    dob: date("dob"),
    gender: text("gender"),
    address: text("address"),
    abha: text("abha"),
    allergies: text("allergies").array(),
    conditions: text("conditions").array(),
    notes: text("notes"),
    /** The import that created this patient (Plan 1D), and the row key that makes a re-run idempotent. */
    importId: uuid("import_id"),
    importRowKey: text("import_row_key"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("patients_tenant_name_idx").on(t.tenantId, t.name),
    index("patients_tenant_phone_idx").on(t.tenantId, t.phoneNormalized),
    unique("patients_tenant_no_unique").on(t.tenantId, t.patientNo),
    // Target of the composite same-tenant foreign keys (a foreign key needs a unique key to point at).
    unique("patients_tenant_id_uq").on(t.tenantId, t.id),
    // Same-tenant reference to the import job (ADR-0025 pattern). NO ACTION: import rows are never deleted while the tenant exists.
    foreignKey({
      name: "patients_import_fk",
      columns: [t.tenantId, t.importId],
      foreignColumns: [patientImports.tenantId, patientImports.id],
    }),
    index("patients_tenant_import_idx").on(t.tenantId, t.importId),
    // A re-run of the same file finds its rows here instead of creating them again.
    uniqueIndex("patients_import_row_key_uq").on(t.tenantId, t.importRowKey).where(sql`${t.importRowKey} is not null`),
    check("patients_import_row_key_check", sql`import_row_key is null or import_row_key ~ '^[0-9a-f]{64}$'`),
  ],
);

export const visits = pgTable(
  "visits",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    patientId: uuid("patient_id").notNull(),
    doctorId: uuid("doctor_id"),
    branchId: uuid("branch_id"),
    status: text("status").notNull().default("draft"),
    visitType: text("visit_type").notNull().default("new"),
    chiefComplaint: text("chief_complaint"),
    vitals: jsonb("vitals").$type<Vitals>(),
    diagnosis: text("diagnosis").array(),
    advice: text("advice"),
    followUpDate: date("follow_up_date"),
    complaints: text("complaints").array(),
    medicalHistory: text("medical_history").array(),
    drugHistory: text("drug_history").array(),
    examinationNotes: text("examination_notes"),
    investigations: jsonb("investigations").$type<Investigation[]>(),
    followUpReason: text("follow_up_reason"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("visits_tenant_patient_idx").on(t.tenantId, t.patientId),
    // Offboarding and history scans by doctor or branch (Plan 1D).
    index("visits_tenant_doctor_idx").on(t.tenantId, t.doctorId),
    index("visits_tenant_branch_idx").on(t.tenantId, t.branchId),
    check("visits_status_check", sql`status in ('draft', 'finalized')`),
    unique("visits_tenant_id_uq").on(t.tenantId, t.id),
    // Same-tenant reference: a visit can only belong to a patient of its own tenant.
    foreignKey({
      name: "visits_patient_fk",
      columns: [t.tenantId, t.patientId],
      foreignColumns: [patients.tenantId, patients.id],
    }).onDelete("restrict"),
    // Same-tenant references, both optional. The delete rule is ON DELETE SET NULL (doctor_id) / (branch_id):
    // drizzle-kit cannot express the column list, so migration 0010 is hand-edited; keep it in step. Deleting a
    // doctor or branch that a finalized visit references fails (the SET NULL is an UPDATE the trigger refuses).
    foreignKey({
      name: "visits_doctor_fk",
      columns: [t.tenantId, t.doctorId],
      foreignColumns: [doctors.tenantId, doctors.id],
    }).onDelete("set null"),
    foreignKey({
      name: "visits_branch_fk",
      columns: [t.tenantId, t.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("set null"),
  ],
);

export const prescriptions = pgTable(
  "prescriptions",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    visitId: uuid("visit_id").notNull(),
    rxNo: integer("rx_no"),
    version: integer("version").notNull().default(1),
    /** Optimistic-concurrency counter for draft saves (Plan 1B). Frozen with the row at finalize. */
    draftRevision: integer("draft_revision").notNull().default(0),
    status: text("status").notNull().default("draft"),
    templateVersionId: uuid("template_version_id"),
    pdfUrl: text("pdf_url"),
    parentPrescriptionId: uuid("parent_prescription_id"),
    amendmentReason: text("amendment_reason"),
    finalizedBy: uuid("finalized_by"),
    /** What the printed pad shows, frozen by finalize (Plan 1C). Parse with parseRenderSnapshot(). */
    renderSnapshot: jsonb("render_snapshot").$type<unknown>(),
    updatedAt: updatedAt(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("prescriptions_tenant_rx_version_unique").on(t.tenantId, t.rxNo, t.version),
    index("prescriptions_visit_idx").on(t.visitId),
    index("prescriptions_tenant_template_version_idx").on(t.tenantId, t.templateVersionId),
    index("prescriptions_tenant_parent_idx").on(t.tenantId, t.parentPrescriptionId),
    check("prescriptions_status_check", sql`status in ('draft', 'finalized', 'amended')`),
    check("prescriptions_not_own_parent_check", sql`parent_prescription_id is distinct from id`),
    uniqueIndex("prescriptions_one_open_amendment")
      .on(t.parentPrescriptionId)
      .where(sql`${t.status} = 'draft' and ${t.parentPrescriptionId} is not null`),
    unique("prescriptions_tenant_id_uq").on(t.tenantId, t.id),
    // Same-tenant references. parent_prescription_id is nullable: a composite key is MATCH SIMPLE, so a NULL
    // there skips the check (tenant_id is NOT NULL).
    foreignKey({
      name: "prescriptions_visit_fk",
      columns: [t.tenantId, t.visitId],
      foreignColumns: [visits.tenantId, visits.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "prescriptions_parent_fk",
      columns: [t.tenantId, t.parentPrescriptionId],
      foreignColumns: [t.tenantId, t.id],
    }),
    // Same-tenant reference, optional; ON DELETE SET NULL (template_version_id) is hand-written in migration 0010.
    foreignKey({
      name: "prescriptions_template_version_fk",
      columns: [t.tenantId, t.templateVersionId],
      foreignColumns: [templateVersions.tenantId, templateVersions.id],
    }).onDelete("set null"),
  ],
);

export const prescriptionItems = pgTable(
  "prescription_items",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    prescriptionId: uuid("prescription_id").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    drugName: text("drug_name").notNull(),
    strength: text("strength"),
    form: text("form"),
    route: text("route"),
    dose: text("dose"),
    timing: text("timing"),
    foodRelation: text("food_relation"),
    durationDays: integer("duration_days"),
    remarks: text("remarks"),
    genericName: text("generic_name"),
    doseMorning: numeric("dose_morning", { precision: 5, scale: 2, mode: "number" }),
    doseAfternoon: numeric("dose_afternoon", { precision: 5, scale: 2, mode: "number" }),
    doseEvening: numeric("dose_evening", { precision: 5, scale: 2, mode: "number" }),
    doseNight: numeric("dose_night", { precision: 5, scale: 2, mode: "number" }),
    periodicity: text("periodicity"),
    isSos: boolean("is_sos").notNull().default(false),
    durationValue: integer("duration_value"),
    durationUnit: text("duration_unit"),
    createdAt: createdAt(),
  },
  (t) => [
    index("rx_items_prescription_idx").on(t.prescriptionId),
    // The item trigger also checks this; the key makes it a structural guarantee.
    foreignKey({
      name: "rx_items_prescription_fk",
      columns: [t.tenantId, t.prescriptionId],
      foreignColumns: [prescriptions.tenantId, prescriptions.id],
    }).onDelete("cascade"),
    // The database refuses what Zod refuses (src/server/validation/prescription.ts); 0012 and 0018.
    check("rx_items_duration_unit_check", sql`duration_unit is null or duration_unit in ('days', 'weeks', 'months')`),
    check("rx_items_periodicity_check", sql`periodicity is null or periodicity in ('daily', 'alternate_day', 'twice_weekly', 'weekly', 'every_5th_day', 'fortnightly', 'monthly', 'as_needed')`),
    check(
      "rx_items_dose_slots_check",
      sql`(dose_morning is null or (dose_morning between 0 and 99 and dose_morning * 4 = trunc(dose_morning * 4))) and (dose_afternoon is null or (dose_afternoon between 0 and 99 and dose_afternoon * 4 = trunc(dose_afternoon * 4))) and (dose_evening is null or (dose_evening between 0 and 99 and dose_evening * 4 = trunc(dose_evening * 4))) and (dose_night is null or (dose_night between 0 and 99 and dose_night * 4 = trunc(dose_night * 4)))`,
    ),
    check("rx_items_duration_value_check", sql`duration_value is null or duration_value between 1 and 365`),
    check("rx_items_duration_days_check", sql`duration_days is null or duration_days between 1 and 365`),
  ],
);

export const templates = pgTable(
  "templates",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("html"),
    status: text("status").notNull().default("draft"),
    createdAt: createdAt(),
  },
  (t) => [
    index("templates_tenant_idx").on(t.tenantId),
    // Target of the composite same-tenant foreign key from template_versions.
    unique("templates_tenant_id_uq").on(t.tenantId, t.id),
  ],
);

export const templateVersions = pgTable(
  "template_versions",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    templateId: uuid("template_id").notNull(),
    version: integer("version").notNull(),
    fileKey: text("file_key"),
    mapping: jsonb("mapping").$type<Record<string, string>>(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // Target of the composite same-tenant foreign key from prescriptions.template_version_id.
    unique("template_versions_tenant_id_uq").on(t.tenantId, t.id),
    unique("template_versions_template_version_unique").on(t.templateId, t.version),
    // Same-tenant reference: a version can only belong to a template of its own tenant.
    foreignKey({
      name: "template_versions_template_fk",
      columns: [t.tenantId, t.templateId],
      foreignColumns: [templates.tenantId, templates.id],
    }).onDelete("cascade"),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_tenant_created_idx").on(t.tenantId, t.createdAt)],
);

/** Per-tenant gap-free-on-commit sequences: name is "patient" or "rx". */
export const tenantCounters = pgTable(
  "tenant_counters",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    lastNo: integer("last_no").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.name] })],
);

/**
 * Append-only log of every print and PDF download of a finalized prescription: who, when,
 * which layout, and the SHA-256 of the exact HTML that was rendered. Replaces the
 * printed_at / pdf_url columns, which cannot be written once a prescription is frozen.
 */
export const prescriptionOutputs = pgTable(
  "prescription_outputs",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    prescriptionId: uuid("prescription_id").notNull(),
    actorUserId: uuid("actor_user_id"),
    kind: text("kind").notNull(),
    templateKey: text("template_key").notNull(),
    paperSize: text("paper_size").notNull(),
    pageCount: integer("page_count"),
    byteSize: integer("byte_size"),
    htmlSha256: text("html_sha256").notNull(),
    // Presentation (templates, labels, CSS, fonts) is not frozen; the renderer version that drew this output is.
    rendererVersion: text("renderer_version"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "rx_outputs_prescription_fk",
      columns: [t.tenantId, t.prescriptionId],
      foreignColumns: [prescriptions.tenantId, prescriptions.id],
    }).onDelete("cascade"),
    index("rx_outputs_prescription_idx").on(t.tenantId, t.prescriptionId, t.createdAt),
    check("rx_outputs_kind_check", sql`kind in ('pdf_download', 'browser_print')`),
    check("rx_outputs_paper_size_check", sql`paper_size in ('A4', 'A5')`),
    check("rx_outputs_page_count_check", sql`page_count is null or page_count between 1 and 50`),
    check("rx_outputs_byte_size_check", sql`byte_size is null or byte_size >= 0`),
    check("rx_outputs_sha256_check", sql`html_sha256 ~ '^[0-9a-f]{64}$'`),
    check("rx_outputs_template_key_check", sql`template_key in ('general', 'paediatric', 'derma')`),
  ],
);
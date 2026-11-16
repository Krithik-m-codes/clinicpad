import {
  date,
  foreignKey,
  index,
  integer,
  jsonb,
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
    vitals: jsonb("vitals").$type<Record<string, string | number>>(),
    diagnosis: text("diagnosis").array(),
    advice: text("advice"),
    followUpDate: date("follow_up_date"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("visits_tenant_patient_idx").on(t.tenantId, t.patientId),
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
    status: text("status").notNull().default("draft"),
    templateVersionId: uuid("template_version_id"),
    pdfUrl: text("pdf_url"),
    parentPrescriptionId: uuid("parent_prescription_id"),
    amendmentReason: text("amendment_reason"),
    finalizedBy: uuid("finalized_by"),
    updatedAt: updatedAt(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("prescriptions_tenant_rx_version_unique").on(t.tenantId, t.rxNo, t.version),
    index("prescriptions_visit_idx").on(t.visitId),
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

import { sql } from "drizzle-orm";
import { type AnyPgColumn, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { bytea } from "./columns";
// tenants and doctors are only used inside lazy callbacks (references() and the config callbacks), so the import
// cycle with tenancy.ts is safe, as for sharing.ts <-> clinical.ts.
import { doctors, tenants } from "./tenancy";

const pk = () => uuid("id").primaryKey().$defaultFn(() => uuidv7());
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * templates and template_versions reference each other. The explicit return types keep TypeScript from inferring
 * the two tables in a circle (TS7022); the helpers are called only inside lazy config callbacks.
 */
const versionCols = (): { tenantId: AnyPgColumn; id: AnyPgColumn } => templateVersions;
const templateCols = (): { tenantId: AnyPgColumn; id: AnyPgColumn } => templates;

/**
 * Uploaded template files (Plan 2A: pad backgrounds). Only scanned, validated, metadata-stripped bytes are ever
 * stored; the original upload and its file name never are. Immutable (0026): insert and read; the runtime role may
 * delete only a file no version uses and older than a day (garbage collection). `storage` is the seam for object
 * storage (ADR-0047); every read goes through loadTemplateFileIn().
 */
export const templateFiles = pgTable(
  "template_files",
  {
    id: pk(),
    tenantId: tenantId(),
    kind: text("kind").notNull(),
    mime: text("mime").notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    sha256: text("sha256").notNull(),
    bytes: bytea("bytes").notNull(),
    scanEngine: text("scan_engine").notNull(),
    storage: text("storage").notNull().default("pg"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("template_files_tenant_id_uq").on(t.tenantId, t.id),
    unique("template_files_dedupe_key").on(t.tenantId, t.kind, t.sha256),
    // Keep in step with BACKGROUND_LIMITS (src/lib/domain/image.ts). The cap is 1 MB (overrides 3 and 16b).
    check("template_files_kind_check", sql`kind in ('background_image')`),
    check("template_files_mime_check", sql`mime in ('image/png', 'image/jpeg')`),
    check("template_files_size_check", sql`byte_size between 1 and 1048576 and octet_length(bytes) = byte_size`),
    check("template_files_dimensions_check", sql`greatest(width, height) between 1100 and 3600 and least(width, height) >= 1`),
    check("template_files_aspect_check", sql`abs(greatest(width, height)::numeric / least(width, height) - 1.41421356) <= 0.0425`),
    check("template_files_sha256_check", sql`sha256 ~ '^[0-9a-f]{64}$'`),
    check("template_files_hash_matches_check", sql`sha256 = encode(sha256(bytes), 'hex')`),
    check("template_files_scan_engine_check", sql`length(scan_engine) between 1 and 200`),
    check("template_files_storage_check", sql`storage in ('pg')`),
  ],
);

/**
 * A clinic's own pad template (built-in pads are code, not rows). Never deleted once a version was published.
 * The identity binding lives on the VERSION (override 2), not here.
 */
export const templates = pgTable(
  "templates",
  {
    id: pk(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("active"),
    currentVersionId: uuid("current_version_id"),
    createdBy: uuid("created_by"),
    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (t) => [
    index("templates_tenant_idx").on(t.tenantId),
    // Target of the composite same-tenant foreign keys from template_versions, clinics and doctors.
    unique("templates_tenant_id_uq").on(t.tenantId, t.id),
    index("templates_tenant_current_version_idx").on(t.tenantId, t.currentVersionId),
    check("templates_kind_check", sql`kind in ('overlay')`),
    check("templates_status_check", sql`status in ('active', 'archived')`),
    check("templates_name_check", sql`length(name) between 1 and 120`),
    foreignKey({ name: "templates_current_version_fk", columns: [t.tenantId, t.currentVersionId], foreignColumns: [versionCols().tenantId, versionCols().id] }),
  ],
);

/**
 * One version of a template. Born as a draft (a working copy, edited in place under draft_revision); published
 * by an UPDATE that sets content_sha256 and the binding; frozen afterwards on every connection (0026).
 */
export const templateVersions = pgTable(
  "template_versions",
  {
    id: pk(),
    tenantId: tenantId(),
    templateId: uuid("template_id").notNull(),
    version: integer("version").notNull(),
    state: text("state").notNull().default("draft"),
    fileId: uuid("file_id").notNull(),
    /** overlay: overlayDefinitionSchema v1 (src/lib/rx-render/overlay-definition.ts). Parse, never trust. */
    definition: jsonb("definition").$type<unknown>().notNull(),
    paperSize: text("paper_size").notNull(),
    labels: text("labels").notNull(),
    /** dynamic: prints the signing doctor from data; bound: the letterhead shows bound_doctor_id's identity (decision 9). Set at publish. */
    identity: text("identity").notNull().default("dynamic"),
    boundDoctorId: uuid("bound_doctor_id"),
    /** The publisher confirmed the letterhead shows the bound doctor's name and registration number. Set at publish. */
    boundConfirmed: boolean("bound_confirmed").notNull().default(false),
    contentSha256: text("content_sha256"),
    draftRevision: integer("draft_revision").notNull().default(0),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: uuid("published_by"),
    createdBy: uuid("created_by"),
    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (t) => [
    // Target of the composite same-tenant foreign keys from prescriptions, prescription_outputs and templates.
    unique("template_versions_tenant_id_uq").on(t.tenantId, t.id),
    unique("template_versions_template_version_unique").on(t.templateId, t.version),
    index("template_versions_tenant_file_idx").on(t.tenantId, t.fileId),
    index("template_versions_tenant_bound_doctor_idx").on(t.tenantId, t.boundDoctorId),
    foreignKey({
      name: "template_versions_template_fk",
      columns: [t.tenantId, t.templateId],
      foreignColumns: [templateCols().tenantId, templateCols().id],
    }).onDelete("cascade"),
    foreignKey({ name: "template_versions_file_fk", columns: [t.tenantId, t.fileId], foreignColumns: [templateFiles.tenantId, templateFiles.id] }),
    foreignKey({ name: "template_versions_bound_doctor_fk", columns: [t.tenantId, t.boundDoctorId], foreignColumns: [doctors.tenantId, doctors.id] }),
    check("template_versions_state_check", sql`state in ('draft', 'published')`),
    check("template_versions_version_check", sql`version between 1 and 100000`),
    check("template_versions_paper_size_check", sql`paper_size in ('A4', 'A5')`),
    check("template_versions_labels_check", sql`labels in ('en', 'hi', 'bilingual')`),
    check("template_versions_identity_check", sql`identity in ('dynamic', 'bound')`),
    check("template_versions_bound_doctor_check", sql`(identity = 'bound') = (bound_doctor_id is not null)`),
    // Confirmation belongs to bound versions only, and a published bound version is always confirmed.
    check("template_versions_bound_confirmed_check", sql`(identity = 'bound' or not bound_confirmed) and (state = 'draft' or identity = 'dynamic' or bound_confirmed)`),
    check("template_versions_published_check", sql`(state = 'published') = (published_at is not null and content_sha256 is not null)`),
    check("template_versions_sha256_check", sql`content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'`),
    check("template_versions_definition_check", sql`jsonb_typeof(definition) = 'object' and octet_length(definition::text) <= 65536`),
    check("template_versions_revision_check", sql`draft_revision >= 0`),
  ],
);

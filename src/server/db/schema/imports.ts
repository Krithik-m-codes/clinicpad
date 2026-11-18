import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { tenants } from "./tenancy";

/**
 * One row per committed patient import: who, when, the file's SHA-256 and the outcome counts. Append-only for the
 * runtime role and immutable on every connection (0020). Imported patients point at it (patients.import_id).
 */
export const patientImports = pgTable(
  "patient_imports",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id"),
    fileSha256: text("file_sha256").notNull(),
    rowCount: integer("row_count").notNull(),
    createdCount: integer("created_count").notNull(),
    filledCount: integer("filled_count").notNull(),
    skippedCount: integer("skipped_count").notNull(),
    alreadyImportedCount: integer("already_imported_count").notNull(),
    invalidCount: integer("invalid_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Target of the composite same-tenant key from patients.import_id.
    unique("patient_imports_tenant_id_uq").on(t.tenantId, t.id),
    index("patient_imports_tenant_created_idx").on(t.tenantId, t.createdAt),
    check("patient_imports_sha256_check", sql`file_sha256 ~ '^[0-9a-f]{64}$'`),
    check(
      "patient_imports_counts_check",
      sql`row_count between 0 and 5000 and created_count >= 0 and filled_count >= 0 and skipped_count >= 0 and already_imported_count >= 0 and invalid_count >= 0 and created_count + filled_count + skipped_count + already_imported_count + invalid_count = row_count`,
    ),
  ],
);

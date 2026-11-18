CREATE TABLE "patient_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"file_sha256" text NOT NULL,
	"row_count" integer NOT NULL,
	"created_count" integer NOT NULL,
	"filled_count" integer NOT NULL,
	"skipped_count" integer NOT NULL,
	"already_imported_count" integer NOT NULL,
	"invalid_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_imports_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "patient_imports_sha256_check" CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "patient_imports_counts_check" CHECK (row_count between 0 and 5000 and created_count >= 0 and filled_count >= 0 and skipped_count >= 0 and already_imported_count >= 0 and invalid_count >= 0 and created_count + filled_count + skipped_count + already_imported_count + invalid_count = row_count)
);
--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "import_id" uuid;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "import_row_key" text;--> statement-breakpoint
ALTER TABLE "patient_imports" ADD CONSTRAINT "patient_imports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_imports_tenant_created_idx" ON "patient_imports" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_import_fk" FOREIGN KEY ("tenant_id","import_id") REFERENCES "public"."patient_imports"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patients_tenant_import_idx" ON "patients" USING btree ("tenant_id","import_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patients_import_row_key_uq" ON "patients" USING btree ("tenant_id","import_row_key") WHERE "patients"."import_row_key" is not null;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_import_row_key_check" CHECK (import_row_key is null or import_row_key ~ '^[0-9a-f]{64}$');
-- Plan 2A templates (generated, hand-edited): template files, the template model (the identity binding lives on
-- template_versions, set at publish), assignment columns, and the columns that pin outputs and prescriptions to a
-- template version. CHECKs on tables that already have rows (prescriptions, prescription_outputs) are added NOT VALID
-- and validated here (existing rows pass; a dirty development database is swept first, see 0024).
CREATE TABLE "template_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"sha256" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"scan_engine" text NOT NULL,
	"storage" text DEFAULT 'pg' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_files_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "template_files_dedupe_key" UNIQUE("tenant_id","kind","sha256"),
	CONSTRAINT "template_files_kind_check" CHECK (kind in ('background_image')),
	CONSTRAINT "template_files_mime_check" CHECK (mime in ('image/png', 'image/jpeg')),
	CONSTRAINT "template_files_size_check" CHECK (byte_size between 1 and 1048576 and octet_length(bytes) = byte_size),
	CONSTRAINT "template_files_dimensions_check" CHECK (greatest(width, height) between 1100 and 3600 and least(width, height) >= 1),
	CONSTRAINT "template_files_aspect_check" CHECK (abs(greatest(width, height)::numeric / least(width, height) - 1.41421356) <= 0.0425),
	CONSTRAINT "template_files_sha256_check" CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "template_files_hash_matches_check" CHECK (sha256 = encode(sha256(bytes), 'hex')),
	CONSTRAINT "template_files_scan_engine_check" CHECK (length(scan_engine) between 1 and 200),
	CONSTRAINT "template_files_storage_check" CHECK (storage in ('pg'))
);
--> statement-breakpoint
ALTER TABLE "prescription_outputs" DROP CONSTRAINT "rx_outputs_template_key_check";--> statement-breakpoint
ALTER TABLE "templates" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "templates" ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "custom_template_id" uuid;--> statement-breakpoint
ALTER TABLE "doctors" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "prescription_outputs" ADD COLUMN "template_version_id" uuid;--> statement-breakpoint
ALTER TABLE "prescription_outputs" ADD COLUMN "engine" text;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "state" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "file_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "definition" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "paper_size" text NOT NULL;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "labels" text NOT NULL;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "identity" text DEFAULT 'dynamic' NOT NULL;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "bound_doctor_id" uuid;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "bound_confirmed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "content_sha256" text;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "draft_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "published_by" uuid;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "current_version_id" uuid;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "template_files" ADD CONSTRAINT "template_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_custom_template_fk" FOREIGN KEY ("tenant_id","custom_template_id") REFERENCES "public"."templates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."templates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_outputs" ADD CONSTRAINT "rx_outputs_template_version_fk" FOREIGN KEY ("tenant_id","template_version_id") REFERENCES "public"."template_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_file_fk" FOREIGN KEY ("tenant_id","file_id") REFERENCES "public"."template_files"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_bound_doctor_fk" FOREIGN KEY ("tenant_id","bound_doctor_id") REFERENCES "public"."doctors"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_current_version_fk" FOREIGN KEY ("tenant_id","current_version_id") REFERENCES "public"."template_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinics_tenant_custom_template_idx" ON "clinics" USING btree ("tenant_id","custom_template_id");--> statement-breakpoint
CREATE INDEX "doctors_tenant_template_idx" ON "doctors" USING btree ("tenant_id","template_id");--> statement-breakpoint
CREATE INDEX "rx_outputs_template_version_idx" ON "prescription_outputs" USING btree ("tenant_id","template_version_id");--> statement-breakpoint
CREATE INDEX "template_versions_tenant_file_idx" ON "template_versions" USING btree ("tenant_id","file_id");--> statement-breakpoint
CREATE INDEX "template_versions_tenant_bound_doctor_idx" ON "template_versions" USING btree ("tenant_id","bound_doctor_id");--> statement-breakpoint
CREATE INDEX "templates_tenant_current_version_idx" ON "templates" USING btree ("tenant_id","current_version_id");--> statement-breakpoint
ALTER TABLE "prescription_outputs" ADD CONSTRAINT "rx_outputs_template_version_check" CHECK ((template_key = 'overlay') = (template_version_id is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "prescription_outputs" VALIDATE CONSTRAINT "rx_outputs_template_version_check";--> statement-breakpoint
ALTER TABLE "prescription_outputs" ADD CONSTRAINT "rx_outputs_engine_check" CHECK (engine is null or engine in ('chromium', 'browser')) NOT VALID;--> statement-breakpoint
ALTER TABLE "prescription_outputs" VALIDATE CONSTRAINT "rx_outputs_engine_check";--> statement-breakpoint
ALTER TABLE "prescription_outputs" ADD CONSTRAINT "rx_outputs_template_key_check" CHECK (template_key in ('general', 'paediatric', 'derma', 'overlay')) NOT VALID;--> statement-breakpoint
ALTER TABLE "prescription_outputs" VALIDATE CONSTRAINT "rx_outputs_template_key_check";--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_template_version_snapshot_check" CHECK (status = 'draft' or render_snapshot is null or template_version_id is null or (render_snapshot #>> '{layout,template,templateVersionId}') is not distinct from template_version_id::text) NOT VALID;--> statement-breakpoint
ALTER TABLE "prescriptions" VALIDATE CONSTRAINT "prescriptions_template_version_snapshot_check";--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_state_check" CHECK (state in ('draft', 'published'));--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_version_check" CHECK (version between 1 and 100000);--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_paper_size_check" CHECK (paper_size in ('A4', 'A5'));--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_labels_check" CHECK (labels in ('en', 'hi', 'bilingual'));--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_identity_check" CHECK (identity in ('dynamic', 'bound'));--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_bound_doctor_check" CHECK ((identity = 'bound') = (bound_doctor_id is not null));--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_bound_confirmed_check" CHECK ((identity = 'bound' or not bound_confirmed) and (state = 'draft' or identity = 'dynamic' or bound_confirmed));--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_published_check" CHECK ((state = 'published') = (published_at is not null and content_sha256 is not null));--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_sha256_check" CHECK (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_definition_check" CHECK (jsonb_typeof(definition) = 'object' and octet_length(definition::text) <= 65536);--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_revision_check" CHECK (draft_revision >= 0);--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_kind_check" CHECK (kind in ('overlay'));--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_status_check" CHECK (status in ('active', 'archived'));--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_name_check" CHECK (length(name) between 1 and 120);
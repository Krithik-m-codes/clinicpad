CREATE TABLE "clinic_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_assets_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "clinic_assets_dedupe_key" UNIQUE("tenant_id","kind","sha256")
);
--> statement-breakpoint
CREATE TABLE "prescription_outputs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"prescription_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"kind" text NOT NULL,
	"template_key" text NOT NULL,
	"paper_size" text NOT NULL,
	"page_count" integer,
	"byte_size" integer,
	"html_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "address_line2" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "pad_footer" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "rx_template" text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "rx_paper_size" text DEFAULT 'A4' NOT NULL;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "rx_labels" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "logo_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "doctors" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "doctors" ADD COLUMN "designation" text;--> statement-breakpoint
ALTER TABLE "doctors" ADD COLUMN "registration_council" text;--> statement-breakpoint
ALTER TABLE "doctors" ADD COLUMN "signature_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "render_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "clinic_assets" ADD CONSTRAINT "clinic_assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_outputs" ADD CONSTRAINT "prescription_outputs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_outputs" ADD CONSTRAINT "rx_outputs_prescription_fk" FOREIGN KEY ("tenant_id","prescription_id") REFERENCES "public"."prescriptions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rx_outputs_prescription_idx" ON "prescription_outputs" USING btree ("tenant_id","prescription_id","created_at");--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_logo_asset_fk" FOREIGN KEY ("tenant_id","logo_asset_id") REFERENCES "public"."clinic_assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_signature_asset_fk" FOREIGN KEY ("tenant_id","signature_asset_id") REFERENCES "public"."clinic_assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;
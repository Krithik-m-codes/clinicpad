CREATE TABLE "global_clinical_terms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"icd10_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "global_terms_kind_key_unique" UNIQUE("kind","name_key")
);
--> statement-breakpoint
CREATE TABLE "global_medicines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"generic_name" text,
	"name_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "global_medicines_name_key_unique" UNIQUE("name_key")
);
--> statement-breakpoint
CREATE TABLE "medicine_favourites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"name_key" text NOT NULL,
	"drug_name" text NOT NULL,
	"generic_name" text,
	"strength" text,
	"form" text,
	"route" text,
	"dose" text,
	"dose_morning" numeric(5, 2),
	"dose_afternoon" numeric(5, 2),
	"dose_evening" numeric(5, 2),
	"dose_night" numeric(5, 2),
	"timing" text,
	"food_relation" text,
	"periodicity" text,
	"is_sos" boolean DEFAULT false NOT NULL,
	"duration_value" integer,
	"duration_unit" text,
	"remarks" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medicine_favourites_doctor_key_unique" UNIQUE("tenant_id","doctor_id","name_key")
);
--> statement-breakpoint
CREATE TABLE "tenant_medicines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"generic_name" text,
	"name_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_medicines_tenant_key_unique" UNIQUE("tenant_id","name_key")
);
--> statement-breakpoint
ALTER TABLE "prescription_items" ADD COLUMN "generic_name" text;--> statement-breakpoint
ALTER TABLE "prescription_items" ADD COLUMN "dose_morning" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "prescription_items" ADD COLUMN "dose_afternoon" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "prescription_items" ADD COLUMN "dose_evening" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "prescription_items" ADD COLUMN "dose_night" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "prescription_items" ADD COLUMN "periodicity" text;--> statement-breakpoint
ALTER TABLE "prescription_items" ADD COLUMN "is_sos" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "prescription_items" ADD COLUMN "duration_value" integer;--> statement-breakpoint
ALTER TABLE "prescription_items" ADD COLUMN "duration_unit" text;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "draft_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "complaints" text[];--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "medical_history" text[];--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "drug_history" text[];--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "examination_notes" text;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "investigations" jsonb;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "follow_up_reason" text;--> statement-breakpoint
ALTER TABLE "medicine_favourites" ADD CONSTRAINT "medicine_favourites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_favourites" ADD CONSTRAINT "medicine_favourites_doctor_fk" FOREIGN KEY ("tenant_id","doctor_id") REFERENCES "public"."doctors"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_medicines" ADD CONSTRAINT "tenant_medicines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "medicine_favourites_doctor_idx" ON "medicine_favourites" USING btree ("tenant_id","doctor_id");
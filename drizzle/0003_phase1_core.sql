CREATE TABLE "tenant_counters" (
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"last_no" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "tenant_counters_tenant_id_name_pk" PRIMARY KEY("tenant_id","name")
);
--> statement-breakpoint
ALTER TABLE "prescriptions" ALTER COLUMN "rx_no" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "patient_no" integer;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "parent_prescription_id" uuid;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "amendment_reason" text;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "finalized_by" uuid;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_counters" ADD CONSTRAINT "tenant_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_parent_prescription_id_prescriptions_id_fk" FOREIGN KEY ("parent_prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prescriptions_one_open_amendment" ON "prescriptions" USING btree ("parent_prescription_id") WHERE "prescriptions"."status" = 'draft' and "prescriptions"."parent_prescription_id" is not null;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_tenant_no_unique" UNIQUE("tenant_id","patient_no");
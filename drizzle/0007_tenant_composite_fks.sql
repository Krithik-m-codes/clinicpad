-- Same-tenant references enforced by the database (AGENTS.md invariant 1).
-- RLS only checks a row's own tenant_id and foreign-key checks run without RLS, so a single-column key could
-- point at another tenant's row. Every relation below becomes a composite key (tenant_id, x_id) ->
-- parent(tenant_id, id), with the same delete rule as before.
--
-- Hand-edited after `drizzle-kit generate`: it emitted the ADD FOREIGN KEY statements before the UNIQUE
-- constraints they reference, which cannot be applied. Order here: drop old keys, add the unique targets, add
-- the new keys. Nothing else was changed.
ALTER TABLE "prescription_items" DROP CONSTRAINT "prescription_items_prescription_id_prescriptions_id_fk";
--> statement-breakpoint
ALTER TABLE "prescriptions" DROP CONSTRAINT "prescriptions_visit_id_visits_id_fk";
--> statement-breakpoint
ALTER TABLE "prescriptions" DROP CONSTRAINT "prescriptions_parent_prescription_id_prescriptions_id_fk";
--> statement-breakpoint
ALTER TABLE "visits" DROP CONSTRAINT "visits_patient_id_patients_id_fk";
--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_tenant_id_uq" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_tenant_id_uq" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_tenant_id_uq" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "prescription_items" ADD CONSTRAINT "rx_items_prescription_fk" FOREIGN KEY ("tenant_id","prescription_id") REFERENCES "public"."prescriptions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_visit_fk" FOREIGN KEY ("tenant_id","visit_id") REFERENCES "public"."visits"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_parent_fk" FOREIGN KEY ("tenant_id","parent_prescription_id") REFERENCES "public"."prescriptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;

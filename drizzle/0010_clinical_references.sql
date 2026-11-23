-- Same-tenant references for the last tenant-owned columns that had no foreign key at all (AGENTS.md invariant 1),
-- in the composite pattern of 0007 and 0009, plus one doctor profile per user per clinic.
--
-- Hand-edited after `drizzle-kit generate`, nothing else was changed:
--  1. It emitted the ADD FOREIGN KEY statements before the UNIQUE constraints they reference, which cannot be
--     applied. Order here: the unique targets first, then the keys.
--  2. Each key is ON DELETE SET NULL (column) (Postgres 15+). drizzle-kit emits a plain SET NULL, which on a
--     composite key would also try to null tenant_id (NOT NULL).
-- Deleting a doctor, branch or template version that a finalized record references is refused by the immutability
-- triggers (the SET NULL is an UPDATE of a signed row). Tenant offboarding still works: the tenant-level cascades
-- delete the visits and prescriptions before these nested SET NULL actions run
-- (tests/integration/clinical-references.test.ts).
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_tenant_id_uq" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_tenant_user_uq" UNIQUE("tenant_id","user_id");--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_tenant_id_uq" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_template_version_fk" FOREIGN KEY ("tenant_id","template_version_id") REFERENCES "public"."template_versions"("tenant_id","id") ON DELETE set null ("template_version_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_doctor_fk" FOREIGN KEY ("tenant_id","doctor_id") REFERENCES "public"."doctors"("tenant_id","id") ON DELETE set null ("doctor_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE set null ("branch_id") ON UPDATE no action;

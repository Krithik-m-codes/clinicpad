-- Same-tenant references for the remaining Phase 0 relations (AGENTS.md invariant 1), as 0007 did for the
-- clinical tables. RLS only checks a row's own tenant_id and foreign-key checks run without RLS, so a single-column
-- key could point at another tenant's row. Each relation below becomes a composite key (tenant_id, x_id) ->
-- parent(tenant_id, id), with the same delete rule as before.
--
-- Hand-edited after `drizzle-kit generate`, nothing else was changed:
--  1. It emitted the ADD FOREIGN KEY statements before the UNIQUE constraints they reference, which cannot be
--     applied. Order here: drop old keys, add the unique targets, add the new keys.
--  2. doctors_primary_branch_fk is ON DELETE SET NULL (primary_branch_id) (Postgres 15+). drizzle-kit emits a plain
--     SET NULL, which on a composite key would also try to null tenant_id (NOT NULL) and fail the branch delete.
ALTER TABLE "branches" DROP CONSTRAINT "branches_clinic_id_clinics_id_fk";
--> statement-breakpoint
ALTER TABLE "doctors" DROP CONSTRAINT "doctors_primary_branch_id_branches_id_fk";
--> statement-breakpoint
ALTER TABLE "template_versions" DROP CONSTRAINT "template_versions_template_id_templates_id_fk";
--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_uq" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_tenant_id_uq" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_tenant_id_uq" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_clinic_fk" FOREIGN KEY ("tenant_id","clinic_id") REFERENCES "public"."clinics"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_primary_branch_fk" FOREIGN KEY ("tenant_id","primary_branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE set null ("primary_branch_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."templates"("tenant_id","id") ON DELETE cascade ON UPDATE no action;

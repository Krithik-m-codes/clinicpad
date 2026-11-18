-- Plan 2A (generated, hand-edited): template_versions loses the two Phase 0 placeholders nothing ever wrote. The
-- guard stops here when a development database still holds template rows from old tests, because 0025 adds NOT NULL
-- columns to template_versions. row_security is switched off for the count so that forced RLS can never hide rows
-- (the count would then be wrong, or the statement fails loudly); it is switched back on straight after.
set local row_security = off;
--> statement-breakpoint
do $$
begin
  if exists (select 1 from public.templates) or exists (select 1 from public.template_versions) then
    raise exception 'templates or template_versions hold rows: run "npm run db:sweep-test-tenants -- --apply" first (Plan 2A Task 7)';
  end if;
end $$;
--> statement-breakpoint
set local row_security = on;
--> statement-breakpoint
ALTER TABLE "template_versions" DROP COLUMN "file_key";--> statement-breakpoint
ALTER TABLE "template_versions" DROP COLUMN "mapping";

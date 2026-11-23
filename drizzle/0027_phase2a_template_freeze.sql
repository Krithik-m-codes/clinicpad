-- Plan 2A, Task 13: freeze what a finalized prescription prints on (custom migration on top of the generated CHECKs).
-- 1. CHECKs. The prescriptions CHECK loses its "render_snapshot is null" escape: a finalized row that names a template
--    version must carry a snapshot that names the same one. The two template_versions CHECKs are new. All three are
--    added NOT VALID and validated in this file (rows that exist already pass; on a dirty development database run
--    npm run db:sweep-test-tenants first).
ALTER TABLE "prescriptions" DROP CONSTRAINT "prescriptions_template_version_snapshot_check";--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_template_version_snapshot_check" CHECK (status = 'draft' or template_version_id is null or (render_snapshot #>> '{layout,template,templateVersionId}') is not distinct from template_version_id::text) NOT VALID;--> statement-breakpoint
ALTER TABLE "prescriptions" VALIDATE CONSTRAINT "prescriptions_template_version_snapshot_check";--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_confirmed_published_check" CHECK (not bound_confirmed or state = 'published') NOT VALID;--> statement-breakpoint
ALTER TABLE "template_versions" VALIDATE CONSTRAINT "template_versions_confirmed_published_check";--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_published_by_check" CHECK (state = 'draft' or published_by is not null) NOT VALID;--> statement-breakpoint
ALTER TABLE "template_versions" VALIDATE CONSTRAINT "template_versions_published_by_check";--> statement-breakpoint

-- 2. Template files: created_at is the database's clock. A client cannot backdate a file past the one-day rule that
--    protects a file a draft is about to use (tests backdate through replica mode, which skips this trigger).
create or replace function public.enforce_template_file_rules() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    return new;
  end if;
  if public.tenant_is_erased(old.tenant_id) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'IMMUTABLE: template files cannot be changed' using errcode = '23000';
  end if;
  -- A file a version uses cannot be deleted (template_versions_file_fk answers 23503). A file younger than a day cannot
  -- be deleted either: a draft may be about to use it (the upload and the draft are separate requests).
  if old.created_at > now() - interval '1 day' then
    raise exception 'IMMUTABLE: a template file can be removed only when unused and older than a day' using errcode = '23000';
  end if;
  return old;
end $$;
--> statement-breakpoint
drop trigger template_files_rules on template_files;
--> statement-breakpoint
create trigger template_files_rules before insert or update or delete on template_files
  for each row execute function public.enforce_template_file_rules();
--> statement-breakpoint

-- 3. A prescription is finalized only on a published template version (or a built-in pad: no version). A snapshot that
--    names a template version must be an overlay snapshot (a snapshot cannot name a version without saying what it is),
--    and an overlay snapshot must come with its template_version_id column. Rows that are already frozen are the
--    immutability trigger's business (0005), so only the draft -> final transition is checked.
create or replace function public.enforce_rx_template_version() returns trigger language plpgsql as $$
declare
  v_state text;
  v_kind text;
  v_named text;
begin
  if new.status = 'draft' then return new; end if;
  if tg_op = 'UPDATE' and old.status <> 'draft' then return new; end if;
  v_kind := new.render_snapshot #>> '{layout,template,kind}';
  v_named := new.render_snapshot #>> '{layout,template,templateVersionId}';
  if v_named is not null and v_kind is distinct from 'overlay' then
    raise exception 'IMMUTABLE: a snapshot that names a template version must be an overlay snapshot' using errcode = '23000';
  end if;
  if new.template_version_id is null then
    if v_kind = 'overlay' then
      raise exception 'IMMUTABLE: a prescription finalized on an overlay pad must name its template version' using errcode = '23000';
    end if;
    return new;
  end if;
  select state into v_state from public.template_versions where id = new.template_version_id and tenant_id = new.tenant_id;
  if v_state is distinct from 'published' then
    raise exception 'IMMUTABLE: a prescription can only be finalized on a published template version' using errcode = '23000';
  end if;
  return new;
end $$;
--> statement-breakpoint

-- 4. Outputs (as 0026) in both directions: an output carries exactly its prescription's template version, so a built-in
--    output on an overlay prescription (no version) and an overlay output on a built-in prescription are both refused.
create or replace function public.enforce_rx_output_target() returns trigger language plpgsql as $$
declare
  rx_status text;
  rx_template_version uuid;
begin
  select status, template_version_id into rx_status, rx_template_version from public.prescriptions
    where id = new.prescription_id and tenant_id = new.tenant_id;
  if rx_status is null then
    raise exception 'prescription not found for this tenant' using errcode = '23503';
  end if;
  if rx_status not in ('finalized', 'amended') then
    raise exception 'IMMUTABLE: only finalized or amended prescriptions can be printed or downloaded' using errcode = '23000';
  end if;
  if new.template_version_id is distinct from rx_template_version then
    raise exception 'IMMUTABLE: an output names the template version its prescription was finalized with' using errcode = '23000';
  end if;
  return new;
end $$;

-- Plan 2A templates (custom migration): RLS and privileges for template files, and the rules that keep stored files
-- and published template versions immutable, pin a finalized prescription to a published version, and keep each output
-- on its prescription's version. templates and template_versions keep their 0002 tenant_isolation policy.

-- 1. Template files: forced RLS; the runtime role reads, inserts and (garbage collection only) deletes; never updates.
alter table template_files enable row level security;
--> statement-breakpoint
alter table template_files force row level security;
--> statement-breakpoint
create policy tenant_read on template_files for select using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
create policy tenant_insert on template_files for insert with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
create policy tenant_delete on template_files for delete using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, delete on template_files to clinicpad_app;
--> statement-breakpoint
revoke update, truncate on template_files from clinicpad_app;
--> statement-breakpoint
create or replace function public.enforce_template_file_rules() returns trigger language plpgsql as $$
begin
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
create trigger template_files_rules before update or delete on template_files
  for each row execute function public.enforce_template_file_rules();
--> statement-breakpoint

-- 2. A template's current version is one of its own published versions.
create or replace function public.enforce_template_rules() returns trigger language plpgsql as $$
declare
  v_template uuid;
  v_state text;
begin
  if new.current_version_id is not null and (tg_op = 'INSERT' or new.current_version_id is distinct from old.current_version_id) then
    select template_id, state into v_template, v_state from public.template_versions
      where id = new.current_version_id and tenant_id = new.tenant_id;
    if v_template is distinct from new.id or v_state is distinct from 'published' then
      raise exception 'IMMUTABLE: the current version of a template must be one of its published versions' using errcode = '23000';
    end if;
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger templates_rules before insert or update on templates
  for each row execute function public.enforce_template_rules();
--> statement-breakpoint

-- 3. Versions are born as drafts; a draft is a working copy (any change, or deletion); a published version never changes
--    (the identity binding included) and is never deleted while its tenant exists (so deleting a template with a
--    published version fails too). The BEFORE trigger answers 23000 ahead of the CHECKs, so an unknown state is 23000.
create or replace function public.enforce_template_version_rules() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'draft' or new.published_at is not null or new.published_by is not null or new.content_sha256 is not null then
      raise exception 'IMMUTABLE: a template version is created as a draft and published by an update' using errcode = '23000';
    end if;
    return new;
  end if;
  if old.state = 'published' then
    if public.tenant_is_erased(old.tenant_id) then
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end if;
    raise exception 'IMMUTABLE: a published template version cannot be changed or deleted' using errcode = '23000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
--> statement-breakpoint
create trigger template_versions_rules before insert or update or delete on template_versions
  for each row execute function public.enforce_template_version_rules();
--> statement-breakpoint

-- 4. A prescription is finalized only on a published template version (or a built-in pad: no version). An overlay
--    snapshot must come with its template_version_id column. Rows that are already frozen are the immutability
--    trigger's business (0005), so only the draft -> final transition is checked.
create or replace function public.enforce_rx_template_version() returns trigger language plpgsql as $$
declare
  v_state text;
begin
  if new.status = 'draft' then return new; end if;
  if tg_op = 'UPDATE' and old.status <> 'draft' then return new; end if;
  if new.template_version_id is null then
    if new.render_snapshot #>> '{layout,template,kind}' = 'overlay' then
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
create trigger prescriptions_template_version before insert or update on prescriptions
  for each row execute function public.enforce_rx_template_version();
--> statement-breakpoint

-- 5. Outputs (as 0015) plus: an output that names a template version names its prescription's own version.
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
  if new.template_version_id is not null and new.template_version_id is distinct from rx_template_version then
    raise exception 'IMMUTABLE: an output names the template version its prescription was finalized with' using errcode = '23000';
  end if;
  return new;
end $$;

-- Row-level security, privileges, closed vocabularies and the draft guard for the Plan 1C tables (custom migration).

-- 1. New tenant tables: forced RLS, and append-only for the runtime role (select + insert only), like audit_events.
alter table clinic_assets enable row level security;
alter table clinic_assets force row level security;
alter table prescription_outputs enable row level security;
alter table prescription_outputs force row level security;

create policy tenant_read on clinic_assets
  for select using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy tenant_insert on clinic_assets
  for insert with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy tenant_read on prescription_outputs
  for select using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy tenant_insert on prescription_outputs
  for insert with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- 0002's default privileges granted UPDATE/DELETE on every new table; take them back.
grant select, insert on clinic_assets, prescription_outputs to clinicpad_app;
revoke update, delete, truncate on clinic_assets, prescription_outputs from clinicpad_app;

-- 2. Closed vocabularies and caps, enforced here as well as in Zod and inspectImage().
alter table clinic_assets
  add constraint clinic_assets_kind_check check (kind in ('logo', 'signature')),
  add constraint clinic_assets_mime_check check (mime in ('image/png', 'image/jpeg')),
  add constraint clinic_assets_size_check check (byte_size between 1 and 524288 and octet_length(bytes) = byte_size),
  add constraint clinic_assets_dimensions_check check (width between 16 and 2000 and height between 16 and 2000),
  add constraint clinic_assets_sha256_check check (sha256 ~ '^[0-9a-f]{64}$');

alter table clinics
  add constraint clinics_rx_template_check check (rx_template in ('general', 'paediatric', 'derma')),
  add constraint clinics_rx_paper_size_check check (rx_paper_size in ('A4', 'A5')),
  add constraint clinics_rx_labels_check check (rx_labels in ('en', 'hi', 'bilingual'));

alter table prescription_outputs
  add constraint rx_outputs_kind_check check (kind in ('pdf_download', 'browser_print')),
  add constraint rx_outputs_paper_size_check check (paper_size in ('A4', 'A5')),
  add constraint rx_outputs_page_count_check check (page_count is null or page_count between 1 and 50),
  add constraint rx_outputs_byte_size_check check (byte_size is null or byte_size >= 0),
  add constraint rx_outputs_sha256_check check (html_sha256 ~ '^[0-9a-f]{64}$');

-- 3. Only finalized or amended prescriptions of the row's own tenant can be printed (same style as the 0006
--    item trigger: 23503 for a missing, invisible or foreign parent first, then 23000 for a draft).
--    The lookup runs as the caller, so RLS applies: another tenant's prescription reads as missing.
--    No FOR SHARE: an output never changes its prescription, and a status can only move away from draft.
create or replace function public.enforce_rx_output_target() returns trigger language plpgsql as $$
declare
  rx_status text;
begin
  select status into rx_status from public.prescriptions
    where id = new.prescription_id and tenant_id = new.tenant_id;
  if rx_status is null then
    raise exception 'prescription not found for this tenant' using errcode = '23503';
  end if;
  if rx_status = 'draft' then
    raise exception 'IMMUTABLE: drafts cannot be printed or downloaded' using errcode = '23000';
  end if;
  return new;
end $$;

create trigger prescription_outputs_target before insert on prescription_outputs
  for each row execute function public.enforce_rx_output_target();

-- 4. Printed doctor names for existing doctor rows. The runtime role cannot read users,
--    so the name is copied once here; doctors has no immutability trigger.
update doctors d
set display_name = u.name
from users u
where u.id = d.user_id and d.display_name is null;

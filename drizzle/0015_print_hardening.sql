-- Plan 1C hardening (custom migration): exact status allow-list for outputs, immutability of assets and outputs on
-- every connection (not only for the app role), hash integrity, and a closed template vocabulary.

-- 1. Outputs only for finalized or amended prescriptions (status is free text, so block by allow-list, not by 'draft').
create or replace function public.enforce_rx_output_target() returns trigger language plpgsql as $$
declare
  rx_status text;
begin
  select status into rx_status from public.prescriptions
    where id = new.prescription_id and tenant_id = new.tenant_id;
  if rx_status is null then
    raise exception 'prescription not found for this tenant' using errcode = '23503';
  end if;
  if rx_status not in ('finalized', 'amended') then
    raise exception 'IMMUTABLE: only finalized or amended prescriptions can be printed or downloaded' using errcode = '23000';
  end if;
  return new;
end $$;

-- 2. Assets and outputs never change while their tenant exists (offboarding, where the tenant row is already gone, may delete them).
create or replace function public.enforce_print_rows_immutable() returns trigger language plpgsql as $$
begin
  if public.tenant_is_erased(old.tenant_id) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception 'IMMUTABLE: % rows cannot be changed or deleted', tg_table_name using errcode = '23000';
end $$;

create trigger clinic_assets_immutable before update or delete on clinic_assets
  for each row execute function public.enforce_print_rows_immutable();
create trigger prescription_outputs_immutable before update or delete on prescription_outputs
  for each row execute function public.enforce_print_rows_immutable();

-- 3. Hash integrity, and the closed template vocabulary.
--    Keep this list in step with BUILTIN_TEMPLATES (src/lib/rx-render/types.ts); it is the only copy in SQL besides
--    clinics_rx_template_check (0014).
alter table clinic_assets
  add constraint clinic_assets_hash_matches_check check (sha256 = encode(sha256(bytes), 'hex'));
alter table prescription_outputs
  add constraint rx_outputs_template_key_check check (template_key in ('general', 'paediatric', 'derma'));

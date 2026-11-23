-- Tenant-boundary hardening on top of 0005. Forward-only: 0005 is already applied and tracked.
--
-- X. Items must fail CLOSED on an invisible or foreign parent.
--    0005 said a missing parent "counts as fine ... the foreign key rejects the row anyway". That is true
--    only for DELETE during a cascade. For INSERT and UPDATE it is wrong: foreign-key checks run without
--    RLS, so a parent the caller cannot see (another tenant's prescription) satisfies the key, while the
--    caller's own lookup finds nothing, which 0005 then read as "fine". Now the parent must exist, be a
--    draft and belong to the item's tenant.
--
-- Y. The runtime role can no longer delete tenants rows. The tenants row is the one gate that lets frozen
--    records be erased (see tenant_is_erased), so offboarding belongs to the admin connection.
--
-- Z. tenant_is_erased reads tenants as its owner. It now also sets row_security = off, so an owner that is
--    subject to RLS (neither superuser nor BYPASSRLS) makes the query raise instead of silently seeing no
--    rows and reporting every tenant as erased.

-- 1. (Y) Everything else the runtime role holds on tenants stays: it still reads and updates it.
revoke delete on public.tenants from clinicpad_app;

-- 2. (Z) Same helper as 0005 plus row_security = off. Still VOLATILE (the default) as the conservative choice.
create or replace function public.tenant_is_erased(p_tenant_id uuid) returns boolean
language sql security definer set search_path = pg_catalog set row_security = off
as $$ select not exists (select 1 from public.tenants where id = p_tenant_id) $$;
revoke all on function public.tenant_is_erased(uuid) from public;
grant execute on function public.tenant_is_erased(uuid) to clinicpad_app;

-- 3. (X) Items. Both parent lookups run as the caller, so RLS applies: another tenant's prescription is
--    invisible and reads as "not found".
--    INSERT: the new parent must exist, belong to the item's tenant and be a draft.
--    UPDATE: the same for BOTH the parent the item leaves and the one it joins.
--    DELETE: allowed when the parent is already gone (same cascade) or is a draft, or when the tenant is
--            being erased.
--    A parent that is missing, invisible or in another tenant raises 23503 (foreign_key_violation); a
--    parent that is not a draft raises 23000 (IMMUTABLE). The "not found" check comes first.
create or replace function public.enforce_rx_item_immutability() returns trigger language plpgsql as $$
declare
  old_status text;
  old_tenant uuid;
  new_status text;
  new_tenant uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select status, tenant_id into old_status, old_tenant
      from public.prescriptions where id = old.prescription_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select status, tenant_id into new_status, new_tenant
      from public.prescriptions where id = new.prescription_id;
  end if;

  if tg_op = 'DELETE' then
    if old_status is null or old_status = 'draft' then return old; end if;
    if public.tenant_is_erased(old.tenant_id) then return old; end if;
    raise exception 'IMMUTABLE: items of a finalized prescription cannot be changed' using errcode = '23000';
  end if;

  if new_status is null or new_tenant is distinct from new.tenant_id
     or (tg_op = 'UPDATE' and (old_status is null or old_tenant is distinct from new.tenant_id)) then
    raise exception 'prescription not found for this tenant' using errcode = '23503';
  end if;
  if new_status <> 'draft' or (tg_op = 'UPDATE' and old_status <> 'draft') then
    raise exception 'IMMUTABLE: items of a finalized prescription cannot be changed' using errcode = '23000';
  end if;
  return new;
end $$;

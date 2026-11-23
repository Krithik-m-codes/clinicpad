-- Race and visit-edit gaps in the immutability triggers. Forward-only: 0005 and 0006 are already applied.
--
-- 1. Races. Both parent lookups in the item trigger (0006) were plain SELECTs. While another transaction has
--    finalized a prescription but not committed yet, a plain SELECT still sees the old status ('draft') and lets
--    the item change through; item UPDATE and DELETE take no foreign-key lock on the parent, so nothing makes
--    them wait. If that transaction commits afterwards, a finalized prescription has changed items.
--    SELECT ... FOR SHARE conflicts with the row lock that the finalizing UPDATE holds, so the statement waits
--    for the other transaction to end and then reads the status it left behind (in READ COMMITTED the locked
--    row is re-read at its newest version). It needs UPDATE privilege on prescriptions, which clinicpad_app has,
--    and the rows must pass the tenant policy for UPDATE, which they do for the caller's own tenant.
--
-- 2. Visit guard. 0005 returned NEW for any draft visit, whatever its prescriptions looked like. When only the
--    prescription was finalized (the visit still a draft), the visit stayed freely editable: it could be moved
--    to another patient or have its advice or diagnosis rewritten, which changes what the finalized prescription
--    prints. Now, while any prescription of the visit is not a draft, the only UPDATE a draft visit accepts is
--    the plain flip to 'finalized' (status, finalized_at and updated_at may change; every other column may not).
--    The prescriptions are read FOR SHARE for the same race reason as above. The loop reads the status from the
--    locked row version, so a finalize that commits while we wait is seen.
--    Deadlock note: FOR SHARE here and the services' FOR UPDATE both take the prescription row first. A writer
--    that updated the visit row first and the prescription second could deadlock with a finalize; Postgres
--    would abort one of them with 40P01, never corrupt data.

-- 1. Items: identical to 0006 except `for share` on both parent lookups.
create or replace function public.enforce_rx_item_immutability() returns trigger language plpgsql as $$
declare
  old_status text;
  old_tenant uuid;
  new_status text;
  new_tenant uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select status, tenant_id into old_status, old_tenant
      from public.prescriptions where id = old.prescription_id for share;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select status, tenant_id into new_status, new_tenant
      from public.prescriptions where id = new.prescription_id for share;
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

-- 2. Visits: DELETE rules exactly as in 0005; UPDATE of a draft visit gains the prescription check.
create or replace function public.enforce_visit_immutability() returns trigger language plpgsql as $$
declare
  rx_status text;
  has_frozen_rx boolean := false;
begin
  if old.status = 'draft' then
    if tg_op = 'DELETE' then return old; end if;
    for rx_status in select status from public.prescriptions where visit_id = old.id for share loop
      if rx_status <> 'draft' then has_frozen_rx := true; end if;
    end loop;
    if not has_frozen_rx then return new; end if;
    if new.status = 'finalized'
       and (to_jsonb(new) - 'status' - 'updated_at' - 'finalized_at')
         = (to_jsonb(old) - 'status' - 'updated_at' - 'finalized_at') then
      return new;
    end if;
    raise exception 'IMMUTABLE: visit belongs to a finalized prescription' using errcode = '23000';
  end if;
  if tg_op = 'DELETE' then
    if public.tenant_is_erased(old.tenant_id) then return old; end if;
  end if;
  raise exception 'IMMUTABLE: finalized visits cannot be changed' using errcode = '23000';
end $$;

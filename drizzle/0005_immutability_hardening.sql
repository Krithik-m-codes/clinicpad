-- Hardening of the 0004 immutability triggers. Forward-only: 0004 is already applied and tracked.
--
-- Problem 1. 0004 let every delete at trigger depth > 1 through, so ANY foreign-key cascade could
-- delete a finalized row (a draft visit cascading into its finalized prescription is one example).
-- Rule now: a finalized or amended row may be deleted only when its tenant row no longer exists.
-- Deleting a tenant removes the tenants row first and then runs its cascades, so that is exactly
-- offboarding and nothing else.
--
-- Problem 2. The item trigger looked only at the OLD parent on UPDATE, so an item of a draft
-- prescription could be moved into a finalized one. Both parents are checked now.

-- 1. Helper. SECURITY DEFINER so the answer does not depend on the caller's RLS or privileges, with
--    search_path pinned. Left VOLATILE (the default) as the conservative choice: a volatile function
--    always runs on a fresh snapshot, so the answer cannot depend on which snapshot the calling
--    cascade statement happened to take.
create or replace function public.tenant_is_erased(p_tenant_id uuid) returns boolean
language sql security definer set search_path = pg_catalog
as $$ select not exists (select 1 from public.tenants where id = p_tenant_id) $$;
revoke all on function public.tenant_is_erased(uuid) from public;
grant execute on function public.tenant_is_erased(uuid) to clinicpad_app;

-- 2. Prescriptions. UPDATE rules are unchanged from 0004.
create or replace function public.enforce_rx_immutability() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      if not public.tenant_is_erased(old.tenant_id) then
        raise exception 'IMMUTABLE: finalized prescriptions cannot be deleted' using errcode = '23000';
      end if;
    end if;
    return old;
  end if;
  if old.status = 'draft' then return new; end if;
  if old.status = 'finalized' and new.status = 'amended'
     and (to_jsonb(new) - 'status' - 'updated_at') = (to_jsonb(old) - 'status' - 'updated_at') then
    return new;
  end if;
  raise exception 'IMMUTABLE: finalized prescriptions cannot be changed' using errcode = '23000';
end $$;

-- 3. Items. UPDATE checks BOTH parents: the one the item leaves and the one it joins.
--    A missing parent counts as fine: it is being deleted in the same cascade, or the foreign key
--    rejects the row anyway.
create or replace function public.enforce_rx_item_immutability() returns trigger language plpgsql as $$
declare
  old_status text;
  new_status text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select status into old_status from public.prescriptions where id = old.prescription_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select status into new_status from public.prescriptions where id = new.prescription_id;
  end if;

  if tg_op = 'DELETE' then
    if old_status is null or old_status = 'draft' then return old; end if;
    if public.tenant_is_erased(old.tenant_id) then return old; end if;
  elsif (old_status is null or old_status = 'draft') and (new_status is null or new_status = 'draft') then
    return new;
  end if;
  raise exception 'IMMUTABLE: items of a finalized prescription cannot be changed' using errcode = '23000';
end $$;

-- 4. Visits. A draft visit may be updated or deleted; a non-draft one may not be updated, and may be
--    deleted only by tenant offboarding. Deleting a draft visit that still owns a finalized
--    prescription is stopped one level down, by the prescription trigger.
create or replace function public.enforce_visit_immutability() returns trigger language plpgsql as $$
begin
  if old.status = 'draft' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if public.tenant_is_erased(old.tenant_id) then return old; end if;
  end if;
  raise exception 'IMMUTABLE: finalized visits cannot be changed' using errcode = '23000';
end $$;

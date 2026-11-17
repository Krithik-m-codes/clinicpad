-- Plan 1D database integrity (custom migration). Forward-only: 0004-0016 are applied and tracked.

-- 1. tenant_counters: the runtime role reads, creates and increments counters (ADR-0022); it never deletes them.
revoke delete, truncate on tenant_counters from clinicpad_app;
--> statement-breakpoint

-- 2. Rows are born as drafts. An INSERT of an already-finalized row was a documented gap of ADR-0023: it would
--    create a frozen record that never passed finalize (no number check, no snapshot, no audit). Every writer,
--    the admin connection and the demo seed included, now inserts drafts and finalizes them by UPDATE.
create or replace function public.enforce_insert_as_draft() returns trigger language plpgsql as $$
begin
  if new.status is distinct from 'draft' then
    raise exception 'IMMUTABLE: % rows must be inserted as drafts', tg_table_name using errcode = '23000';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger prescriptions_insert_draft before insert on prescriptions
  for each row execute function public.enforce_insert_as_draft();
--> statement-breakpoint
create trigger visits_insert_draft before insert on visits
  for each row execute function public.enforce_insert_as_draft();
--> statement-breakpoint

-- 3. A version is superseded only by a finalized successor of the same tenant (the other gap ADR-0023 listed).
--    finalizePrescription updates the child to 'finalized' before it flips the parent, in one transaction, so the
--    check sees the child. Under RLS the lookup runs as the caller and sees only the caller's tenant. Everything
--    else is the 0005 body unchanged.
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
    if exists (select 1 from public.prescriptions c
                where c.parent_prescription_id = old.id and c.tenant_id = old.tenant_id and c.status = 'finalized') then
      return new;
    end if;
    raise exception 'IMMUTABLE: a prescription is superseded only by a finalized amendment' using errcode = '23000';
  end if;
  raise exception 'IMMUTABLE: finalized prescriptions cannot be changed' using errcode = '23000';
end $$;
--> statement-breakpoint

-- 4. Closed status vocabularies. NOT VALID first so a development database with leftover test rows still migrates;
--    each constraint is validated at once when every existing row passes (always true for rows the services wrote).
--    A constraint left NOT VALID still refuses every new or changed row. `npm run db:sweep-test-tenants` (Plan 1D
--    Task 2) removes leftover test tenants; the next migration that validates will then succeed.
alter table prescriptions add constraint prescriptions_status_check
  check (status in ('draft', 'finalized', 'amended')) not valid;
--> statement-breakpoint
alter table visits add constraint visits_status_check
  check (status in ('draft', 'finalized')) not valid;
--> statement-breakpoint
do $$
declare
  c record;
begin
  for c in
    select conrelid::regclass::text as tbl, conname::text as name
      from pg_constraint
     where connamespace = 'public'::regnamespace and contype = 'c' and not convalidated
       and conname in ('prescriptions_status_check', 'visits_status_check')
  loop
    begin
      execute format('alter table %s validate constraint %I', c.tbl, c.name);
    exception when check_violation then
      raise notice '% stays NOT VALID: existing rows break it (development data; run npm run db:sweep-test-tenants)', c.name;
    end;
  end loop;
end $$;

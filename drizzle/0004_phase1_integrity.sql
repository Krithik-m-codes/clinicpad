-- 1. RLS for the new counters table (same policy shape as every other tenant table).
alter table tenant_counters enable row level security;
alter table tenant_counters force row level security;
create policy tenant_isolation on tenant_counters
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on tenant_counters to clinicpad_app;

-- 2. Backfill numbers for rows created before this migration.
update patients p
set patient_no = s.n
from (
  select id, row_number() over (partition by tenant_id order by created_at, id) as n
  from patients
  where patient_no is null
) s
where p.id = s.id;

insert into tenant_counters (tenant_id, name, last_no)
select tenant_id, 'patient', max(patient_no) from patients
where patient_no is not null group by tenant_id
on conflict (tenant_id, name) do update set last_no = greatest(tenant_counters.last_no, excluded.last_no);

insert into tenant_counters (tenant_id, name, last_no)
select tenant_id, 'rx', max(rx_no) from prescriptions
where rx_no is not null group by tenant_id
on conflict (tenant_id, name) do update set last_no = greatest(tenant_counters.last_no, excluded.last_no);

-- 3. Finalized prescriptions are immutable (AGENTS.md invariant 3).
--    Direct deletes are blocked (trigger depth 1). Cascades from deleting a whole tenant
--    run at depth > 1 and are allowed, so offboarding still works.
create or replace function enforce_rx_immutability() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' and pg_trigger_depth() = 1 then
      raise exception 'IMMUTABLE: finalized prescriptions cannot be deleted' using errcode = '23000';
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

create trigger prescriptions_immutable before update or delete on prescriptions
  for each row execute function enforce_rx_immutability();

create or replace function enforce_rx_item_immutability() returns trigger language plpgsql as $$
declare rx_status text;
begin
  select status into rx_status from prescriptions
    where id = (case when tg_op = 'INSERT' then new.prescription_id else old.prescription_id end);
  if rx_status is null or rx_status = 'draft' then return coalesce(new, old); end if;
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  raise exception 'IMMUTABLE: items of a finalized prescription cannot be changed' using errcode = '23000';
end $$;

create trigger prescription_items_immutable before insert or update or delete on prescription_items
  for each row execute function enforce_rx_item_immutability();

create or replace function enforce_visit_immutability() returns trigger language plpgsql as $$
begin
  if old.status = 'draft' then return coalesce(new, old); end if;
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  raise exception 'IMMUTABLE: finalized visits cannot be changed' using errcode = '23000';
end $$;

create trigger visits_immutable before update or delete on visits
  for each row execute function enforce_visit_immutability();

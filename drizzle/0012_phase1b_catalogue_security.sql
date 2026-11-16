-- Row-level security, privileges and closed vocabularies for the Plan 1B tables (custom migration).

-- 1. Tenant-owned catalogue tables: the same isolation policy as every other tenant table.
do $$
declare
  t text;
begin
  foreach t in array array['tenant_medicines', 'medicine_favourites']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I for all using (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) with check (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
    execute format('grant select, insert, update, delete on %I to clinicpad_app', t);
  end loop;
end $$;

-- 2. Global reference tables: every clinic may read; only the migration/seed role may write.
--    Privileges are the hard barrier (the app role loses INSERT/UPDATE/DELETE/TRUNCATE);
--    forced RLS with a select-only policy for everyone else is defence in depth. The
--    write policy is bound to the role running this migration, which is also the role
--    behind ADMIN_DATABASE_URL in every environment.
do $$
declare
  t text;
begin
  foreach t in array array['global_medicines', 'global_clinical_terms']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy global_read on %I for select using (true)', t);
    execute format('create policy global_owner_write on %I for all to current_user using (true) with check (true)', t);
    execute format('revoke insert, update, delete, truncate on %I from clinicpad_app', t);
    execute format('grant select on %I to clinicpad_app', t);
  end loop;
end $$;

-- 3. Closed vocabularies enforced at the database as well as in Zod.
alter table global_clinical_terms
  add constraint global_terms_kind_check check (kind in ('complaint', 'diagnosis', 'history', 'test'));
alter table prescription_items
  add constraint rx_items_duration_unit_check check (duration_unit is null or duration_unit in ('days', 'weeks', 'months'));
alter table medicine_favourites
  add constraint favourites_duration_unit_check check (duration_unit is null or duration_unit in ('days', 'weeks', 'months'));

-- Runtime role for local/dev. In managed Postgres, use the provider's app role.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'clinicpad_app') then
    create role clinicpad_app login password 'clinicpad_app';
  end if;
end $$;

grant usage on schema public to clinicpad_app;
grant select, insert, update, delete on all tables in schema public to clinicpad_app;
grant usage, select on all sequences in schema public to clinicpad_app;

alter default privileges in schema public
  grant select, insert, update, delete on tables to clinicpad_app;
alter default privileges in schema public
  grant usage, select on sequences to clinicpad_app;

-- Auth tables are accessed only through the admin connection.
revoke all on users from clinicpad_app;

-- Enable and force RLS on every tenant-owned table.
do $$
declare
  t text;
begin
  foreach t in array array[
    'tenants','clinics','branches','memberships','doctors','patients','visits',
    'prescriptions','prescription_items','templates','template_versions','audit_events'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;

-- Tenants: a session can see only its own tenant row.
create policy tenant_self on tenants
  for all
  using (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Standard tenant isolation for every tenant-owned table.
do $$
declare
  t text;
begin
  foreach t in array array[
    'clinics','branches','memberships','doctors','patients','visits',
    'prescriptions','prescription_items','templates','template_versions'
  ]
  loop
    execute format(
      'create policy tenant_isolation on %I for all using (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) with check (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  end loop;
end $$;

-- Audit is append-only: select + insert, never update/delete.
create policy audit_select on audit_events
  for select
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy audit_insert on audit_events
  for insert
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

revoke update, delete on audit_events from clinicpad_app;

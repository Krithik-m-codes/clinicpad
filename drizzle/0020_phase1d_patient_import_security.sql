-- Plan 1D patient import (custom migration): forced RLS and append-only rows for patient_imports.

alter table patient_imports enable row level security;
--> statement-breakpoint
alter table patient_imports force row level security;
--> statement-breakpoint
create policy tenant_read on patient_imports
  for select using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
create policy tenant_insert on patient_imports
  for insert with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- 0002's default privileges granted UPDATE/DELETE on every new table; take them back.
grant select, insert on patient_imports to clinicpad_app;
--> statement-breakpoint
revoke update, delete, truncate on patient_imports from clinicpad_app;
--> statement-breakpoint
-- Immutable on every connection while the tenant exists (the 0015 function; offboarding may delete).
create trigger patient_imports_immutable before update or delete on patient_imports
  for each row execute function public.enforce_print_rows_immutable();

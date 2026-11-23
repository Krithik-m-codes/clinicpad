-- Plan 1D sharing (custom migration): RLS, privileges, the share-token lookup policy, and the link rules.

-- 1. Consents and the share log: forced RLS, append-only for the runtime role, immutable on every connection.
alter table patient_consents enable row level security;
--> statement-breakpoint
alter table patient_consents force row level security;
--> statement-breakpoint
alter table prescription_shares enable row level security;
--> statement-breakpoint
alter table prescription_shares force row level security;
--> statement-breakpoint
create policy tenant_read on patient_consents for select using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
create policy tenant_insert on patient_consents for insert with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
create policy tenant_read on prescription_shares for select using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
create policy tenant_insert on prescription_shares for insert with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert on patient_consents, prescription_shares to clinicpad_app;
--> statement-breakpoint
revoke update, delete, truncate on patient_consents, prescription_shares from clinicpad_app;
--> statement-breakpoint
create trigger patient_consents_immutable before update or delete on patient_consents
  for each row execute function public.enforce_print_rows_immutable();
--> statement-breakpoint
create trigger prescription_shares_immutable before update or delete on prescription_shares
  for each row execute function public.enforce_print_rows_immutable();
--> statement-breakpoint

-- 2. Share links: the runtime role reads, creates and updates its own tenant's links (open counter, revocation), never deletes.
alter table share_links enable row level security;
--> statement-breakpoint
alter table share_links force row level security;
--> statement-breakpoint
create policy tenant_read on share_links for select using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
create policy tenant_insert on share_links for insert with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
create policy tenant_update on share_links for update
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- The one policy without app.tenant_id (allow-listed in tests/integration/rls-guard.test.ts): the public link route
-- (withShareToken, src/server/db/share-token.ts) sets app.share_token_hash to the SHA-256 of the token in the URL
-- and may read exactly that row, to learn its tenant. Knowing a 256-bit hash is equivalent to holding the token.
create policy share_link_by_token on share_links for select to clinicpad_app
  using (token_hash = nullif(current_setting('app.share_token_hash', true), ''));
--> statement-breakpoint
grant select, insert, update on share_links to clinicpad_app;
--> statement-breakpoint
revoke delete, truncate on share_links from clinicpad_app;
--> statement-breakpoint

-- 3. Only the open counter (+1 at a time) and a single revocation may change; a revoked link never changes again.
create or replace function public.enforce_share_link_rules() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    -- Prescriptions are deleted only as drafts, and drafts are never shared: this is tenant offboarding only.
    if public.tenant_is_erased(old.tenant_id) then return old; end if;
    raise exception 'IMMUTABLE: share links cannot be deleted' using errcode = '23000';
  end if;
  if old.revoked_at is not null and to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'IMMUTABLE: a withdrawn share link stays withdrawn and is never opened again' using errcode = '23000';
  end if;
  if (to_jsonb(new) - 'open_count' - 'last_opened_at' - 'revoked_at' - 'revoked_by' - 'revoke_reason')
     is distinct from (to_jsonb(old) - 'open_count' - 'last_opened_at' - 'revoked_at' - 'revoked_by' - 'revoke_reason') then
    raise exception 'IMMUTABLE: only the open counter and the revocation of a share link can change' using errcode = '23000';
  end if;
  if new.open_count not in (old.open_count, old.open_count + 1) then
    raise exception 'IMMUTABLE: a share link is opened one at a time' using errcode = '23000';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger share_links_rules before update or delete on share_links
  for each row execute function public.enforce_share_link_rules();
--> statement-breakpoint

-- 4. A link points only at a finalized prescription of its own tenant (23503 for a missing or foreign one first,
--    then 23000 for any other status; the lookup runs as the caller, so RLS applies).
create or replace function public.enforce_share_link_target() returns trigger language plpgsql as $$
declare
  rx_status text;
begin
  select status into rx_status from public.prescriptions where id = new.prescription_id and tenant_id = new.tenant_id;
  if rx_status is null then
    raise exception 'prescription not found for this tenant' using errcode = '23503';
  end if;
  if rx_status <> 'finalized' then
    raise exception 'IMMUTABLE: only a finalized prescription can be shared' using errcode = '23000';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger share_links_target before insert on share_links
  for each row execute function public.enforce_share_link_target();

ALTER TABLE "patient_consents" ALTER COLUMN "captured_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "prescription_shares" ADD CONSTRAINT "rx_shares_recipient_masked_check" CHECK (recipient_masked like '%*%' and recipient_masked !~ '[0-9]{5}');--> statement-breakpoint
ALTER TABLE "prescription_shares" ADD CONSTRAINT "rx_shares_provider_channel_check" CHECK ((channel = 'whatsapp' and provider in ('wa_link', 'fake')) or (channel = 'email' and provider in ('resend', 'fake')));--> statement-breakpoint
ALTER TABLE "prescription_shares" ADD CONSTRAINT "rx_shares_wa_link_check" CHECK (provider <> 'wa_link' or (status = 'prepared' and provider_message_id is null and error_code is null));--> statement-breakpoint
ALTER TABLE "prescription_shares" ADD CONSTRAINT "rx_shares_failed_check" CHECK (error_code is null or status = 'failed');--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_revoked_by_check" CHECK (revoked_by is null or revoked_at is not null);
--> statement-breakpoint
-- Consent events are ordered by the statement clock, not the transaction start, so two events written in one
-- transaction (or a re-grant right after a withdrawal) still sort in the order they were written.
create or replace function public.stamp_consent_time() returns trigger language plpgsql as $$
begin
  new.created_at := clock_timestamp();
  return new;
end $$;
--> statement-breakpoint
create trigger patient_consents_stamp before insert on patient_consents
  for each row execute function public.stamp_consent_time();
--> statement-breakpoint

-- A new link starts in its initial state whatever the insert says (the runtime role can insert share_links).
create or replace function public.enforce_share_link_initial() returns trigger language plpgsql as $$
begin
  new.open_count := 0;
  new.last_opened_at := null;
  new.revoked_at := null;
  new.revoked_by := null;
  new.revoke_reason := null;
  new.created_at := now();
  return new;
end $$;
--> statement-breakpoint
create trigger share_links_initial before insert on share_links
  for each row execute function public.enforce_share_link_initial();
--> statement-breakpoint

-- Rules for changes: as 0022, plus the last-opened time never clears and a revocation is never dated before the link.
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
  if old.last_opened_at is not null and new.last_opened_at is null then
    raise exception 'IMMUTABLE: the last-opened time of a share link never clears' using errcode = '23000';
  end if;
  if new.revoked_at is not null and new.revoked_at < old.created_at then
    raise exception 'IMMUTABLE: a share link cannot be withdrawn before it was created' using errcode = '23000';
  end if;
  return new;
end $$;
--> statement-breakpoint

-- A link points only at a finalized prescription of its own tenant, and cites the patient's CURRENT sharing consent:
-- same tenant, purpose sharing, granted, the prescription's own patient, and no later consent event for that patient
-- (events compare by (created_at, id); created_at comes from clock_timestamp(), see patient_consents_stamp).
-- 23503 for a missing or foreign prescription or consent, 23000 for any other refusal. Runs as the caller, so RLS applies.
create or replace function public.enforce_share_link_target() returns trigger language plpgsql as $$
declare
  rx_status text;
  rx_patient uuid;
  c record;
begin
  select p.status, v.patient_id into rx_status, rx_patient
    from public.prescriptions p
    join public.visits v on v.tenant_id = p.tenant_id and v.id = p.visit_id
   where p.id = new.prescription_id and p.tenant_id = new.tenant_id;
  if rx_status is null then
    raise exception 'prescription not found for this tenant' using errcode = '23503';
  end if;
  if rx_status <> 'finalized' then
    raise exception 'IMMUTABLE: only a finalized prescription can be shared' using errcode = '23000';
  end if;
  select patient_id, purpose, granted, created_at, id into c
    from public.patient_consents where id = new.consent_id and tenant_id = new.tenant_id;
  if not found then
    raise exception 'consent not found for this tenant' using errcode = '23503';
  end if;
  if c.purpose <> 'sharing' or not c.granted or c.patient_id <> rx_patient then
    raise exception 'IMMUTABLE: a share link must cite a granted sharing consent of the prescription''s own patient' using errcode = '23000';
  end if;
  if exists (
    select 1 from public.patient_consents x
     where x.tenant_id = new.tenant_id and x.patient_id = c.patient_id and x.purpose = c.purpose
       and (x.created_at, x.id) > (c.created_at, c.id)
  ) then
    raise exception 'IMMUTABLE: a later consent event replaces the consent this link cites' using errcode = '23000';
  end if;
  return new;
end $$;
--> statement-breakpoint

-- A share-log row describes its own link: same prescription, same channel.
create or replace function public.enforce_share_log_matches_link() returns trigger language plpgsql as $$
declare
  l record;
begin
  select prescription_id, channel into l from public.share_links where id = new.share_link_id and tenant_id = new.tenant_id;
  if not found then
    raise exception 'share link not found for this tenant' using errcode = '23503';
  end if;
  if l.prescription_id <> new.prescription_id or l.channel <> new.channel then
    raise exception 'IMMUTABLE: a share-log row must match the prescription and channel of its link' using errcode = '23000';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger prescription_shares_match before insert on prescription_shares
  for each row execute function public.enforce_share_log_matches_link();

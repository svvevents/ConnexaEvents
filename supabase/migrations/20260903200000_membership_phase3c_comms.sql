-- Membership Management Module -- Phase 3c: comms reuse.
-- Third of four Phase 3 sub-steps. Built after inspecting the real body
-- of drain_communications_queue_() live (pasted by the user) rather than
-- guessing at it -- that inspection changed the plan from "extend the
-- existing queue/drain" (what the design doc assumed) to "a fully
-- separate, parallel pipeline that mirrors its proven structure":
-- drain_communications_queue_ always calls build_merge_context_for_email_
-- (event/attendee-specific) with no way to substitute a different
-- context per row, so membership sends genuinely cannot share that
-- queue without either risky changes to a complex, currently-live,
-- quota-aware function, or silently getting the wrong merge tags.
--
-- What IS safely reused, because this session now has proven call
-- signatures for each: render_communication_(), deliver_email_via_resend_(),
-- get_comm_settings_(), and comm_log itself (new rows only, an insert
-- into a log table carries none of the "processing someone else's queue
-- row wrong" risk the queue/drain reuse would have). comm_log.campaign_id
-- and .event_id are left unset on every membership row (nullable in
-- every prior usage this function's own body shows, e.g. campaign.event_id
-- flows into it unguarded) rather than pointed at membership_comm_campaigns'
-- own id -- avoids any risk of an FK constraint this session can't see
-- from an information_schema.columns listing alone.
--
-- Recipient model: tenant_members had no contact person at all before
-- this file (only `domains`, for matching *inbound* registrations) --
-- contact_name/contact_email are added here as the first real per-member
-- outbound contact, per user direction. A member without contact_email
-- set is simply excluded from every membership audience -- not an error,
-- just not counted.
--
-- Known gap, flagged rather than guessed past: comm_optout suppression
-- is NOT applied to membership sends in this first cut (its column
-- shape was never confirmed this session) -- fine for the low-volume,
-- admin-curated audiences this starts with, but close this before this
-- feature is used for large recurring campaigns.

alter table public.tenant_members add column if not exists contact_name text;
alter table public.tenant_members add column if not exists contact_email text;

-- Re-issued from Phase 1 with contact_name/contact_email added -- same
-- signature (safe to CREATE OR REPLACE, this session wrote the original
-- so its full prior body is known, not guessed), every other field
-- unchanged.
create or replace function public.create_or_update_member(p_payload jsonb)
returns public.tenant_members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public.admin_tenant_id();
  v_id uuid := nullif(p_payload->>'id', '')::uuid;
  v_row public.tenant_members;
begin
  if v_tenant_id is null then
    raise exception 'Caller is not a tenant admin.';
  end if;

  if v_id is null then
    insert into public.tenant_members
      (tenant_id, company_name, domains, companies_house_number, sic_codes, tier, status,
       show_internally, show_externally, website, logo_url, blurb, notes, contact_name, contact_email)
    values (
      v_tenant_id,
      p_payload->>'companyName',
      coalesce((select array_agg(lower(trim(d))) from jsonb_array_elements_text(coalesce(p_payload->'domains', '[]'::jsonb)) d), '{}'),
      p_payload->>'companiesHouseNumber',
      coalesce((select array_agg(c) from jsonb_array_elements_text(coalesce(p_payload->'sicCodes', '[]'::jsonb)) c), '{}'),
      p_payload->>'tier',
      coalesce(p_payload->>'status', 'Active'),
      coalesce((p_payload->>'showInternally')::boolean, true),
      coalesce((p_payload->>'showExternally')::boolean, false),
      p_payload->>'website',
      p_payload->>'logoUrl',
      p_payload->>'blurb',
      p_payload->>'notes',
      p_payload->>'contactName',
      p_payload->>'contactEmail'
    )
    returning * into v_row;
  else
    update public.tenant_members set
      company_name = p_payload->>'companyName',
      domains = coalesce((select array_agg(lower(trim(d))) from jsonb_array_elements_text(coalesce(p_payload->'domains', '[]'::jsonb)) d), '{}'),
      companies_house_number = p_payload->>'companiesHouseNumber',
      sic_codes = coalesce((select array_agg(c) from jsonb_array_elements_text(coalesce(p_payload->'sicCodes', '[]'::jsonb)) c), '{}'),
      tier = p_payload->>'tier',
      status = coalesce(p_payload->>'status', status),
      show_internally = coalesce((p_payload->>'showInternally')::boolean, show_internally),
      show_externally = coalesce((p_payload->>'showExternally')::boolean, show_externally),
      website = p_payload->>'website',
      logo_url = p_payload->>'logoUrl',
      blurb = p_payload->>'blurb',
      notes = p_payload->>'notes',
      contact_name = p_payload->>'contactName',
      contact_email = p_payload->>'contactEmail',
      updated_at = now()
    where id = v_id and tenant_id = v_tenant_id
    returning * into v_row;

    if v_row is null then
      raise exception 'Member not found for this tenant.';
    end if;
  end if;

  return v_row;
end;
$$;

create table public.membership_comm_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  template_id uuid not null references public.comm_templates(id),
  name text not null,
  audience_spec jsonb not null default '{}'::jsonb,
  status text not null default 'Queued' check (status in ('Scheduled', 'Queued', 'Running', 'AwaitingQuota', 'Completed')),
  total_recipients integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  scheduled_for timestamptz
);
create index membership_comm_campaigns_tenant_id_idx on public.membership_comm_campaigns(tenant_id);
alter table public.membership_comm_campaigns enable row level security;

create table public.membership_comm_queue (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  campaign_id uuid not null references public.membership_comm_campaigns(id) on delete cascade,
  member_id uuid not null references public.tenant_members(id) on delete cascade,
  email text not null,
  full_name text,
  status text not null default 'Queued' check (status in ('Queued', 'Sending', 'Sent', 'Failed')),
  attempts integer not null default 0,
  queued_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  error text
);
create index membership_comm_queue_status_idx on public.membership_comm_queue(status, queued_at);
alter table public.membership_comm_queue enable row level security;

create or replace function public.build_merge_context_for_membership_email_(p_tenant_id uuid, p_member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.tenant_members;
  v_dues_pending boolean;
begin
  select * into v_member from public.tenant_members where id = p_member_id and tenant_id = p_tenant_id;
  if v_member is null then
    return '{}'::jsonb;
  end if;

  select exists(select 1 from public.member_dues where member_id = p_member_id and payment_status = 'Pending') into v_dues_pending;

  return jsonb_build_object('member', jsonb_build_object(
    'contactName', coalesce(v_member.contact_name, ''),
    'companyName', v_member.company_name,
    'tier', coalesce(v_member.tier, ''),
    'duesStatus', case when v_dues_pending then 'Pending' else 'Up to date' end
  ));
end;
$$;

create or replace function public.resolve_membership_audience(p_audience_spec jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public.admin_tenant_id();
  v_tiers text[];
  v_matched jsonb;
  v_count integer;
  v_no_contact_email integer;
begin
  if v_tenant_id is null then
    raise exception 'Caller is not a tenant admin.';
  end if;

  v_tiers := case when jsonb_typeof(p_audience_spec->'tiers') = 'array'
    then (select array_agg(x) from jsonb_array_elements_text(p_audience_spec->'tiers') x)
    else null end;

  select
    count(*) filter (where contact_email is not null and contact_email <> ''),
    count(*) filter (where contact_email is null or contact_email = '')
  into v_count, v_no_contact_email
  from public.tenant_members
  where tenant_id = v_tenant_id and status = 'Active' and (v_tiers is null or tier = any(v_tiers));

  select coalesce(jsonb_agg(row_to_json(s)), '[]'::jsonb) into v_matched
  from (
    select id as "memberId", company_name as "companyName", contact_name as "contactName", contact_email as "contactEmail", tier
    from public.tenant_members
    where tenant_id = v_tenant_id and status = 'Active' and contact_email is not null and contact_email <> ''
      and (v_tiers is null or tier = any(v_tiers))
    order by company_name limit 10
  ) s;

  return jsonb_build_object('count', v_count, 'noContactEmail', v_no_contact_email, 'sample', v_matched);
end;
$$;

create or replace function public.send_membership_campaign(p_name text, p_template_id uuid, p_audience_spec jsonb, p_scheduled_for timestamptz default null)
returns public.membership_comm_campaigns
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public.admin_tenant_id();
  v_tiers text[];
  v_campaign public.membership_comm_campaigns;
  v_recipient_count integer;
begin
  if v_tenant_id is null then
    raise exception 'Caller is not a tenant admin.';
  end if;
  if not exists (select 1 from public.comm_templates where id = p_template_id and tenant_id = v_tenant_id) then
    raise exception 'Template not found for this tenant.';
  end if;

  v_tiers := case when jsonb_typeof(p_audience_spec->'tiers') = 'array'
    then (select array_agg(x) from jsonb_array_elements_text(p_audience_spec->'tiers') x)
    else null end;

  insert into public.membership_comm_campaigns (tenant_id, template_id, name, audience_spec, status, scheduled_for)
  values (v_tenant_id, p_template_id, p_name, coalesce(p_audience_spec, '{}'::jsonb),
          case when p_scheduled_for is not null and p_scheduled_for > now() then 'Scheduled' else 'Queued' end,
          p_scheduled_for)
  returning * into v_campaign;

  insert into public.membership_comm_queue (tenant_id, campaign_id, member_id, email, full_name)
  select v_tenant_id, v_campaign.id, id, contact_email, contact_name
  from public.tenant_members
  where tenant_id = v_tenant_id and status = 'Active' and contact_email is not null and contact_email <> ''
    and (v_tiers is null or tier = any(v_tiers));

  get diagnostics v_recipient_count = row_count;
  update public.membership_comm_campaigns set total_recipients = v_recipient_count where id = v_campaign.id;

  select * into v_campaign from public.membership_comm_campaigns where id = v_campaign.id;
  return v_campaign;
end;
$$;

create or replace function public.list_membership_campaigns()
returns setof public.membership_comm_campaigns
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public.admin_tenant_id();
begin
  if v_tenant_id is null then
    raise exception 'Caller is not a tenant admin.';
  end if;
  return query select * from public.membership_comm_campaigns where tenant_id = v_tenant_id order by created_at desc;
end;
$$;

-- Mirrors drain_communications_queue_'s proven structure (claim-with-
-- skip-locked, quota check shared via the same comm_log/get_comm_settings_,
-- stuck-claim reconciliation) against its own isolated queue/campaigns
-- tables, so it can never see or touch a row the original function owns.
create or replace function public.drain_membership_communications_queue_()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed record;
  v_campaign public.membership_comm_campaigns;
  v_template public.comm_templates;
  v_settings public.comm_settings;
  v_context jsonb;
  v_render jsonb;
  v_deliver jsonb;
  v_today_sent int;
  v_remaining_quota int;
  v_processed int := 0;
  v_sent int := 0;
  v_failed int := 0;
  v_touched_campaigns uuid[] := '{}';
begin
  update public.membership_comm_campaigns set status = 'Queued' where status = 'Scheduled' and scheduled_for <= now();

  update public.membership_comm_queue set status = 'Failed', error = 'Stuck in Sending for over 15 minutes -- presumed interrupted'
  where status = 'Sending' and claimed_at < now() - interval '15 minutes';

  for v_claimed in
    update public.membership_comm_queue set status = 'Sending', claimed_at = now()
    where id in (
      select q.id from public.membership_comm_queue q
      join public.membership_comm_campaigns c on c.id = q.campaign_id
      where q.status = 'Queued' and c.status in ('Queued', 'Running', 'AwaitingQuota')
      order by q.queued_at
      limit 200
      for update of q skip locked
    )
    returning *
  loop
    v_processed := v_processed + 1;
    if not (v_claimed.campaign_id = any(v_touched_campaigns)) then
      v_touched_campaigns := array_append(v_touched_campaigns, v_claimed.campaign_id);
    end if;

    select * into v_campaign from public.membership_comm_campaigns where id = v_claimed.campaign_id;
    select * into v_template from public.comm_templates where id = v_campaign.template_id;
    v_settings := public.get_comm_settings_(v_claimed.tenant_id);

    select count(*) into v_today_sent from public.comm_log
      where tenant_id = v_claimed.tenant_id and status = 'Sent' and created_at >= date_trunc('day', now());
    v_remaining_quota := greatest(0, coalesce(v_settings.daily_send_cap, 90) - v_today_sent - 10);

    if v_remaining_quota <= 0 then
      update public.membership_comm_queue set status = 'Queued', claimed_at = null where id = v_claimed.id;
      update public.membership_comm_campaigns set status = 'AwaitingQuota' where id = v_claimed.campaign_id and status <> 'AwaitingQuota';
      continue;
    end if;

    update public.membership_comm_campaigns set status = 'Running', started_at = coalesce(started_at, now())
      where id = v_claimed.campaign_id and status in ('Queued', 'AwaitingQuota');

    v_context := public.build_merge_context_for_membership_email_(v_claimed.tenant_id, v_claimed.member_id)
      || jsonb_build_object('campaign', jsonb_build_object(
           'name', v_campaign.name, 'footerOrgName', coalesce(v_settings.footer_org_name, ''),
           'footerPostalAddress', coalesce(v_settings.footer_postal_address, ''), 'footerText', coalesce(v_settings.footer_text, '')
         ));
    v_render := public.render_communication_(v_claimed.tenant_id, v_template, v_context);
    v_deliver := public.deliver_email_via_resend_(v_claimed.tenant_id, v_claimed.email, v_render->>'subject', v_render->>'htmlBody');

    if (v_deliver->>'ok')::boolean then
      update public.membership_comm_queue set status = 'Sent', sent_at = now(), attempts = attempts + 1 where id = v_claimed.id;
      v_sent := v_sent + 1;
    else
      update public.membership_comm_queue set status = 'Failed', error = v_deliver->>'error', attempts = attempts + 1 where id = v_claimed.id;
      v_failed := v_failed + 1;
    end if;

    insert into public.comm_log (tenant_id, template_id, template_name, recipient_email, recipient_name, subject, category, status, error_message, sent_by)
    values (
      v_claimed.tenant_id, v_template.id, v_template.name, v_claimed.email, v_claimed.full_name,
      v_render->>'subject', v_template.category,
      case when (v_deliver->>'ok')::boolean then 'Sent' else 'Failed' end,
      case when (v_deliver->>'ok')::boolean then null else v_deliver->>'error' end,
      'system:membership_campaign'
    );

    if (v_deliver->>'ok')::boolean then
      insert into public.membership_interactions (tenant_id, subject_type, subject_id, interaction_type, notes, created_by)
      values (v_claimed.tenant_id, 'member', v_claimed.member_id, 'Email', 'Sent: ' || coalesce(v_render->>'subject', v_template.name), 'system:membership_campaign');
    end if;
  end loop;

  update public.membership_comm_campaigns c set
    sent_count = (select count(*) from public.membership_comm_queue where campaign_id = c.id and status = 'Sent'),
    failed_count = (select count(*) from public.membership_comm_queue where campaign_id = c.id and status = 'Failed')
  where c.id = any(v_touched_campaigns);

  update public.membership_comm_campaigns c set status = 'Completed', completed_at = now()
  where c.id = any(v_touched_campaigns) and c.status in ('Running', 'Queued', 'AwaitingQuota')
    and not exists (select 1 from public.membership_comm_queue where campaign_id = c.id and status in ('Queued', 'Sending'));

  return jsonb_build_object('status', 'ok', 'processed', v_processed, 'sent', v_sent, 'failed', v_failed);
end;
$$;

-- NOT scheduled via cron -- live-tested 2026-09-03 and found to contend
-- with the existing every-minute comm-drain-queue job over pg_net's
-- shared HTTP mechanism (two per-minute pollers hitting Resend at
-- nearly the same moment repeatedly timed out deliver_email_via_resend_,
-- see cron.job_run_details for jobid 41 -- confirmed NOT a bug in that
-- reused, unmodified function, since the original job has run fine on
-- the same function for a long time). Membership sends are small,
-- admin-triggered batches, not a constant stream, so there's no real
-- need to poll every minute anyway -- trigger_membership_send_drain()
-- below is called directly by the client right after queuing instead,
-- a single one-off invocation rather than a permanent competing poller.
create or replace function public.trigger_membership_send_drain()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  -- drain_membership_communications_queue_() itself has no caller check
  -- (by design -- it's meant for a trusted background/service-role
  -- caller, and its work is inherently cross-tenant, same as the
  -- original comm-drain-queue job). This wrapper is the only client-
  -- facing entry point, so it's the one place that needs to gate who
  -- can trigger it at all.
  if public.admin_tenant_id() is null then
    raise exception 'Caller is not a tenant admin.';
  end if;
  return public.drain_membership_communications_queue_();
end;
$$;

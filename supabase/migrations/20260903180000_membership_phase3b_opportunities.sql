-- Membership Management Module -- Phase 3b: the upsell/opportunity pipeline.
-- Second of four Phase 3 sub-steps. Four stages (Identified -> Proposed ->
-- Won/Lost, both terminal). opportunity_type stays free text and never
-- drives behavior directly -- automation is decoupled onto two optional
-- fields instead: resulting_tier (only set if Won should change the
-- member's tier) and effective_date (defaults to now, can be a future
-- renewal date). A daily sweep applies any pending tier change once its
-- effective_date arrives, same pg_cron pattern already confirmed live
-- for booth-hold expiry / stale-B2B-meeting autocancel (both simple
-- `select <fn>();` jobs) -- schedule/function-naming below matches that
-- exactly rather than inventing a new convention.
--
-- Sponsorships (Won + event_id set): one orders row, same as any other
-- event income (category = opportunity_type, event_id set), now also
-- attributable to a member via Phase 3a's orders.member_id -- not a
-- second row in member_dues. Confirmed live orders defaults/nullability
-- before writing this (event_id/amount required, everything else this
-- insert touches is nullable or has a safe default) -- no guessing here.
-- Non-event-linked Won opportunities create a plain member_dues row
-- instead, reusing Phase 3a as-is.

create table public.membership_opportunities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  member_id uuid not null references public.tenant_members(id) on delete cascade,
  opportunity_type text not null,
  stage text not null default 'Identified' check (stage in ('Identified', 'Proposed', 'Won', 'Lost')),
  amount numeric,
  currency text,
  event_id uuid references public.events(id),
  resulting_tier text,
  effective_date date not null default current_date,
  applied_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index membership_opportunities_tenant_id_idx on public.membership_opportunities(tenant_id);
alter table public.membership_opportunities enable row level security; -- zero policies, RPC-only, same convention as every other membership table

create or replace function public.list_membership_opportunities()
returns setof public.membership_opportunities
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
  return query select * from public.membership_opportunities where tenant_id = v_tenant_id order by created_at desc;
end;
$$;

create or replace function public.create_or_update_opportunity(p_payload jsonb)
returns public.membership_opportunities
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public.admin_tenant_id();
  v_id uuid := nullif(p_payload->>'id', '')::uuid;
  v_member_id uuid := (p_payload->>'memberId')::uuid;
  v_row public.membership_opportunities;
begin
  if v_tenant_id is null then
    raise exception 'Caller is not a tenant admin.';
  end if;
  if not exists (select 1 from public.tenant_members where id = v_member_id and tenant_id = v_tenant_id) then
    raise exception 'Member not found for this tenant.';
  end if;

  if v_id is null then
    insert into public.membership_opportunities
      (tenant_id, member_id, opportunity_type, amount, currency, event_id, resulting_tier, effective_date, notes)
    values (
      v_tenant_id, v_member_id, p_payload->>'opportunityType',
      nullif(p_payload->>'amount', '')::numeric, nullif(p_payload->>'currency', ''),
      nullif(p_payload->>'eventId', '')::uuid, nullif(p_payload->>'resultingTier', ''),
      coalesce(nullif(p_payload->>'effectiveDate', '')::date, current_date),
      p_payload->>'notes'
    )
    returning * into v_row;
  else
    update public.membership_opportunities set
      member_id = v_member_id,
      opportunity_type = p_payload->>'opportunityType',
      amount = nullif(p_payload->>'amount', '')::numeric,
      currency = nullif(p_payload->>'currency', ''),
      event_id = nullif(p_payload->>'eventId', '')::uuid,
      resulting_tier = nullif(p_payload->>'resultingTier', ''),
      effective_date = coalesce(nullif(p_payload->>'effectiveDate', '')::date, effective_date),
      notes = p_payload->>'notes',
      updated_at = now()
    where id = v_id and tenant_id = v_tenant_id and stage in ('Identified', 'Proposed')
    returning * into v_row;

    if v_row is null then
      raise exception 'Opportunity not found for this tenant, or it is already Won/Lost.';
    end if;
  end if;

  return v_row;
end;
$$;

-- Shared by both the immediate Won-transition below and the daily cron
-- sweep -- cross-tenant on purpose (a background job, no admin session to
-- scope by), touches only opportunities that are actually due.
create or replace function public.apply_pending_membership_tier_changes_()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tenant_members m
  set tier = o.resulting_tier, updated_at = now()
  from public.membership_opportunities o
  where o.member_id = m.id
    and o.stage = 'Won'
    and o.resulting_tier is not null
    and o.applied_at is null
    and o.effective_date <= current_date;

  update public.membership_opportunities
  set applied_at = now()
  where stage = 'Won' and resulting_tier is not null and applied_at is null and effective_date <= current_date;
end;
$$;

select cron.schedule('apply-pending-membership-tier-changes', '0 5 * * *', 'select apply_pending_membership_tier_changes_();');

create or replace function public.set_opportunity_stage(p_opportunity_id uuid, p_stage text)
returns public.membership_opportunities
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public.admin_tenant_id();
  v_opp public.membership_opportunities;
  v_company_name text;
begin
  if v_tenant_id is null then
    raise exception 'Caller is not a tenant admin.';
  end if;
  if p_stage not in ('Identified', 'Proposed', 'Won', 'Lost') then
    raise exception 'Unknown stage.';
  end if;

  update public.membership_opportunities set stage = p_stage, updated_at = now()
  where id = p_opportunity_id and tenant_id = v_tenant_id
  returning * into v_opp;

  if v_opp is null then
    raise exception 'Opportunity not found for this tenant.';
  end if;

  if p_stage = 'Won' then
    select company_name into v_company_name from public.tenant_members where id = v_opp.member_id;

    if v_opp.event_id is not null then
      insert into public.orders (tenant_id, event_id, member_id, company_name, category, description, amount, currency)
      values (v_tenant_id, v_opp.event_id, v_opp.member_id, v_company_name, v_opp.opportunity_type, v_opp.notes,
              coalesce(v_opp.amount, 0), coalesce(v_opp.currency, 'GBP'));
    else
      insert into public.member_dues (tenant_id, member_id, description, amount, currency)
      values (v_tenant_id, v_opp.member_id, v_opp.opportunity_type, coalesce(v_opp.amount, 0), coalesce(v_opp.currency, 'GBP'));
    end if;

    perform public.apply_pending_membership_tier_changes_();
    select * into v_opp from public.membership_opportunities where id = p_opportunity_id;
  end if;

  return v_opp;
end;
$$;

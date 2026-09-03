-- Membership Management Module -- Phase 2: the integration payoff
-- (items 1 and 2 of the "Connexa Membership Design v2" proposal's Phase 2
-- only -- member pricing/early access, the plan's third item, was
-- explicitly disregarded by the user, carried over from an earlier
-- suggestion that never made it into the accepted design).
--
-- Engagement dashboard + $/year, domain-matched to real event activity,
-- and a rollup dashboard by tier. Both pure aggregation over tables that
-- already exist (tenant_members from Phase 1, registrations/orders from
-- the original platform) -- no new tables, no new guesses: this session
-- confirmed every column referenced below via a live information_schema
-- query before writing this file.
--
-- Matching convention: registrations.domain is used directly when
-- present (it's populated the same way company_directory's own
-- domain-keyed lookups work); falls back to parsing the email's domain
-- for the rare row where it's blank. orders has no domain column at all,
-- so it's always parsed from orders.email.

create or replace function public.get_membership_engagement_dashboard()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public.admin_tenant_id();
  v_result jsonb;
begin
  if v_tenant_id is null then
    raise exception 'Caller is not a tenant admin.';
  end if;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_result
  from (
    select
      m.id as member_id,
      m.company_name,
      m.tier,
      coalesce(reg.registration_count, 0) as registration_count,
      reg.last_active_at,
      coalesce(spend.spend_by_currency, '[]'::jsonb) as spend_by_currency
    from public.tenant_members m
    left join lateral (
      select count(*) as registration_count, max(r.created_at) as last_active_at
      from public.registrations r
      where r.tenant_id = v_tenant_id
        and lower(coalesce(nullif(r.domain, ''), split_part(r.work_email, '@', 2))) = any(m.domains)
    ) reg on true
    left join lateral (
      select jsonb_agg(jsonb_build_object('currency', s.cur, 'amount', s.total)) as spend_by_currency
      from (
        select o.currency as cur, sum(o.amount) as total
        from public.orders o
        where o.tenant_id = v_tenant_id
          and o.payment_status = 'Paid'
          and lower(split_part(o.email, '@', 2)) = any(m.domains)
        group by o.currency
      ) s
    ) spend on true
    where m.tenant_id = v_tenant_id and m.status = 'Active'
    order by coalesce(reg.registration_count, 0) desc, m.company_name
  ) t;

  return v_result;
end;
$$;

create or replace function public.get_membership_rollup()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public.admin_tenant_id();
  v_by_tier jsonb;
  v_total_active integer;
  v_total_members integer;
begin
  if v_tenant_id is null then
    raise exception 'Caller is not a tenant admin.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('tier', x.tier_label, 'count', x.cnt) order by x.cnt desc), '[]'::jsonb)
  into v_by_tier
  from (
    select coalesce(nullif(tier, ''), 'Unassigned') as tier_label, count(*) as cnt
    from public.tenant_members
    where tenant_id = v_tenant_id and status = 'Active'
    group by 1
  ) x;

  select count(*) filter (where status = 'Active'), count(*)
  into v_total_active, v_total_members
  from public.tenant_members where tenant_id = v_tenant_id;

  return jsonb_build_object(
    'totalActiveMembers', coalesce(v_total_active, 0),
    'totalMembers', coalesce(v_total_members, 0),
    'byTier', v_by_tier
  );
end;
$$;

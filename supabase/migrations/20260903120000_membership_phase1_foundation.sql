-- Membership Management Module -- Phase 1: the foundation.
-- Builds tenant_members, membership_prospects, membership_interactions,
-- the tenants.membership_enabled capability flag, and the RPCs
-- AdminPortal.html's new "Members" panel and Control Centre's tenant
-- detail view call. Scope matches "Connexa Membership Design v2" (see
-- the published design artifact) Phase 1 exactly: works standalone, zero
-- events required. Phases 2-4 (engagement dashboard, dues/outreach, SIC
-- prospect discovery) are NOT part of this migration.
--
-- =====================================================================
-- First run (2026-09-03) errored on admin_tenant_id()'s original guess
-- (a `user_id` column that doesn't exist) -- confirmed live and fixed
-- below: public.tenant_admins is (tenant_id uuid, admin_user_id uuid,
-- role text, invited_at timestamptz, accepted_at timestamptz). Since
-- Postgres rolls back an entire multi-statement script on error, nothing
-- from the first attempt was actually created -- this file is safe to
-- run clean, no conflicts.
--
-- Every other function needing an authorization check deliberately
-- never guessed -- each piggybacks on an existing, already-proven-
-- correct function (get_admin_session_status, get_platform_tenant_
-- detail, set_platform_tenant_status) purely for its side-effect of
-- raising when the caller isn't authorized.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Capability flag
-- ---------------------------------------------------------------------

alter table public.tenants
  add column if not exists membership_enabled boolean not null default false;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table public.tenant_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  company_name text not null,
  domains text[] not null default '{}',              -- lowercased email domains, matches company_directory's own domain-keyed convention
  companies_house_number text,
  sic_codes text[] not null default '{}',
  tier text,                                          -- free text, same convention as event registration types
  status text not null default 'Active' check (status in ('Active','Inactive')),
  show_internally boolean not null default true,       -- Phase 1 register groundwork; register UI itself is Phase 3
  show_externally boolean not null default false,
  website text,
  logo_url text,
  blurb text,
  member_since date not null default current_date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tenant_members_tenant_id_idx on public.tenant_members(tenant_id);

create table public.membership_prospects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  company_name text not null,
  domain text,
  companies_house_number text,
  sic_codes text[] not null default '{}',
  stage text not null default 'Identified'
    check (stage in ('Suggested','Identified','Contacted','In Discussion','Converted','Not a Fit','Lost')),
  source text,                                         -- e.g. 'Manual', 'SIC Match' (Phase 4) -- free text, not enforced
  notes text,
  converted_member_id uuid references public.tenant_members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index membership_prospects_tenant_id_idx on public.membership_prospects(tenant_id);

create table public.membership_interactions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  subject_type text not null check (subject_type in ('member','prospect')),
  subject_id uuid not null,                            -- tenant_members.id or membership_prospects.id, per subject_type
  interaction_type text not null default 'Note' check (interaction_type in ('Meeting','Call','Note','Email')),
  notes text,
  occurred_at timestamptz not null default now(),
  created_by text,                                      -- caller's email, informational only
  created_at timestamptz not null default now()
);
create index membership_interactions_subject_idx on public.membership_interactions(tenant_id, subject_type, subject_id);

-- Defense in depth: RLS enabled with zero policies, so the anon/authenticated
-- key can never read these tables directly -- same posture as every other
-- tenant-scoped table in this app, where the client only ever goes through
-- SECURITY DEFINER RPCs (the one documented exception, events/is_exhibition,
-- doesn't apply here -- nothing about membership needs a direct client read).
alter table public.tenant_members enable row level security;
alter table public.membership_prospects enable row level security;
alter table public.membership_interactions enable row level security;

-- ---------------------------------------------------------------------
-- Tenant-admin resolution helper.
-- Confirmed live 2026-09-03: public.tenant_admins is (tenant_id uuid,
-- admin_user_id uuid, role text, invited_at timestamptz, accepted_at
-- timestamptz) -- the original guess (user_id) was wrong, this is the
-- corrected version. First live test also caught a second wrong guess:
-- filtering on accepted_at is not null returned "Caller is not a tenant
-- admin" for the tenant's own owner, who has a working admin session --
-- accepted_at is evidently not populated for an owner row (no invite was
-- ever sent to accept), so filtering on it would lock out exactly the
-- account most likely to be the one testing this. Dropped; every other
-- admin RPC in this app clearly doesn't gate on it either, since the
-- owner already uses AdminPortal.html today.
-- ---------------------------------------------------------------------

create or replace function public.admin_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select tenant_id from public.tenant_admins where admin_user_id = auth.uid() limit 1;
$$;

-- ---------------------------------------------------------------------
-- Admin RPCs (AdminPortal.html "Members" panel)
-- ---------------------------------------------------------------------

create or replace function public.get_membership_capability()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public.admin_tenant_id();
  v_enabled boolean;
begin
  if v_tenant_id is null then
    raise exception 'Caller is not a tenant admin.';
  end if;
  select membership_enabled into v_enabled from public.tenants where id = v_tenant_id;
  return jsonb_build_object('membershipEnabled', coalesce(v_enabled, false));
end;
$$;

create or replace function public.list_tenant_members()
returns setof public.tenant_members
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
  return query select * from public.tenant_members where tenant_id = v_tenant_id order by company_name;
end;
$$;

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
       show_internally, show_externally, website, logo_url, blurb, notes)
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
      p_payload->>'notes'
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

create or replace function public.list_membership_prospects()
returns setof public.membership_prospects
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
  return query select * from public.membership_prospects where tenant_id = v_tenant_id order by created_at desc;
end;
$$;

create or replace function public.create_or_update_prospect(p_payload jsonb)
returns public.membership_prospects
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public.admin_tenant_id();
  v_id uuid := nullif(p_payload->>'id', '')::uuid;
  v_row public.membership_prospects;
begin
  if v_tenant_id is null then
    raise exception 'Caller is not a tenant admin.';
  end if;

  if v_id is null then
    insert into public.membership_prospects
      (tenant_id, company_name, domain, companies_house_number, sic_codes, stage, source, notes)
    values (
      v_tenant_id,
      p_payload->>'companyName',
      lower(nullif(trim(p_payload->>'domain'), '')),
      p_payload->>'companiesHouseNumber',
      coalesce((select array_agg(c) from jsonb_array_elements_text(coalesce(p_payload->'sicCodes', '[]'::jsonb)) c), '{}'),
      coalesce(p_payload->>'stage', 'Identified'),
      coalesce(p_payload->>'source', 'Manual'),
      p_payload->>'notes'
    )
    returning * into v_row;
  else
    update public.membership_prospects set
      company_name = p_payload->>'companyName',
      domain = lower(nullif(trim(p_payload->>'domain'), '')),
      companies_house_number = p_payload->>'companiesHouseNumber',
      sic_codes = coalesce((select array_agg(c) from jsonb_array_elements_text(coalesce(p_payload->'sicCodes', '[]'::jsonb)) c), '{}'),
      notes = p_payload->>'notes',
      updated_at = now()
    where id = v_id and tenant_id = v_tenant_id
    returning * into v_row;

    if v_row is null then
      raise exception 'Prospect not found for this tenant.';
    end if;
  end if;

  return v_row;
end;
$$;

create or replace function public.set_prospect_stage(p_prospect_id uuid, p_stage text)
returns public.membership_prospects
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public.admin_tenant_id();
  v_row public.membership_prospects;
begin
  if v_tenant_id is null then
    raise exception 'Caller is not a tenant admin.';
  end if;
  if p_stage not in ('Suggested','Identified','Contacted','In Discussion','Not a Fit','Lost') then
    raise exception 'Use convert_prospect_to_member to move a prospect to Converted.';
  end if;

  update public.membership_prospects set stage = p_stage, updated_at = now()
  where id = p_prospect_id and tenant_id = v_tenant_id
  returning * into v_row;

  if v_row is null then
    raise exception 'Prospect not found for this tenant.';
  end if;
  return v_row;
end;
$$;

-- "Convert to Member" -- pre-fills the new member from the prospect and
-- re-points the prospect's existing interaction history onto the new
-- member id, so the profile the plan describes ("the member's profile
-- keeps the full relationship history from before they joined") is true
-- without a second, orphaned log.
create or replace function public.convert_prospect_to_member(p_prospect_id uuid)
returns public.tenant_members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public.admin_tenant_id();
  v_prospect public.membership_prospects;
  v_member public.tenant_members;
begin
  if v_tenant_id is null then
    raise exception 'Caller is not a tenant admin.';
  end if;

  select * into v_prospect from public.membership_prospects
    where id = p_prospect_id and tenant_id = v_tenant_id;
  if v_prospect is null then
    raise exception 'Prospect not found for this tenant.';
  end if;
  if v_prospect.stage = 'Converted' then
    raise exception 'This prospect has already been converted.';
  end if;

  insert into public.tenant_members
    (tenant_id, company_name, domains, companies_house_number, sic_codes, status)
  values (
    v_tenant_id,
    v_prospect.company_name,
    case when v_prospect.domain is not null then array[v_prospect.domain] else '{}'::text[] end,
    v_prospect.companies_house_number,
    v_prospect.sic_codes,
    'Active'
  )
  returning * into v_member;

  update public.membership_prospects
    set stage = 'Converted', converted_member_id = v_member.id, updated_at = now()
    where id = v_prospect.id;

  update public.membership_interactions
    set subject_type = 'member', subject_id = v_member.id
    where tenant_id = v_tenant_id and subject_type = 'prospect' and subject_id = v_prospect.id;

  return v_member;
end;
$$;

create or replace function public.list_membership_interactions(p_subject_type text, p_subject_id uuid)
returns setof public.membership_interactions
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
  return query select * from public.membership_interactions
    where tenant_id = v_tenant_id and subject_type = p_subject_type and subject_id = p_subject_id
    order by occurred_at desc;
end;
$$;

-- Also bumps a prospect Identified -> Contacted the first time a real
-- interaction is logged against it, per the pipeline-stages design
-- ("Contacted -- outreach has actually happened, set when the first real
-- interaction is logged").
create or replace function public.log_membership_interaction(
  p_subject_type text, p_subject_id uuid, p_interaction_type text, p_notes text
)
returns public.membership_interactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public.admin_tenant_id();
  v_row public.membership_interactions;
begin
  if v_tenant_id is null then
    raise exception 'Caller is not a tenant admin.';
  end if;
  if p_subject_type not in ('member','prospect') then
    raise exception 'Unknown subject type.';
  end if;

  insert into public.membership_interactions
    (tenant_id, subject_type, subject_id, interaction_type, notes, created_by)
  values (v_tenant_id, p_subject_type, p_subject_id, coalesce(p_interaction_type, 'Note'), p_notes, auth.jwt()->>'email')
  returning * into v_row;

  if p_subject_type = 'prospect' then
    update public.membership_prospects
      set stage = 'Contacted', updated_at = now()
      where id = p_subject_id and tenant_id = v_tenant_id and stage = 'Identified';
  end if;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------
-- Control Centre RPCs -- both piggyback on an existing platform_* function
-- purely for its authorization side-effect (raises if caller isn't
-- platform staff), so neither one needed a second guess about how that
-- check is implemented.
-- ---------------------------------------------------------------------

create or replace function public.get_platform_tenant_membership_flag(p_tenant_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.get_platform_tenant_detail(p_tenant_id); -- staff-auth check only; return value unused
  return (select membership_enabled from public.tenants where id = p_tenant_id);
end;
$$;

create or replace function public.set_platform_tenant_membership_enabled(p_tenant_id uuid, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Functional no-op on status (sets it to its own current value) --
  -- purely inherits set_platform_tenant_status's staff-auth check.
  perform public.set_platform_tenant_status(p_tenant_id, (select status from public.tenants where id = p_tenant_id));
  update public.tenants set membership_enabled = p_enabled where id = p_tenant_id;
end;
$$;

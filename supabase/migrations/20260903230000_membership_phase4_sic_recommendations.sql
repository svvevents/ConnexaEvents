-- Membership Management Module -- Phase 4: SIC-code prospect discovery.
-- Last phase of the "Connexa Membership Design v2" plan. No new tables --
-- companies_house_number and sic_codes already exist on both
-- tenant_members and membership_prospects (Phase 1), exactly as the
-- design anticipated ("Companies House number as a strongly-recommended
-- field, on BOTH members and prospects").
--
-- Companies House API pattern mirrors deliver_email_via_resend_ exactly
-- (this session has its real body, from Phase 3c): a Vault-stored API
-- key (secret name: companies_house_api_key -- get a free one at
-- developer.company-information.service.gov.uk, none is configured yet
-- as of this migration), net.http_get + net.http_collect_response, the
-- SAME confirmed .status / .response.status_code / .response.body /
-- .message field paths, and the same graceful "not configured" message
-- instead of an unhelpful error when the key is missing.
--
-- One real limit worth being explicit about: Companies House's own JSON
-- field names (company_number, company_name, sic_codes, title,
-- address_snippet, items) are NOT something this session can verify via
-- schema introspection the way every Postgres table this whole module
-- touches was -- they're read from public API documentation, not
-- confirmed against a live response. Test the single-company lookup
-- (lowest risk, easiest to sanity-check one real result) before trusting
-- the recommendation job's bulk advanced-search parsing.
--
-- Also inherits Phase 3c's live finding: net.http_get uses the same
-- pg_net extension found hanging on every call during that session --
-- if that outage isn't resolved yet, none of this will actually reach
-- Companies House regardless of whether an API key is configured.

create or replace function public.companies_house_api_key_()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'companies_house_api_key' limit 1;
$$;

create or replace function public.lookup_companies_house_company(p_registration_number text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_api_key text := public.companies_house_api_key_();
  v_request_id bigint;
  v_result net.http_response_result;
  v_body jsonb;
begin
  if public.admin_tenant_id() is null then
    raise exception 'Caller is not a tenant admin.';
  end if;
  if coalesce(trim(p_registration_number), '') = '' then
    raise exception 'Enter a Companies House number to look up.';
  end if;
  if v_api_key is null or v_api_key = '' then
    return jsonb_build_object('ok', false, 'error',
      'Companies House API key not configured. Add one via Supabase Vault (secret name: companies_house_api_key) -- a free key is available at developer.company-information.service.gov.uk.');
  end if;

  v_request_id := net.http_get(
    url := 'https://api.company-information.service.gov.uk/company/' || trim(p_registration_number),
    headers := jsonb_build_object('Authorization', 'Basic ' || encode((v_api_key || ':')::bytea, 'base64')),
    timeout_milliseconds := 15000
  );
  v_result := net.http_collect_response(v_request_id, async := false);

  if v_result.status <> 'SUCCESS' then
    return jsonb_build_object('ok', false, 'error', coalesce(v_result.message, 'Could not reach Companies House right now.'));
  end if;
  if v_result.response.status_code = 404 then
    return jsonb_build_object('ok', false, 'error', 'No company found with that registration number.');
  end if;
  if v_result.response.status_code <> 200 then
    return jsonb_build_object('ok', false, 'error', 'Companies House returned status ' || v_result.response.status_code || '.');
  end if;

  v_body := v_result.response.body::jsonb;
  return jsonb_build_object('ok', true,
    'companyName', v_body->>'company_name',
    'companyNumber', v_body->>'company_number',
    'sicCodes', coalesce(v_body->'sic_codes', '[]'::jsonb)
  );
exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;

create or replace function public.search_companies_house_by_name(p_query text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_api_key text := public.companies_house_api_key_();
  v_request_id bigint;
  v_result net.http_response_result;
  v_body jsonb;
  v_items jsonb;
begin
  if public.admin_tenant_id() is null then
    raise exception 'Caller is not a tenant admin.';
  end if;
  if coalesce(trim(p_query), '') = '' then
    raise exception 'Enter a company name to search.';
  end if;
  if v_api_key is null or v_api_key = '' then
    return jsonb_build_object('ok', false, 'error', 'Companies House API key not configured.');
  end if;

  v_request_id := net.http_get(
    url := 'https://api.company-information.service.gov.uk/search/companies',
    params := jsonb_build_object('q', p_query, 'items_per_page', 10),
    headers := jsonb_build_object('Authorization', 'Basic ' || encode((v_api_key || ':')::bytea, 'base64')),
    timeout_milliseconds := 15000
  );
  v_result := net.http_collect_response(v_request_id, async := false);

  if v_result.status <> 'SUCCESS' or v_result.response.status_code <> 200 then
    return jsonb_build_object('ok', false, 'error', coalesce(v_result.response.body, v_result.message, 'Could not search Companies House right now.'));
  end if;

  v_body := v_result.response.body::jsonb;
  select coalesce(jsonb_agg(jsonb_build_object(
      'companyNumber', item->>'company_number', 'title', item->>'title', 'addressSnippet', item->>'address_snippet'
    )), '[]'::jsonb)
  into v_items
  from jsonb_array_elements(coalesce(v_body->'items', '[]'::jsonb)) item;

  return jsonb_build_object('ok', true, 'results', v_items);
exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;

-- Core recommendation logic for one tenant -- shared by the weekly cron
-- sweep (all membership_enabled tenants) and the admin "Find Similar
-- Companies" button (just the caller's own tenant), same shared-helper
-- pattern as Phase 3b's tier-change sweep.
create or replace function public.run_sic_recommendations_for_tenant_(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_api_key text := public.companies_house_api_key_();
  v_sic_codes text[];
  v_request_id bigint;
  v_result net.http_response_result;
  v_body jsonb;
  v_item jsonb;
  v_reg_number text;
  v_inserted int := 0;
  v_revived int := 0;
  v_skipped int := 0;
begin
  if v_api_key is null or v_api_key = '' then
    return jsonb_build_object('ok', false, 'error', 'Companies House API key not configured.');
  end if;

  select array_agg(distinct c) into v_sic_codes
  from public.tenant_members m, unnest(m.sic_codes) c
  where m.tenant_id = p_tenant_id and m.status = 'Active';

  if v_sic_codes is null or array_length(v_sic_codes, 1) = 0 then
    return jsonb_build_object('ok', false, 'error', 'No Active members have SIC codes on file yet -- look up a Companies House number for one first.');
  end if;

  v_request_id := net.http_get(
    url := 'https://api.company-information.service.gov.uk/advanced-search/companies',
    params := jsonb_build_object('sic_codes', array_to_string(v_sic_codes, ','), 'company_status', 'active', 'size', 50),
    headers := jsonb_build_object('Authorization', 'Basic ' || encode((v_api_key || ':')::bytea, 'base64')),
    timeout_milliseconds := 15000
  );
  v_result := net.http_collect_response(v_request_id, async := false);

  if v_result.status <> 'SUCCESS' or v_result.response.status_code <> 200 then
    return jsonb_build_object('ok', false, 'error', coalesce(v_result.response.body, v_result.message, 'Could not reach Companies House right now.'));
  end if;

  v_body := v_result.response.body::jsonb;

  for v_item in select * from jsonb_array_elements(coalesce(v_body->'items', '[]'::jsonb))
  loop
    v_reg_number := v_item->>'company_number';
    if v_reg_number is null then continue; end if;

    if exists (select 1 from public.tenant_members where tenant_id = p_tenant_id and companies_house_number = v_reg_number) then
      v_skipped := v_skipped + 1; continue;
    end if;

    -- Not a Fit (and every other non-terminal stage) permanently excluded from resurfacing.
    -- Lost is the one stage allowed to resurface -- see the pipeline-stages design note.
    if exists (
      select 1 from public.membership_prospects
      where tenant_id = p_tenant_id and companies_house_number = v_reg_number and stage <> 'Lost'
    ) then
      v_skipped := v_skipped + 1; continue;
    end if;

    if exists (
      select 1 from public.membership_prospects
      where tenant_id = p_tenant_id and companies_house_number = v_reg_number and stage = 'Lost'
    ) then
      update public.membership_prospects
        set stage = 'Suggested', source = 'SIC Match', updated_at = now()
        where tenant_id = p_tenant_id and companies_house_number = v_reg_number and stage = 'Lost';
      v_revived := v_revived + 1;
      continue;
    end if;

    insert into public.membership_prospects (tenant_id, company_name, companies_house_number, sic_codes, stage, source)
    values (
      p_tenant_id, coalesce(v_item->>'company_name', v_item->>'title'), v_reg_number,
      coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(v_item->'sic_codes', '[]'::jsonb)) x), '{}'),
      'Suggested', 'SIC Match'
    );
    v_inserted := v_inserted + 1;
  end loop;

  return jsonb_build_object('ok', true, 'inserted', v_inserted, 'revived', v_revived, 'skipped', v_skipped);
exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;

create or replace function public.run_membership_sic_recommendations_()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant record;
  v_results jsonb := '[]'::jsonb;
begin
  for v_tenant in select id from public.tenants where membership_enabled = true
  loop
    v_results := v_results || jsonb_build_array(jsonb_build_object('tenantId', v_tenant.id, 'result', public.run_sic_recommendations_for_tenant_(v_tenant.id)));
  end loop;
  return jsonb_build_object('status', 'ok', 'tenants', v_results);
end;
$$;

create or replace function public.trigger_membership_sic_recommendations()
returns jsonb
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
  return public.run_sic_recommendations_for_tenant_(v_tenant_id);
end;
$$;

-- Weekly, not daily ("a daily or weekly pass is plenty" per the design)
-- -- 6am Monday, clear of the existing 4am/5am jobs.
select cron.schedule('membership-sic-recommendations', '0 6 * * 1', 'select run_membership_sic_recommendations_();');

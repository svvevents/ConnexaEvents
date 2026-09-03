-- Membership Management Module -- Phase 3d: the member register.
-- Last of four Phase 3 sub-steps. No new tables -- show_internally/
-- show_externally, logo_url, website, blurb, member_since, contact_email
-- all already exist on tenant_members from Phase 1/3c, exactly as the
-- design anticipated ("two per-member flags... set by the tenant's
-- staff"). This just builds the two read views and the contact relay.
--
-- Internal view is gated by "the caller's email resolves to an Active
-- member" -- not an admin capability, so it doesn't use admin_tenant_id()
-- at all; it checks auth.jwt()->>'email' directly, which works for any
-- authenticated Supabase session (attendee or admin) the same way.
-- External view is fully public/unauthenticated, keyed by a ?tid= URL
-- param the same way Unsubscribe.html already does for the same reason
-- (a static public page has no session to resolve a tenant from).
--
-- Neither view ever returns tier, dues status, or notes -- matches the
-- design doc exactly ("kept a private administrative fact for now").
-- Contact happens through deliver_email_via_resend_ directly (a single
-- transactional send, not a batch -- no queue table needed for this).
-- Untrusted public input (inquirer name/email/message) is HTML-escaped
-- before going into the email body via html_escape_ below.

create or replace function public.html_escape_(t text)
returns text
language sql
immutable
as $$
  select replace(replace(replace(coalesce(t, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
$$;

create or replace function public.get_internal_member_directory(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_domain text := lower(split_part(coalesce(auth.jwt()->>'email', ''), '@', 2));
  v_is_member boolean;
  v_result jsonb;
begin
  if v_caller_domain = '' then
    raise exception 'Sign in to view the member directory.';
  end if;

  select exists(
    select 1 from public.tenant_members
    where tenant_id = p_tenant_id and status = 'Active' and v_caller_domain = any(domains)
  ) into v_is_member;

  if not v_is_member then
    raise exception 'This directory is only visible to member companies.';
  end if;

  select coalesce(jsonb_agg(row_to_json(s) order by s."companyName"), '[]'::jsonb) into v_result
  from (
    select company_name as "companyName", logo_url as "logoUrl", website, blurb, member_since as "memberSince"
    from public.tenant_members
    where tenant_id = p_tenant_id and status = 'Active' and show_internally = true
  ) s;

  return v_result;
end;
$$;

create or replace function public.get_public_member_directory(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  select coalesce(jsonb_agg(row_to_json(s) order by s."companyName"), '[]'::jsonb) into v_result
  from (
    select id as "memberId", company_name as "companyName", logo_url as "logoUrl", website, blurb,
           (contact_email is not null and contact_email <> '') as "hasContact"
    from public.tenant_members
    where tenant_id = p_tenant_id and status = 'Active' and show_externally = true
  ) s;

  return v_result;
end;
$$;

create or replace function public.contact_member(
  p_tenant_id uuid, p_member_id uuid, p_inquirer_name text, p_inquirer_email text, p_message text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.tenant_members;
  v_subject text;
  v_html text;
  v_deliver jsonb;
begin
  if coalesce(trim(p_inquirer_name), '') = '' or coalesce(trim(p_inquirer_email), '') = '' or coalesce(trim(p_message), '') = '' then
    raise exception 'Please fill in your name, email, and a message.';
  end if;

  select * into v_member from public.tenant_members
    where id = p_member_id and tenant_id = p_tenant_id and status = 'Active' and show_externally = true;
  if v_member is null then
    raise exception 'Member not found.';
  end if;
  if coalesce(v_member.contact_email, '') = '' then
    raise exception 'This member has not set up a contact email yet.';
  end if;

  v_subject := 'New inquiry via your directory listing';
  v_html := '<p>You have a new inquiry from your public member directory listing on ' || public.html_escape_(v_member.company_name) || '.</p>'
    || '<p><strong>From:</strong> ' || public.html_escape_(p_inquirer_name) || ' &lt;' || public.html_escape_(p_inquirer_email) || '&gt;</p>'
    || '<p><strong>Message:</strong></p><p>' || replace(public.html_escape_(p_message), E'\n', '<br>') || '</p>';

  -- Real delivery is currently blocked by an unrelated pg_net/Resend
  -- infrastructure issue (confirmed live 2026-09-03 -- a raw net.http_post
  -- with no application code involved hangs identically) -- this call
  -- itself is correct and will start working once that's resolved.
  v_deliver := public.deliver_email_via_resend_(p_tenant_id, v_member.contact_email, v_subject, v_html);

  insert into public.comm_log (tenant_id, recipient_email, recipient_name, subject, category, status, error_message, sent_by)
  values (
    p_tenant_id, v_member.contact_email, v_member.contact_name, v_subject, 'Transactional',
    case when (v_deliver->>'ok')::boolean then 'Sent' else 'Failed' end,
    case when (v_deliver->>'ok')::boolean then null else v_deliver->>'error' end,
    'system:contact_member'
  );

  insert into public.membership_interactions (tenant_id, subject_type, subject_id, interaction_type, notes, created_by)
  values (
    p_tenant_id, 'member', v_member.id, 'Email',
    'Directory inquiry from ' || p_inquirer_name || ' <' || p_inquirer_email || '>: ' || left(p_message, 500),
    p_inquirer_email
  );

  if not (v_deliver->>'ok')::boolean then
    raise exception 'Could not deliver your message right now — please try again later.';
  end if;

  return jsonb_build_object('status', 'ok');
end;
$$;

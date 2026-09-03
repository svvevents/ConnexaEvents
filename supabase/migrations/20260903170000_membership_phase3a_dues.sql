-- Membership Management Module -- Phase 3a: dues tracking.
-- First of four Phase 3 sub-steps (dues, opportunities, comms reuse,
-- register) built as separate migrations so each can be verified against
-- production independently, same discipline as Phase 1/2.
--
-- member_dues is a parallel table to orders, same shape (amount,
-- currency, payment_status Pending/Paid, payment_method), keyed to
-- tenant_members instead of events -- orders.event_id is NOT NULL so it
-- can't be reused directly without breaking "membership works with zero
-- events" from the Phase 1 architecture decision.
--
-- orders.member_id is a light, separate, nullable addition so an
-- event-linked charge (a sponsorship, built in Phase 3b) can be
-- attributed to a member without a second row anywhere -- existing
-- orders rows/queries are entirely unaffected, this is purely additive.

create table public.member_dues (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  member_id uuid not null references public.tenant_members(id) on delete cascade,
  description text,
  amount numeric not null,
  currency text not null,
  payment_status text not null default 'Pending' check (payment_status in ('Pending', 'Paid')),
  payment_method text,
  due_date date,
  paid_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index member_dues_tenant_id_idx on public.member_dues(tenant_id);
create index member_dues_member_id_idx on public.member_dues(member_id);
alter table public.member_dues enable row level security; -- zero policies, RPC-only, same convention as every other membership table

alter table public.orders add column if not exists member_id uuid references public.tenant_members(id);

create or replace function public.list_member_dues()
returns setof public.member_dues
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
  return query select * from public.member_dues where tenant_id = v_tenant_id order by due_date nulls last, created_at desc;
end;
$$;

create or replace function public.create_or_update_due(p_payload jsonb)
returns public.member_dues
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public.admin_tenant_id();
  v_id uuid := nullif(p_payload->>'id', '')::uuid;
  v_member_id uuid := (p_payload->>'memberId')::uuid;
  v_row public.member_dues;
begin
  if v_tenant_id is null then
    raise exception 'Caller is not a tenant admin.';
  end if;
  if not exists (select 1 from public.tenant_members where id = v_member_id and tenant_id = v_tenant_id) then
    raise exception 'Member not found for this tenant.';
  end if;

  if v_id is null then
    insert into public.member_dues (tenant_id, member_id, description, amount, currency, payment_method, due_date, notes)
    values (
      v_tenant_id, v_member_id, p_payload->>'description',
      (p_payload->>'amount')::numeric, p_payload->>'currency', p_payload->>'paymentMethod',
      nullif(p_payload->>'dueDate', '')::date, p_payload->>'notes'
    )
    returning * into v_row;
  else
    update public.member_dues set
      member_id = v_member_id,
      description = p_payload->>'description',
      amount = (p_payload->>'amount')::numeric,
      currency = p_payload->>'currency',
      payment_method = p_payload->>'paymentMethod',
      due_date = nullif(p_payload->>'dueDate', '')::date,
      notes = p_payload->>'notes',
      updated_at = now()
    where id = v_id and tenant_id = v_tenant_id
    returning * into v_row;

    if v_row is null then
      raise exception 'Due not found for this tenant.';
    end if;
  end if;

  return v_row;
end;
$$;

create or replace function public.update_due_payment_status(p_due_id uuid, p_new_status text)
returns public.member_dues
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public.admin_tenant_id();
  v_row public.member_dues;
begin
  if v_tenant_id is null then
    raise exception 'Caller is not a tenant admin.';
  end if;
  if p_new_status not in ('Pending', 'Paid') then
    raise exception 'Unknown payment status.';
  end if;

  update public.member_dues set
    payment_status = p_new_status,
    paid_date = case when p_new_status = 'Paid' then coalesce(paid_date, current_date) else null end,
    updated_at = now()
  where id = p_due_id and tenant_id = v_tenant_id
  returning * into v_row;

  if v_row is null then
    raise exception 'Due not found for this tenant.';
  end if;
  return v_row;
end;
$$;

create or replace function public.delete_due(p_due_id uuid)
returns void
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
  delete from public.member_dues where id = p_due_id and tenant_id = v_tenant_id;
end;
$$;

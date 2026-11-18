-- Support caller-supplied next_renewal_date updates and atomic in-app subscription renewals

create or replace function public.subscriptions_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  local_today date := (now() at time zone 'Asia/Shanghai')::date;
begin
  new.updated_at := now();

  if tg_op = 'INSERT' then
    if new.status = 'cancelled' and new.cancelled_at is null then
      new.cancelled_at := now();
    end if;
    if new.status = 'trial' and new.trial_end_date is not null then
      new.next_renewal_date := new.trial_end_date;
    else
      new.next_renewal_date := public.calculate_next_renewal_date(
        new.start_date, new.interval, new.interval_count, local_today
      );
    end if;
  else
    if new.status = 'cancelled' and old.status <> 'cancelled' then
      new.cancelled_at := now();
    elsif new.status <> 'cancelled' and old.status = 'cancelled' then
      new.cancelled_at := null;
    end if;

    if new.status = 'trial' and new.trial_end_date is not null and (
      new.trial_end_date is distinct from old.trial_end_date
      or new.status is distinct from old.status
    ) then
      new.next_renewal_date := new.trial_end_date;
    elsif new.next_renewal_date is not distinct from old.next_renewal_date
       and (
         new.start_date is distinct from old.start_date
         or new.interval is distinct from old.interval
         or new.interval_count is distinct from old.interval_count
         or (new.status = 'active' and old.status <> 'active')
       ) then
      new.next_renewal_date := public.calculate_next_renewal_date(
        new.start_date, new.interval, new.interval_count, local_today
      );
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.renew_subscription(
  p_subscription_id uuid,
  p_cycles integer default 1,
  p_amount numeric default null,
  p_payment_method_id uuid default null,
  p_note text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_sub public.subscriptions%rowtype;
  v_updated public.subscriptions%rowtype;
  v_event public.subscription_events%rowtype;
  local_today date := (now() at time zone 'Asia/Shanghai')::date;
  v_cycles integer := greatest(1, least(coalesce(p_cycles, 1), 60));
  v_step integer;
  v_current_due date;
  v_base_date date;
  v_new_date date;
  v_is_extend boolean;
  v_payment_method_id uuid;
  v_pm_name text := '';
  v_pm_name_en text := '';
  v_paid_amount numeric(12,2);
  v_note text := left(coalesce(nullif(trim(p_note), ''), ''), 300);
begin
  if v_uid is null then
    raise exception 'unauthorized';
  end if;

  if not public.is_active_user() then
    raise exception 'account_restricted';
  end if;

  select *
  into v_sub
  from public.subscriptions s
  where s.id = p_subscription_id
    and s.user_id = v_uid
  for update;

  if not found then
    raise exception 'subscription_not_found';
  end if;

  if p_payment_method_id is not null then
    select pm.id
    into v_payment_method_id
    from public.payment_methods pm
    where pm.id = p_payment_method_id
      and pm.user_id = v_uid;

    if not found then
      raise exception 'invalid_payment_method';
    end if;
  else
    v_payment_method_id := v_sub.payment_method_id;
  end if;

  if v_payment_method_id is not null then
    select
      case when nullif(pm.last4, '') is not null then pm.name || ' · ' || pm.last4 else pm.name end,
      case when nullif(pm.last4, '') is not null then coalesce(nullif(pm.name_en, ''), pm.name) || ' · ' || pm.last4 else coalesce(nullif(pm.name_en, ''), pm.name) end
    into v_pm_name, v_pm_name_en
    from public.payment_methods pm
    where pm.id = v_payment_method_id
      and pm.user_id = v_uid;
  end if;

  v_current_due := case
    when v_sub.status = 'trial' and v_sub.trial_end_date is not null then v_sub.trial_end_date
    else v_sub.next_renewal_date
  end;

  v_is_extend := v_sub.status in ('active', 'trial') and v_current_due >= local_today;
  v_base_date := case when v_is_extend then v_current_due else local_today end;
  v_step := v_cycles * greatest(1, coalesce(v_sub.interval_count, 1));

  if v_sub.interval = 'week' then
    v_new_date := v_base_date + (v_step * 7);
  elsif v_sub.interval = 'month' then
    v_new_date := (v_base_date + (v_step * interval '1 month'))::date;
  elsif v_sub.interval = 'quarter' then
    v_new_date := (v_base_date + (v_step * 3 * interval '1 month'))::date;
  elsif v_sub.interval = 'year' then
    v_new_date := (v_base_date + (v_step * interval '1 year'))::date;
  else
    v_new_date := v_base_date + v_step;
  end if;

  v_paid_amount := greatest(0, round(coalesce(p_amount, v_sub.amount * v_cycles)::numeric, 2));

  update public.subscriptions
  set
    status = 'active',
    trial_end_date = null,
    cancelled_at = null,
    next_renewal_date = v_new_date,
    payment_method_id = v_payment_method_id,
    updated_at = now()
  where id = v_sub.id
    and user_id = v_uid
  returning * into v_updated;

  insert into public.subscription_events (
    subscription_id,
    user_id,
    type,
    amount,
    currency,
    occurred_on,
    meta
  )
  values (
    v_sub.id,
    v_uid,
    'charge',
    v_paid_amount,
    v_sub.currency,
    local_today,
    jsonb_build_object(
      'in_app_renewal', true,
      'cycles', v_cycles,
      'previous_renewal_date', v_current_due,
      'new_renewal_date', v_new_date,
      'rollover_mode', case when v_is_extend then 'extend' else 'from_today' end,
      'payment_method_id', v_payment_method_id,
      'payment_method_name', coalesce(v_pm_name, ''),
      'payment_method_name_en', coalesce(v_pm_name_en, ''),
      'note', v_note
    )
  )
  returning * into v_event;

  return jsonb_build_object(
    'subscription', to_jsonb(v_updated),
    'event', to_jsonb(v_event)
  );
end;
$$;

revoke all on function public.renew_subscription(uuid, integer, numeric, uuid, text) from public;
grant execute on function public.renew_subscription(uuid, integer, numeric, uuid, text) to authenticated;

-- Renewly subscription management schema, functions, triggers, RLS, templates, rates, and cron scheduling.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- Private schema for internal cron verification secret (never exposed via PostgREST).
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.cron_secrets (
  name text primary key,
  value text not null,
  created_at timestamptz not null default now()
);
revoke all on table private.cron_secrets from public, anon, authenticated;

insert into private.cron_secrets (name, value)
values ('edge_cron_secret', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (name) do nothing;

create or replace function public.verify_cron_secret(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.cron_secrets s
    where s.name = 'edge_cron_secret'
      and s.value = coalesce(p_secret, '')
  );
$$;

revoke all on function public.verify_cron_secret(text) from public, anon, authenticated;
grant execute on function public.verify_cron_secret(text) to service_role;

-- ---------------------------------------------------------------------------
-- 1. Core tables
-- ---------------------------------------------------------------------------

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null default 'other',
  name text not null,
  name_en text not null default '',
  color text not null default '#5B5BF0',
  icon text not null default 'sparkles',
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  constraint categories_name_length check (char_length(trim(name)) between 1 and 40),
  constraint categories_user_name_key unique (user_id, name)
);

create index if not exists categories_user_sort_idx
  on public.categories (user_id, sort, created_at);

alter table public.categories enable row level security;

create policy "users read own categories"
  on public.categories for select to authenticated
  using (user_id = (select auth.uid()));

create policy "active users insert own categories"
  on public.categories for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_active_user());

create policy "active users update own categories"
  on public.categories for update to authenticated
  using (user_id = (select auth.uid()) and public.is_active_user())
  with check (user_id = (select auth.uid()) and public.is_active_user());

create policy "active users delete own categories"
  on public.categories for delete to authenticated
  using (user_id = (select auth.uid()) and public.is_active_user());

grant select, insert, update, delete on public.categories to authenticated;

-- Payment methods
create table if not exists public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  name_en text not null default '',
  type text not null default 'wallet',
  last4 text,
  created_at timestamptz not null default now(),
  constraint payment_methods_name_length check (char_length(trim(name)) between 1 and 40),
  constraint payment_methods_type_check check (type in ('alipay','wechat','card','apple_pay','paypal','bank','other','wallet')),
  constraint payment_methods_last4_check check (last4 is null or last4 ~ '^[0-9]{4}$'),
  constraint payment_methods_user_name_key unique (user_id, name)
);

create index if not exists payment_methods_user_idx
  on public.payment_methods (user_id, created_at);

alter table public.payment_methods enable row level security;

create policy "users read own payment methods"
  on public.payment_methods for select to authenticated
  using (user_id = (select auth.uid()));

create policy "active users insert own payment methods"
  on public.payment_methods for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_active_user());

create policy "active users update own payment methods"
  on public.payment_methods for update to authenticated
  using (user_id = (select auth.uid()) and public.is_active_user())
  with check (user_id = (select auth.uid()) and public.is_active_user());

create policy "active users delete own payment methods"
  on public.payment_methods for delete to authenticated
  using (user_id = (select auth.uid()) and public.is_active_user());

grant select, insert, update, delete on public.payment_methods to authenticated;

-- Subscriptions
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  color text not null default '#5B5BF0',
  icon text not null default 'sparkles',
  amount numeric(12,2) not null,
  currency text not null default 'CNY',
  interval text not null default 'month',
  interval_count integer not null default 1,
  start_date date not null default current_date,
  next_renewal_date date not null default current_date,
  status text not null default 'active',
  trial_end_date date,
  auto_renew boolean not null default true,
  category_id uuid references public.categories(id) on delete set null,
  payment_method_id uuid references public.payment_methods(id) on delete set null,
  url text not null default '',
  cancel_url text not null default '',
  note text not null default '',
  reminder_days integer not null default 3,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscriptions_name_length check (char_length(trim(name)) between 1 and 80),
  constraint subscriptions_amount_nonneg check (amount >= 0),
  constraint subscriptions_currency_check check (currency in ('CNY','USD','EUR','HKD','JPY','GBP')),
  constraint subscriptions_interval_check check (interval in ('week','month','quarter','year','custom')),
  constraint subscriptions_interval_count_check check (interval_count between 1 and 365),
  constraint subscriptions_status_check check (status in ('trial','active','paused','cancelled')),
  constraint subscriptions_note_length check (char_length(note) <= 500),
  constraint subscriptions_reminder_days_check check (reminder_days between 0 and 30)
);

create index if not exists subscriptions_user_status_renewal_idx
  on public.subscriptions (user_id, status, next_renewal_date);
create index if not exists subscriptions_category_idx
  on public.subscriptions (category_id);
create index if not exists subscriptions_payment_method_idx
  on public.subscriptions (payment_method_id);

alter table public.subscriptions enable row level security;

create policy "users read own subscriptions"
  on public.subscriptions for select to authenticated
  using (user_id = (select auth.uid()));

create policy "active users insert own subscriptions"
  on public.subscriptions for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_active_user());

create policy "active users update own subscriptions"
  on public.subscriptions for update to authenticated
  using (user_id = (select auth.uid()) and public.is_active_user())
  with check (user_id = (select auth.uid()) and public.is_active_user());

create policy "active users delete own subscriptions"
  on public.subscriptions for delete to authenticated
  using (user_id = (select auth.uid()) and public.is_active_user());

grant select, insert, update, delete on public.subscriptions to authenticated;

-- Subscription events
create table if not exists public.subscription_events (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  amount numeric(12,2) not null default 0,
  currency text not null default 'CNY',
  occurred_on date not null default current_date,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  constraint subscription_events_type_check check (type in ('charge','price_change','status_change'))
);

create index if not exists subscription_events_sub_date_idx
  on public.subscription_events (subscription_id, occurred_on desc, created_at desc);
create index if not exists subscription_events_user_date_idx
  on public.subscription_events (user_id, occurred_on desc);

alter table public.subscription_events enable row level security;

create policy "users read own subscription events"
  on public.subscription_events for select to authenticated
  using (user_id = (select auth.uid()));

create policy "active users insert own subscription events"
  on public.subscription_events for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_active_user());

create policy "active users delete own subscription events"
  on public.subscription_events for delete to authenticated
  using (user_id = (select auth.uid()) and public.is_active_user());

grant select, insert, delete on public.subscription_events to authenticated;

-- User settings
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  locale text not null default 'zh-CN',
  base_currency text not null default 'CNY',
  theme text not null default 'system',
  email_reminders boolean not null default true,
  default_reminder_days integer not null default 3,
  updated_at timestamptz not null default now(),
  constraint user_settings_locale_check check (locale in ('zh-CN','en')),
  constraint user_settings_currency_check check (base_currency in ('CNY','USD','EUR','HKD','JPY','GBP')),
  constraint user_settings_theme_check check (theme in ('system','light','dark')),
  constraint user_settings_reminder_days_check check (default_reminder_days between 0 and 30)
);

alter table public.user_settings enable row level security;

create policy "users read own settings"
  on public.user_settings for select to authenticated
  using (user_id = (select auth.uid()));

create policy "users insert own settings"
  on public.user_settings for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "users update own settings"
  on public.user_settings for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update on public.user_settings to authenticated;

-- Reminder log
create table if not exists public.reminder_log (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  remind_for_date date not null,
  sent_at timestamptz not null default now(),
  status text not null default 'sent',
  error_message text,
  constraint reminder_log_status_check check (status in ('sent','failed')),
  constraint reminder_log_sub_date_key unique (subscription_id, remind_for_date)
);

create index if not exists reminder_log_user_sent_idx
  on public.reminder_log (user_id, sent_at desc);

alter table public.reminder_log enable row level security;

create policy "users or admins read reminder log"
  on public.reminder_log for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

grant select on public.reminder_log to authenticated;

-- Exchange rates
create table if not exists public.exchange_rates (
  base text not null,
  quote text not null,
  rate numeric(18,6) not null,
  fetched_on date not null default current_date,
  updated_at timestamptz not null default now(),
  primary key (base, quote),
  constraint exchange_rates_positive check (rate > 0),
  constraint exchange_rates_currencies check (
    base in ('CNY','USD','EUR','HKD','JPY','GBP')
    and quote in ('CNY','USD','EUR','HKD','JPY','GBP')
  )
);

alter table public.exchange_rates enable row level security;

create policy "exchange rates are readable"
  on public.exchange_rates for select to anon, authenticated
  using (true);

grant select on public.exchange_rates to anon, authenticated;

-- Public subscription templates
create table if not exists public.subscription_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  name_en text not null,
  color text not null default '#5B5BF0',
  icon text not null default 'sparkles',
  category_key text not null default 'entertainment',
  default_amount numeric(12,2) not null default 0,
  currency text not null default 'CNY',
  interval text not null default 'month',
  url text not null default '',
  cancel_url text not null default '',
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  constraint subscription_templates_currency_check check (currency in ('CNY','USD','EUR','HKD','JPY','GBP')),
  constraint subscription_templates_interval_check check (interval in ('week','month','quarter','year')),
  constraint subscription_templates_amount_nonneg check (default_amount >= 0)
);

alter table public.subscription_templates enable row level security;

create policy "subscription templates are readable"
  on public.subscription_templates for select to anon, authenticated
  using (true);

create policy "admins insert subscription templates"
  on public.subscription_templates for insert to authenticated
  with check (public.is_admin());

create policy "admins update subscription templates"
  on public.subscription_templates for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "admins delete subscription templates"
  on public.subscription_templates for delete to authenticated
  using (public.is_admin());

grant select on public.subscription_templates to anon, authenticated;
grant insert, update, delete on public.subscription_templates to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Seed baseline exchange rates & 12 popular subscription templates
-- ---------------------------------------------------------------------------

with cny_rates(quote, rate) as (
  values
    ('CNY', 1.000000::numeric),
    ('USD', 0.138500::numeric),
    ('EUR', 0.129000::numeric),
    ('HKD', 1.078000::numeric),
    ('JPY', 21.150000::numeric),
    ('GBP', 0.109500::numeric)
)
insert into public.exchange_rates (base, quote, rate, fetched_on)
select a.quote, b.quote, round((b.rate / a.rate)::numeric, 6), current_date
from cny_rates a
cross join cny_rates b
on conflict (base, quote) do nothing;

insert into public.subscription_templates
  (name, name_en, color, icon, category_key, default_amount, currency, interval, url, cancel_url, sort)
values
  ('Netflix', 'Netflix', '#E50914', 'tv', 'entertainment', 68.00, 'CNY', 'month', 'https://www.netflix.com', 'https://www.netflix.com/cancelplan', 1),
  ('Spotify', 'Spotify', '#1DB954', 'music', 'entertainment', 15.00, 'CNY', 'month', 'https://www.spotify.com', 'https://www.spotify.com/account/subscription/', 2),
  ('iCloud+', 'iCloud+', '#3B82F6', 'cloud', 'cloud', 21.00, 'CNY', 'month', 'https://www.icloud.com', 'https://support.apple.com/HT202039', 3),
  ('ChatGPT Plus', 'ChatGPT Plus', '#10A37F', 'sparkles', 'productivity', 20.00, 'USD', 'month', 'https://chatgpt.com', 'https://chatgpt.com/#settings/Subscription', 4),
  ('YouTube Premium', 'YouTube Premium', '#FF0000', 'play_circle', 'entertainment', 13.99, 'USD', 'month', 'https://www.youtube.com/premium', 'https://www.youtube.com/paid_memberships', 5),
  ('Adobe Creative Cloud', 'Adobe Creative Cloud', '#FF0000', 'layers', 'productivity', 59.99, 'USD', 'month', 'https://www.adobe.com', 'https://account.adobe.com/plans', 6),
  ('Microsoft 365', 'Microsoft 365', '#0078D4', 'briefcase', 'productivity', 398.00, 'CNY', 'year', 'https://www.microsoft365.com', 'https://account.microsoft.com/services', 7),
  ('GitHub Copilot', 'GitHub Copilot', '#24292F', 'code', 'productivity', 10.00, 'USD', 'month', 'https://github.com/features/copilot', 'https://github.com/settings/billing', 8),
  ('Bilibili 大会员', 'Bilibili Premium', '#FB7299', 'tv', 'entertainment', 25.00, 'CNY', 'month', 'https://www.bilibili.com', 'https://account.bilibili.com/account/big', 9),
  ('网易云音乐黑胶 VIP', 'NetEase Cloud Music VIP', '#D43C33', 'music', 'entertainment', 15.00, 'CNY', 'month', 'https://music.163.com', 'https://music.163.com/member', 10),
  ('腾讯视频 VIP', 'Tencent Video VIP', '#FF6A00', 'tv', 'entertainment', 30.00, 'CNY', 'month', 'https://v.qq.com', 'https://film.qq.com', 11),
  ('京东 PLUS 会员', 'JD PLUS Membership', '#E1251B', 'shopping_bag', 'life', 99.00, 'CNY', 'year', 'https://plus.jd.com', 'https://plus.jd.com', 12)
on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Renewal calculation, spending summary & triggers
-- ---------------------------------------------------------------------------

create or replace function public.calculate_next_renewal_date(
  p_start_date date,
  p_interval text,
  p_interval_count integer,
  p_from_date date default current_date
)
returns date
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  step_count integer := greatest(1, coalesce(p_interval_count, 1));
  anchor date := coalesce(p_start_date, current_date);
  target_from date := coalesce(p_from_date, current_date);
  candidate date := anchor;
  k integer := 0;
begin
  if anchor >= target_from then
    return anchor;
  end if;

  loop
    k := k + 1;
    if p_interval = 'week' then
      candidate := anchor + (k * step_count * 7);
    elsif p_interval = 'month' then
      candidate := (anchor + (k * step_count * interval '1 month'))::date;
    elsif p_interval = 'quarter' then
      candidate := (anchor + (k * step_count * 3 * interval '1 month'))::date;
    elsif p_interval = 'year' then
      candidate := (anchor + (k * step_count * interval '1 year'))::date;
    else
      -- custom defaults to days
      candidate := anchor + (k * step_count);
    end if;

    exit when candidate >= target_from or k >= 5000;
  end loop;

  return candidate;
end;
$$;

revoke all on function public.calculate_next_renewal_date(date, text, integer, date) from public;
grant execute on function public.calculate_next_renewal_date(date, text, integer, date) to anon, authenticated;

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
    elsif new.start_date is distinct from old.start_date
       or new.interval is distinct from old.interval
       or new.interval_count is distinct from old.interval_count
       or (new.status = 'active' and old.status <> 'active') then
      new.next_renewal_date := public.calculate_next_renewal_date(
        new.start_date, new.interval, new.interval_count, local_today
      );
    end if;
  end if;

  return new;
end;
$$;

create or replace trigger subscriptions_before_write
  before insert or update on public.subscriptions
  for each row execute function public.subscriptions_before_write();

create or replace function public.subscriptions_after_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  local_today date := (now() at time zone 'Asia/Shanghai')::date;
begin
  if tg_op = 'INSERT' then
    if new.status = 'active' and new.start_date <= local_today then
      insert into public.subscription_events (subscription_id, user_id, type, amount, currency, occurred_on, meta)
      values (new.id, new.user_id, 'charge', new.amount, new.currency, new.start_date, jsonb_build_object('initial', true));
    end if;
  else
    if new.amount is distinct from old.amount or new.currency is distinct from old.currency then
      insert into public.subscription_events (subscription_id, user_id, type, amount, currency, occurred_on, meta)
      values (
        new.id,
        new.user_id,
        'price_change',
        new.amount,
        new.currency,
        local_today,
        jsonb_build_object('previous_amount', old.amount, 'previous_currency', old.currency)
      );
    end if;

    if new.status is distinct from old.status then
      insert into public.subscription_events (subscription_id, user_id, type, amount, currency, occurred_on, meta)
      values (
        new.id,
        new.user_id,
        'status_change',
        new.amount,
        new.currency,
        local_today,
        jsonb_build_object('from', old.status, 'to', new.status)
      );
    end if;
  end if;

  return new;
end;
$$;

create or replace trigger subscriptions_after_write
  after insert or update on public.subscriptions
  for each row execute function public.subscriptions_after_write();

create or replace function public.get_spending_summary(p_base_currency text default 'CNY')
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  base_curr text := upper(coalesce(nullif(trim(p_base_currency), ''), 'CNY'));
  local_today date := (now() at time zone 'Asia/Shanghai')::date;
  month_start timestamptz := date_trunc('month', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai';
  monthly_total numeric := 0;
  yearly_total numeric := 0;
  saved_monthly numeric := 0;
  due_7d_count integer := 0;
  trial_count integer := 0;
  active_count integer := 0;
  by_category jsonb := '[]'::jsonb;
  upcoming jsonb := '[]'::jsonb;
begin
  if base_curr not in ('CNY','USD','EUR','HKD','JPY','GBP') then
    base_curr := 'CNY';
  end if;

  with sub_calc as (
    select
      s.id,
      s.name,
      s.color,
      s.icon,
      s.amount,
      s.currency,
      s.interval,
      s.interval_count,
      s.status,
      s.next_renewal_date,
      s.trial_end_date,
      s.category_id,
      s.updated_at,
      s.cancelled_at,
      coalesce(r.rate, 1.0::numeric) as fx_rate,
      (s.amount * coalesce(r.rate, 1.0::numeric)) as converted_amount,
      case
        when s.interval = 'week' then (s.amount * coalesce(r.rate, 1.0::numeric)) * (52.0 / 12.0) / greatest(1, s.interval_count)
        when s.interval = 'month' then (s.amount * coalesce(r.rate, 1.0::numeric)) / greatest(1, s.interval_count)
        when s.interval = 'quarter' then (s.amount * coalesce(r.rate, 1.0::numeric)) / (3.0 * greatest(1, s.interval_count))
        when s.interval = 'year' then (s.amount * coalesce(r.rate, 1.0::numeric)) / (12.0 * greatest(1, s.interval_count))
        else (s.amount * coalesce(r.rate, 1.0::numeric)) * (30.4375 / greatest(1, s.interval_count))
      end as monthly_equiv
    from public.subscriptions s
    left join public.exchange_rates r
      on r.base = s.currency and r.quote = base_curr
  )
  select
    coalesce(round(sum(case when status in ('active', 'trial') then monthly_equiv else 0 end), 2), 0),
    coalesce(round(sum(case when status in ('active', 'trial') then monthly_equiv * 12 else 0 end), 2), 0),
    coalesce(round(sum(case
      when status = 'paused' and updated_at >= month_start then monthly_equiv
      when status = 'cancelled' and coalesce(cancelled_at, updated_at) >= month_start then monthly_equiv
      else 0
    end), 2), 0),
    count(*) filter (where status in ('active', 'trial') and next_renewal_date between local_today and local_today + 7)::integer,
    count(*) filter (where status = 'trial')::integer,
    count(*) filter (where status in ('active', 'trial'))::integer
  into monthly_total, yearly_total, saved_monthly, due_7d_count, trial_count, active_count
  from sub_calc;

  with sub_calc as (
    select
      s.category_id,
      s.status,
      case
        when s.interval = 'week' then (s.amount * coalesce(r.rate, 1.0::numeric)) * (52.0 / 12.0) / greatest(1, s.interval_count)
        when s.interval = 'month' then (s.amount * coalesce(r.rate, 1.0::numeric)) / greatest(1, s.interval_count)
        when s.interval = 'quarter' then (s.amount * coalesce(r.rate, 1.0::numeric)) / (3.0 * greatest(1, s.interval_count))
        when s.interval = 'year' then (s.amount * coalesce(r.rate, 1.0::numeric)) / (12.0 * greatest(1, s.interval_count))
        else (s.amount * coalesce(r.rate, 1.0::numeric)) * (30.4375 / greatest(1, s.interval_count))
      end as monthly_equiv
    from public.subscriptions s
    left join public.exchange_rates r
      on r.base = s.currency and r.quote = base_curr
    where s.status in ('active', 'trial')
  )
  select coalesce(jsonb_agg(row_obj order by (row_obj->>'monthly_amount')::numeric desc), '[]'::jsonb)
  into by_category
  from (
    select jsonb_build_object(
      'category_id', c.id,
      'name', coalesce(c.name, '未分类'),
      'name_en', coalesce(nullif(c.name_en, ''), 'Other'),
      'color', coalesce(c.color, '#94A3B8'),
      'monthly_amount', round(sum(sc.monthly_equiv), 2)
    ) as row_obj
    from sub_calc sc
    left join public.categories c on c.id = sc.category_id
    group by c.id, c.name, c.name_en, c.color
  ) grouped;

  select coalesce(jsonb_agg(item order by (item->>'next_renewal_date') asc), '[]'::jsonb)
  into upcoming
  from (
    select jsonb_build_object(
      'id', s.id,
      'name', s.name,
      'color', s.color,
      'icon', s.icon,
      'amount', s.amount,
      'currency', s.currency,
      'status', s.status,
      'next_renewal_date', s.next_renewal_date,
      'trial_end_date', s.trial_end_date,
      'days_until', (s.next_renewal_date - local_today)
    ) as item
    from public.subscriptions s
    where s.status in ('active', 'trial')
      and s.next_renewal_date between local_today and local_today + 30
    order by s.next_renewal_date asc, s.amount desc
    limit 10
  ) up;

  return jsonb_build_object(
    'base_currency', base_curr,
    'monthly_total', monthly_total,
    'yearly_total', yearly_total,
    'saved_monthly', saved_monthly,
    'due_7d_count', due_7d_count,
    'trial_count', trial_count,
    'active_count', active_count,
    'by_category', by_category,
    'upcoming', upcoming
  );
end;
$$;

revoke all on function public.get_spending_summary(text) from public;
grant execute on function public.get_spending_summary(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Default user seeding & handle_new_user update + backfill
-- ---------------------------------------------------------------------------

create or replace function public.seed_defaults_for_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null then
    return;
  end if;

  insert into public.user_settings (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  if not exists (select 1 from public.categories c where c.user_id = p_user_id) then
    insert into public.categories (user_id, key, name, name_en, color, icon, sort)
    values
      (p_user_id, 'entertainment', '影音娱乐', 'Entertainment', '#5B5BF0', 'tv', 1),
      (p_user_id, 'productivity', '工具效率', 'Productivity', '#10B981', 'sparkles', 2),
      (p_user_id, 'cloud', '云存储', 'Cloud Storage', '#3B82F6', 'cloud', 3),
      (p_user_id, 'fitness', '健康运动', 'Health & Fitness', '#F59E0B', 'heart', 4),
      (p_user_id, 'life', '生活消费', 'Lifestyle', '#EC4899', 'shopping_bag', 5),
      (p_user_id, 'other', '其他订阅', 'Other', '#64748B', 'layers', 6)
    on conflict (user_id, name) do nothing;
  end if;

  if not exists (select 1 from public.payment_methods pm where pm.user_id = p_user_id) then
    insert into public.payment_methods (user_id, name, name_en, type)
    values
      (p_user_id, '支付宝', 'Alipay', 'alipay'),
      (p_user_id, '微信支付', 'WeChat Pay', 'wechat'),
      (p_user_id, 'Apple Pay', 'Apple Pay', 'apple_pay'),
      (p_user_id, '信用卡', 'Credit Card', 'card')
    on conflict (user_id, name) do nothing;
  end if;
end;
$$;

revoke all on function public.seed_defaults_for_user(uuid) from public, anon, authenticated;

create or replace function public.ensure_user_defaults()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  perform public.seed_defaults_for_user(uid);
end;
$$;

revoke all on function public.ensure_user_defaults() from public, anon;
grant execute on function public.ensure_user_defaults() to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  generated_uid text;
begin
  generated_uid := public.generate_profile_uid();
  insert into public.profiles(id, uid, display_name)
  values (new.id, generated_uid, public.generate_random_profile_name())
  on conflict (id) do nothing;

  insert into public.user_auth_settings(user_id, password_set)
  values (new.id, coalesce(new.encrypted_password, '') <> '')
  on conflict (user_id) do update
    set password_set = excluded.password_set,
        updated_at = now();

  perform public.seed_defaults_for_user(new.id);
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

-- Backfill defaults for existing auth users
do $$
declare
  u record;
begin
  for u in select id from auth.users loop
    perform public.seed_defaults_for_user(u.id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Daily subscription rollover & pg_cron jobs
-- ---------------------------------------------------------------------------

create or replace function public.process_due_subscriptions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  local_today date := (now() at time zone 'Asia/Shanghai')::date;
  sub record;
  processed_count integer := 0;
  next_date date;
begin
  for sub in
    select *
    from public.subscriptions
    where (status = 'active' and auto_renew = true and next_renewal_date < local_today)
       or (status = 'trial' and trial_end_date is not null and trial_end_date < local_today)
    for update
  loop
    if sub.status = 'trial' then
      if sub.auto_renew then
        next_date := public.calculate_next_renewal_date(
          sub.trial_end_date, sub.interval, sub.interval_count, local_today
        );
        update public.subscriptions
        set status = 'active',
            start_date = sub.trial_end_date,
            next_renewal_date = next_date,
            updated_at = now()
        where id = sub.id;

        if not exists (
          select 1 from public.subscription_events e
          where e.subscription_id = sub.id and e.type = 'charge' and e.occurred_on = sub.trial_end_date
        ) then
          insert into public.subscription_events (subscription_id, user_id, type, amount, currency, occurred_on, meta)
          values (sub.id, sub.user_id, 'charge', sub.amount, sub.currency, sub.trial_end_date, jsonb_build_object('from_trial', true));
        end if;
      else
        update public.subscriptions
        set status = 'paused',
            updated_at = now()
        where id = sub.id;
      end if;
      processed_count := processed_count + 1;
    else
      next_date := public.calculate_next_renewal_date(
        sub.start_date, sub.interval, sub.interval_count, local_today
      );
      if not exists (
        select 1 from public.subscription_events e
        where e.subscription_id = sub.id and e.type = 'charge' and e.occurred_on = sub.next_renewal_date
      ) then
        insert into public.subscription_events (subscription_id, user_id, type, amount, currency, occurred_on, meta)
        values (sub.id, sub.user_id, 'charge', sub.amount, sub.currency, sub.next_renewal_date, jsonb_build_object('auto_renewed', true));
      end if;

      update public.subscriptions
      set next_renewal_date = next_date,
          updated_at = now()
      where id = sub.id;

      processed_count := processed_count + 1;
    end if;
  end loop;

  return processed_count;
end;
$$;

revoke all on function public.process_due_subscriptions() from public, anon, authenticated;
grant execute on function public.process_due_subscriptions() to service_role;

-- Schedule pg_cron jobs (UTC times: 16:05 UTC = 00:05 Asia/Shanghai, 01:00 UTC = 09:00 Asia/Shanghai)
do $$
begin
  perform cron.unschedule('renewly-rollover-due');
exception when others then null;
end $$;
select cron.schedule(
  'renewly-rollover-due',
  '5 16 * * *',
  $$select public.process_due_subscriptions();$$
);

do $$
begin
  perform cron.unschedule('renewly-send-reminders');
exception when others then null;
end $$;
select cron.schedule(
  'renewly-send-reminders',
  '0 1 * * *',
  $$
  select net.http_post(
    url := 'https://obyqyzgycivgituobdzm.supabase.co/functions/v1/send-renewal-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select value from private.cron_secrets where name = 'edge_cron_secret')
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);

do $$
begin
  perform cron.unschedule('renewly-refresh-rates');
exception when others then null;
end $$;
select cron.schedule(
  'renewly-refresh-rates',
  '15 16 * * *',
  $$
  select net.http_post(
    url := 'https://obyqyzgycivgituobdzm.supabase.co/functions/v1/refresh-exchange-rates',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select value from private.cron_secrets where name = 'edge_cron_secret')
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);

notify pgrst, 'reload schema';

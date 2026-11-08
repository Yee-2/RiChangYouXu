-- Keep administrator membership in a dedicated table. The profile role is only
-- a compatibility/display field and is no longer an authorization source.
create table if not exists public.admin_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique check (email = lower(email)),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

alter table public.admin_accounts enable row level security;
revoke all on table public.admin_accounts from public, anon, authenticated;
grant all on table public.admin_accounts to service_role;

insert into public.admin_accounts(user_id, email, created_by)
select p.id, lower(u.email), p.id
from public.profiles p
join auth.users u on u.id = p.id
where p.role = 'admin' and u.email is not null
on conflict (user_id) do update set email = excluded.email;

create or replace function public.sync_admin_account_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is distinct from old.email then
    update public.admin_accounts
    set email = lower(new.email)
    where user_id = new.id and new.email is not null;
  end if;
  return new;
end;
$$;

revoke all on function public.sync_admin_account_email() from public, anon, authenticated;

drop trigger if exists sync_admin_account_email on auth.users;
create trigger sync_admin_account_email
after update of email on auth.users
for each row execute function public.sync_admin_account_email();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_accounts aa
    join public.profiles p on p.id = aa.user_id
    where aa.user_id = (select auth.uid())
      and p.account_status = 'active'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated, service_role;

-- Admin-only account lookup; normal users are excluded once granted admin access.
create or replace function public.admin_find_account(p_actor_id uuid, p_lookup text)
returns table (
  id uuid,
  uid text,
  email text,
  username text,
  display_name text,
  avatar_path text,
  bio text,
  role text,
  account_status text,
  suspension_expires_at timestamptz,
  created_at timestamptz,
  email_confirmed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  lookup_value text := trim(coalesce(p_lookup, ''));
begin
  if not exists (
    select 1 from public.admin_accounts aa
    join public.profiles actor on actor.id = aa.user_id
    where aa.user_id = p_actor_id and actor.account_status = 'active'
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if lookup_value = '' then
    raise exception 'lookup_required' using errcode = '22023';
  end if;

  return query
  select p.id, p.uid, u.email::text, p.username, p.display_name, p.avatar_path, p.bio,
         p.role, p.account_status, p.suspension_expires_at, p.created_at, u.email_confirmed_at
  from public.profiles p
  join auth.users u on u.id = p.id
  where not exists (select 1 from public.admin_accounts aa where aa.user_id = p.id)
    and (upper(p.uid) = upper(lookup_value) or lower(u.email) = lower(lookup_value))
  limit 1;
end;
$$;

-- Maintain the legacy service-only listing RPC with the new source of truth.
create or replace function public.admin_list_profiles(
  p_actor_id uuid,
  p_role text,
  p_query text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  id uuid,
  uid text,
  email text,
  username text,
  display_name text,
  avatar_path text,
  bio text,
  role text,
  account_status text,
  suspension_expires_at timestamptz,
  created_at timestamptz,
  email_confirmed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_query text := nullif(trim(coalesce(p_query, '')), '');
begin
  if not exists (
    select 1 from public.admin_accounts aa
    join public.profiles actor on actor.id = aa.user_id
    where aa.user_id = p_actor_id and actor.account_status = 'active'
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_role not in ('user', 'admin') then
    raise exception 'invalid_role_filter' using errcode = '22023';
  end if;

  return query
  select p.id, p.uid, u.email::text, p.username, p.display_name, p.avatar_path, p.bio,
         p.role, p.account_status, p.suspension_expires_at, p.created_at, u.email_confirmed_at
  from public.profiles p
  join auth.users u on u.id = p.id
  where ((p_role = 'admin' and exists (select 1 from public.admin_accounts aa where aa.user_id = p.id))
      or (p_role = 'user' and not exists (select 1 from public.admin_accounts aa where aa.user_id = p.id)))
    and (normalized_query is null
      or strpos(lower(p.uid), lower(normalized_query)) > 0
      or strpos(lower(coalesce(u.email, '')), lower(normalized_query)) > 0)
  order by p.created_at desc, p.id desc
  limit greatest(1, least(coalesce(p_limit, 100), 100))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;

create or replace function public.admin_list_profiles_filtered(
  p_actor_id uuid,
  p_role text,
  p_query text default null,
  p_status_filter text default 'all',
  p_sort text default 'newest',
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  id uuid,
  uid text,
  email text,
  username text,
  display_name text,
  avatar_path text,
  bio text,
  role text,
  account_status text,
  suspension_expires_at timestamptz,
  created_at timestamptz,
  email_confirmed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_query text := nullif(trim(coalesce(p_query, '')), '');
  normalized_status text := lower(coalesce(p_status_filter, 'all'));
  normalized_sort text := lower(coalesce(p_sort, 'newest'));
begin
  if not exists (
    select 1 from public.admin_accounts aa
    join public.profiles actor on actor.id = aa.user_id
    where aa.user_id = p_actor_id and actor.account_status = 'active'
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_role not in ('user', 'admin') then
    raise exception 'invalid_role_filter' using errcode = '22023';
  end if;
  if normalized_status not in ('all', 'active', 'suspended', 'banned', 'deleted') then
    raise exception 'invalid_status_filter' using errcode = '22023';
  end if;
  if normalized_sort not in ('newest', 'oldest') then
    raise exception 'invalid_sort' using errcode = '22023';
  end if;

  return query
  select p.id, p.uid, u.email::text, p.username, p.display_name, p.avatar_path, p.bio,
         p.role, p.account_status, p.suspension_expires_at, p.created_at, u.email_confirmed_at
  from public.profiles p
  join auth.users u on u.id = p.id
  where ((p_role = 'admin' and exists (select 1 from public.admin_accounts aa where aa.user_id = p.id))
      or (p_role = 'user' and not exists (select 1 from public.admin_accounts aa where aa.user_id = p.id)))
    and (normalized_status = 'all' or p.account_status = normalized_status)
    and (normalized_query is null
      or strpos(lower(p.uid), lower(normalized_query)) > 0
      or strpos(lower(coalesce(u.email, '')), lower(normalized_query)) > 0)
  order by
    case when normalized_sort = 'oldest' then p.created_at end asc,
    case when normalized_sort = 'newest' then p.created_at end desc,
    p.id desc
  limit greatest(1, least(coalesce(p_limit, 100), 100))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;

create or replace function public.admin_change_role(
  p_actor_id uuid,
  p_target_id uuid,
  p_action text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_profile public.profiles%rowtype;
  target_email text;
  target_email_confirmed_at timestamptz;
  active_admin_count integer;
  next_role text;
begin
  perform pg_advisory_xact_lock(734702017);

  if not exists (
    select 1 from public.admin_accounts aa
    join public.profiles actor on actor.id = aa.user_id
    where aa.user_id = p_actor_id and actor.account_status = 'active'
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_action not in ('grant_admin', 'revoke_admin') then
    raise exception 'unsupported_action' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null or char_length(trim(p_reason)) > 500 then
    raise exception 'invalid_reason' using errcode = '22023';
  end if;

  select p.* into target_profile
  from public.profiles p where p.id = p_target_id for update;
  if not found then
    raise exception 'target_not_found' using errcode = 'P0002';
  end if;
  select u.email, u.email_confirmed_at into target_email, target_email_confirmed_at
  from auth.users u where u.id = p_target_id;

  if p_action = 'grant_admin' then
    if exists (select 1 from public.admin_accounts aa where aa.user_id = p_target_id) then
      raise exception 'already_admin' using errcode = '22023';
    end if;
    if target_profile.account_status <> 'active' or target_email_confirmed_at is null or target_email is null then
      raise exception 'target_not_eligible' using errcode = '22023';
    end if;
    insert into public.admin_accounts(user_id, email, created_by)
    values (p_target_id, lower(target_email), p_actor_id);
    next_role := 'admin';
  else
    if not exists (select 1 from public.admin_accounts aa where aa.user_id = p_target_id) then
      raise exception 'target_not_admin' using errcode = '22023';
    end if;
    select count(*) into active_admin_count
    from public.admin_accounts aa
    join public.profiles p on p.id = aa.user_id
    where p.account_status = 'active';
    if target_profile.account_status = 'active' and active_admin_count <= 1 then
      raise exception 'last_active_admin' using errcode = '22023';
    end if;
    delete from public.admin_accounts where user_id = p_target_id;
    next_role := 'user';
  end if;

  update public.profiles set role = next_role where id = p_target_id;
  insert into public.moderation_audit(actor_id, action, target_type, target_id, reason, metadata)
  values (p_actor_id, p_action, 'admin', p_target_id, trim(p_reason), jsonb_build_object('previous_role', target_profile.role, 'new_role', next_role));
end;
$$;

revoke all on function public.admin_find_account(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_list_profiles(uuid, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_list_profiles_filtered(uuid, text, text, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_change_role(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_find_account(uuid, text) to service_role;
grant execute on function public.admin_list_profiles(uuid, text, text, integer, integer) to service_role;
grant execute on function public.admin_list_profiles_filtered(uuid, text, text, text, text, integer, integer) to service_role;
grant execute on function public.admin_change_role(uuid, uuid, text, text) to service_role;

notify pgrst, 'reload schema';

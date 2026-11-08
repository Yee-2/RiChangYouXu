create or replace function public.generate_profile_uid()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  candidate text;
begin
  loop
    candidate := 'RY-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    if not exists (select 1 from public.profiles p where p.uid = candidate) then
      return candidate;
    end if;
  end loop;
end;
$$;

revoke all on function public.generate_profile_uid() from public, anon, authenticated;

alter table public.profiles add column if not exists uid text;

do $$
declare
  item record;
  generated_uid text;
begin
  for item in select p.id from public.profiles p where p.uid is null order by p.id loop
    generated_uid := public.generate_profile_uid();
    update public.profiles set uid = generated_uid where id = item.id;
  end loop;
end;
$$;

alter table public.profiles alter column uid set default public.generate_profile_uid();
alter table public.profiles alter column uid set not null;
create unique index if not exists profiles_uid_key on public.profiles(uid);

create or replace function public.prevent_profile_uid_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.uid is distinct from old.uid then
    raise exception 'profile_uid_is_immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_uid_immutable on public.profiles;
create trigger profiles_uid_immutable
before update of uid on public.profiles
for each row execute function public.prevent_profile_uid_change();

update public.profiles p
set display_name = '日常伙伴-' || right(p.uid, 6)
from auth.users u
where u.id = p.id
  and (
    p.display_name = '新朋友'
    or (u.email is not null and p.display_name = split_part(u.email, '@', 1))
  );

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
  values (new.id, generated_uid, '日常伙伴-' || right(generated_uid, 6))
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.admin_list_accounts(
  p_actor_id uuid,
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
    select 1 from public.profiles actor
    where actor.id = p_actor_id and actor.role = 'admin' and actor.account_status = 'active'
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select p.id, p.uid, u.email, p.username, p.display_name, p.avatar_path, p.bio,
         p.role, p.account_status, p.suspension_expires_at, p.created_at, u.email_confirmed_at
  from public.profiles p
  join auth.users u on u.id = p.id
  where normalized_query is null
     or p.uid ilike '%' || normalized_query || '%'
     or p.display_name ilike '%' || normalized_query || '%'
     or coalesce(u.email, '') ilike '%' || normalized_query || '%'
  order by p.created_at desc, p.id desc
  limit greatest(1, least(coalesce(p_limit, 100), 100))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;

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
    select 1 from public.profiles actor
    where actor.id = p_actor_id and actor.role = 'admin' and actor.account_status = 'active'
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if lookup_value = '' then
    raise exception 'lookup_required' using errcode = '22023';
  end if;

  return query
  select p.id, p.uid, u.email, p.username, p.display_name, p.avatar_path, p.bio,
         p.role, p.account_status, p.suspension_expires_at, p.created_at, u.email_confirmed_at
  from public.profiles p
  join auth.users u on u.id = p.id
  where upper(p.uid) = upper(lookup_value)
     or lower(u.email) = lower(lookup_value)
  limit 1;
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
  target_email_confirmed_at timestamptz;
  active_admin_count integer;
  next_role text;
begin
  perform pg_advisory_xact_lock(734702017);

  if not exists (
    select 1 from public.profiles actor
    where actor.id = p_actor_id and actor.role = 'admin' and actor.account_status = 'active'
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_action not in ('grant_admin', 'revoke_admin') then
    raise exception 'unsupported_action' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null or char_length(trim(p_reason)) > 500 then
    raise exception 'invalid_reason' using errcode = '22023';
  end if;

  select p.*
  into target_profile
  from public.profiles p
  where p.id = p_target_id
  for update;
  if not found then
    raise exception 'target_not_found' using errcode = 'P0002';
  end if;

  select u.email_confirmed_at
  into target_email_confirmed_at
  from auth.users u
  where u.id = p_target_id;

  if p_action = 'grant_admin' then
    if target_profile.role = 'admin' then
      raise exception 'already_admin' using errcode = '22023';
    end if;
    if target_profile.account_status <> 'active' or target_email_confirmed_at is null then
      raise exception 'target_not_eligible' using errcode = '22023';
    end if;
    next_role := 'admin';
  else
    if target_profile.role <> 'admin' then
      raise exception 'target_not_admin' using errcode = '22023';
    end if;
    if target_profile.account_status = 'active' then
      select count(*) into active_admin_count
      from public.profiles p
      where p.role = 'admin' and p.account_status = 'active';
      if active_admin_count <= 1 then
        raise exception 'last_active_admin' using errcode = '22023';
      end if;
    end if;
    next_role := 'user';
  end if;

  update public.profiles set role = next_role where id = p_target_id;
  insert into public.moderation_audit(actor_id, action, target_type, target_id, reason, metadata)
  values (p_actor_id, p_action, 'user', p_target_id, trim(p_reason), jsonb_build_object('previous_role', target_profile.role, 'new_role', next_role));
end;
$$;

revoke all on function public.admin_list_accounts(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_find_account(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_change_role(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_list_accounts(uuid, text, integer, integer) to service_role;
grant execute on function public.admin_find_account(uuid, text) to service_role;
grant execute on function public.admin_change_role(uuid, uuid, text, text) to service_role;

notify pgrst, 'reload schema';

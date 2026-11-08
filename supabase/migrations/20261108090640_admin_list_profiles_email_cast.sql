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
    select 1 from public.profiles actor
    where actor.id = p_actor_id and actor.role = 'admin' and actor.account_status = 'active'
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
  where p.role = p_role
    and (
      normalized_query is null
      or strpos(lower(p.uid), lower(normalized_query)) > 0
      or strpos(lower(coalesce(u.email, '')), lower(normalized_query)) > 0
    )
  order by p.created_at desc, p.id desc
  limit greatest(1, least(coalesce(p_limit, 100), 100))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;

revoke all on function public.admin_list_profiles(uuid, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_list_profiles(uuid, text, text, integer, integer) to service_role;

notify pgrst, 'reload schema';

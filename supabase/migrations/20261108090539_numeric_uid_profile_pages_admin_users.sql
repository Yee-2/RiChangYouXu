-- Replace public UIDs with database-allocated numeric identifiers.
create sequence if not exists public.profile_uid_seq
  as bigint
  start with 1000000000
  increment by 1
  minvalue 1000000000;

revoke all on sequence public.profile_uid_seq from public, anon, authenticated;

create or replace function public.generate_profile_uid()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return nextval('public.profile_uid_seq'::regclass)::text;
end;
$$;

revoke all on function public.generate_profile_uid() from public, anon, authenticated;

lock table public.profiles in access exclusive mode;
drop trigger if exists profiles_uid_immutable on public.profiles;
select setval('public.profile_uid_seq'::regclass, 1000000000, false);

do $$
declare
  profile_id uuid;
begin
  for profile_id in
    select p.id from public.profiles p order by p.created_at, p.id
  loop
    update public.profiles p
    set uid = public.generate_profile_uid()
    where p.id = profile_id;
  end loop;
end;
$$;

alter table public.profiles
  alter column uid set default public.generate_profile_uid();

alter table public.profiles
  drop constraint if exists profiles_uid_numeric;
alter table public.profiles
  add constraint profiles_uid_numeric check (uid ~ '^[0-9]+$');

create trigger profiles_uid_immutable
before update of uid on public.profiles
for each row execute function public.prevent_profile_uid_change();

-- Admin-only, role-filtered account search. Email never goes through public profile queries.
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

-- Update a visible post and its topic links atomically, with ownership checked in the database.
create or replace function public.update_own_post(p_post_id uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  normalized_body text := trim(coalesce(p_body, ''));
  existing_images text[];
  topic_match text[];
  topic_title text;
  topic_slug text;
  topic_id uuid;
begin
  if actor_id is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if char_length(normalized_body) > 5000 then
    raise exception 'post_body_limit' using errcode = '22023';
  end if;

  select p.image_paths into existing_images
  from public.posts p
  where p.id = p_post_id
    and p.author_id = actor_id
    and p.moderation_status = 'visible'
  for update;
  if not found then
    raise exception 'post_not_editable' using errcode = '42501';
  end if;
  if normalized_body = '' and cardinality(existing_images) = 0 then
    raise exception 'post_has_content' using errcode = '22023';
  end if;

  update public.posts set body = normalized_body, updated_at = now() where id = p_post_id;
  delete from public.post_topics where post_id = p_post_id;

  for topic_match in
    select regexp_matches(normalized_body, '#([[:alnum:]_-]{1,30})', 'g')
  loop
    topic_title := topic_match[1];
    topic_slug := lower(topic_title);
    topic_id := null;

    select t.id into topic_id
    from public.topics t
    where lower(t.slug) = topic_slug or lower(t.title) = topic_slug
    limit 1;

    if topic_id is null then
      insert into public.topics(slug, title, created_by)
      values (topic_slug, topic_title, actor_id)
      on conflict do nothing;

      select t.id into topic_id
      from public.topics t
      where lower(t.slug) = topic_slug or lower(t.title) = topic_slug
      limit 1;
    end if;

    if topic_id is not null then
      insert into public.post_topics(post_id, topic_id)
      values (p_post_id, topic_id)
      on conflict do nothing;
    end if;
  end loop;
end;
$$;

revoke all on function public.update_own_post(uuid, text) from public, anon;
grant execute on function public.update_own_post(uuid, text) to authenticated;

notify pgrst, 'reload schema';

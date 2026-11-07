create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  display_name text not null default '新朋友',
  avatar_path text,
  bio text not null default '',
  role text not null default 'user' check (role in ('user','admin')),
  account_status text not null default 'active' check (account_status in ('active','suspended','deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.topics (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null unique,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

insert into public.topics(slug, title) values
  ('宠物日记','宠物日记'), ('生活碎片','生活碎片'), ('今日好心情','今日好心情'), ('养宠新手','养宠新手'), ('居家日常','居家日常')
on conflict (slug) do nothing;

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null default '',
  image_paths text[] not null default '{}',
  moderation_status text not null default 'visible' check (moderation_status in ('visible','hidden','removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint post_has_content check (length(trim(body)) > 0 or cardinality(image_paths) > 0),
  constraint post_body_limit check (char_length(body) <= 5000),
  constraint post_image_limit check (cardinality(image_paths) <= 9)
);

create table if not exists public.post_topics (
  post_id uuid not null references public.posts(id) on delete cascade,
  topic_id uuid not null references public.topics(id) on delete cascade,
  primary key (post_id, topic_id)
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null default '',
  image_paths text[] not null default '{}',
  moderation_status text not null default 'visible' check (moderation_status in ('visible','hidden','removed')),
  created_at timestamptz not null default now(),
  constraint comment_has_content check (length(trim(body)) > 0 or cardinality(image_paths) > 0),
  constraint comment_body_limit check (char_length(body) <= 2000),
  constraint comment_image_limit check (cardinality(image_paths) <= 4)
);

create table if not exists public.post_likes (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  followee_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id),
  constraint no_self_follow check (follower_id <> followee_id)
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  target_type text not null check (target_type in ('post','comment','user')),
  target_id uuid not null,
  reason text not null,
  detail text not null default '',
  status text not null default 'open' check (status in ('open','handled','dismissed')),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint report_reason_limit check (char_length(reason) <= 120),
  constraint report_detail_limit check (char_length(detail) <= 1000)
);

create table if not exists public.moderation_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  action text not null,
  target_type text not null,
  target_id uuid not null,
  reason text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists posts_created_at_idx on public.posts(created_at desc) where moderation_status = 'visible';
create index if not exists posts_author_idx on public.posts(author_id, created_at desc);
create index if not exists comments_post_idx on public.comments(post_id, created_at asc) where moderation_status = 'visible';
create index if not exists reports_queue_idx on public.reports(status, created_at asc);
create index if not exists follows_followee_idx on public.follows(followee_id);

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.profiles where id = (select auth.uid()) and role = 'admin' and account_status = 'active') $$;

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.profiles where id = (select auth.uid()) and account_status = 'active') $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles(id, display_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data ->> 'display_name',''), split_part(new.email,'@',1), '新朋友'))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = public
as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at before update on public.profiles for each row execute procedure public.touch_updated_at();
drop trigger if exists posts_touch_updated_at on public.posts;
create trigger posts_touch_updated_at before update on public.posts for each row execute procedure public.touch_updated_at();

alter table public.profiles enable row level security;
alter table public.topics enable row level security;
alter table public.posts enable row level security;
alter table public.post_topics enable row level security;
alter table public.comments enable row level security;
alter table public.post_likes enable row level security;
alter table public.follows enable row level security;
alter table public.reports enable row level security;
alter table public.moderation_audit enable row level security;

create policy "profiles are publicly readable" on public.profiles for select using (account_status <> 'deleted' or public.is_admin());
create policy "active user may update own profile" on public.profiles for update using (id = (select auth.uid()) and public.is_active_user()) with check (id = (select auth.uid()) and account_status = 'active');
grant select on public.profiles to anon, authenticated;
grant update (username, display_name, avatar_path, bio) on public.profiles to authenticated;

create policy "topics are readable" on public.topics for select using (true);
create policy "active user may create topic" on public.topics for insert with check (public.is_active_user() and (created_by = (select auth.uid()) or created_by is null));
grant select on public.topics to anon, authenticated;
grant insert (slug, title, created_by) on public.topics to authenticated;

create policy "visible posts are readable" on public.posts for select using (moderation_status = 'visible' or author_id = (select auth.uid()) or public.is_admin());
create policy "active user may create own post" on public.posts for insert with check (author_id = (select auth.uid()) and public.is_active_user());
create policy "author may edit own visible post" on public.posts for update using (author_id = (select auth.uid()) and moderation_status = 'visible' and public.is_active_user()) with check (author_id = (select auth.uid()) and moderation_status = 'visible');
create policy "author or admin may delete post" on public.posts for delete using (author_id = (select auth.uid()) or public.is_admin());
grant select on public.posts to anon, authenticated;
grant insert (author_id, body, image_paths) on public.posts to authenticated;
grant update (body, image_paths) on public.posts to authenticated;
grant delete on public.posts to authenticated;

create policy "post tags are readable" on public.post_topics for select using (exists(select 1 from public.posts p where p.id = post_id and (p.moderation_status = 'visible' or p.author_id = (select auth.uid()) or public.is_admin())));
create policy "author may tag own post" on public.post_topics for insert with check (exists(select 1 from public.posts p where p.id = post_id and p.author_id = (select auth.uid()) and public.is_active_user()));
create policy "author may remove own post tag" on public.post_topics for delete using (exists(select 1 from public.posts p where p.id = post_id and p.author_id = (select auth.uid())) or public.is_admin());
grant select on public.post_topics to anon, authenticated;
grant insert, delete on public.post_topics to authenticated;

create policy "visible comments are readable" on public.comments for select using (moderation_status = 'visible' or author_id = (select auth.uid()) or public.is_admin());
create policy "active user may comment" on public.comments for insert with check (author_id = (select auth.uid()) and public.is_active_user() and exists(select 1 from public.posts p where p.id = post_id and p.moderation_status = 'visible'));
create policy "author may edit own visible comment" on public.comments for update using (author_id = (select auth.uid()) and moderation_status = 'visible' and public.is_active_user()) with check (author_id = (select auth.uid()) and moderation_status = 'visible');
create policy "author or admin may delete comment" on public.comments for delete using (author_id = (select auth.uid()) or public.is_admin());
grant select on public.comments to anon, authenticated;
grant insert (post_id, author_id, body, image_paths) on public.comments to authenticated;
grant update (body, image_paths) on public.comments to authenticated;
grant delete on public.comments to authenticated;

create policy "likes are readable" on public.post_likes for select using (true);
create policy "active user may like" on public.post_likes for insert with check (user_id = (select auth.uid()) and public.is_active_user());
create policy "user may unlike own like" on public.post_likes for delete using (user_id = (select auth.uid()));
grant select on public.post_likes to anon, authenticated;
grant insert (post_id, user_id) on public.post_likes to authenticated;
grant delete on public.post_likes to authenticated;

create policy "follow relationships are readable" on public.follows for select using (true);
create policy "active user may follow" on public.follows for insert with check (follower_id = (select auth.uid()) and public.is_active_user());
create policy "user may unfollow" on public.follows for delete using (follower_id = (select auth.uid()));
grant select on public.follows to anon, authenticated;
grant insert (follower_id, followee_id) on public.follows to authenticated;
grant delete on public.follows to authenticated;

create policy "reporter reads own reports; admins read all" on public.reports for select using (reporter_id = (select auth.uid()) or public.is_admin());
create policy "active user may report" on public.reports for insert with check (reporter_id = (select auth.uid()) and public.is_active_user());
grant select on public.reports to authenticated;
grant insert (reporter_id, target_type, target_id, reason, detail) on public.reports to authenticated;

create policy "admins read moderation audit" on public.moderation_audit for select using (public.is_admin());
grant select on public.moderation_audit to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('community-media', 'community-media', false, 5242880, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set public = false, file_size_limit = 5242880, allowed_mime_types = excluded.allowed_mime_types;

create policy "users upload to own folder" on storage.objects for insert to authenticated with check (bucket_id = 'community-media' and (storage.foldername(name))[1] = (select auth.uid())::text and public.is_active_user());
create policy "users update own media" on storage.objects for update to authenticated using (bucket_id = 'community-media' and (storage.foldername(name))[1] = (select auth.uid())::text) with check (bucket_id = 'community-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "owners or visible post readers can access media" on storage.objects for select to anon, authenticated using (
  bucket_id = 'community-media' and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or exists(select 1 from public.posts p where p.moderation_status = 'visible' and name = any(p.image_paths))
    or exists(select 1 from public.comments c where c.moderation_status = 'visible' and name = any(c.image_paths))
  )
);
create policy "owners delete own media" on storage.objects for delete to authenticated using (bucket_id = 'community-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

alter table public.profiles
  add column if not exists suspension_expires_at timestamptz;

alter table public.profiles
  drop constraint if exists profiles_account_status_check;
alter table public.profiles
  add constraint profiles_account_status_check
  check (account_status in ('active', 'suspended', 'banned', 'deleted'));

create or replace function public.is_active_user()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and (
        account_status = 'active'
        or (account_status = 'suspended' and suspension_expires_at is not null and suspension_expires_at <= now())
      )
  )
$$;

drop policy if exists "active user may update own profile" on public.profiles;
create policy "active user may update own profile" on public.profiles
for update
using (id = (select auth.uid()) and public.is_active_user())
with check (
  id = (select auth.uid())
  and (account_status = 'active' or (account_status = 'suspended' and suspension_expires_at <= now()))
);

drop policy if exists "author or admin may delete post" on public.posts;
create policy "active author or admin may delete post" on public.posts
for delete using ((author_id = (select auth.uid()) and public.is_active_user()) or public.is_admin());

drop policy if exists "author may remove own post tag" on public.post_topics;
create policy "active author may remove own post tag" on public.post_topics
for delete using (
  (exists(select 1 from public.posts p where p.id = post_id and p.author_id = (select auth.uid())) and public.is_active_user())
  or public.is_admin()
);

drop policy if exists "author or admin may delete comment" on public.comments;
create policy "active author or admin may delete comment" on public.comments
for delete using ((author_id = (select auth.uid()) and public.is_active_user()) or public.is_admin());

drop policy if exists "user may unlike own like" on public.post_likes;
create policy "active user may unlike own like" on public.post_likes
for delete using (user_id = (select auth.uid()) and public.is_active_user());

drop policy if exists "user may unfollow" on public.follows;
create policy "active user may unfollow" on public.follows
for delete using (follower_id = (select auth.uid()) and public.is_active_user());

drop policy if exists "users update own media" on storage.objects;
create policy "active users update own media" on storage.objects
for update to authenticated
using (bucket_id = 'community-media' and (storage.foldername(name))[1] = (select auth.uid())::text and public.is_active_user())
with check (bucket_id = 'community-media' and (storage.foldername(name))[1] = (select auth.uid())::text and public.is_active_user());

drop policy if exists "owners delete own media" on storage.objects;
create policy "active owners delete own media" on storage.objects
for delete to authenticated
using (bucket_id = 'community-media' and (storage.foldername(name))[1] = (select auth.uid())::text and public.is_active_user());

drop policy if exists "active admins can inspect community media" on storage.objects;
create policy "active admins can inspect community media" on storage.objects
for select to authenticated
using (bucket_id = 'community-media' and public.is_admin());

drop policy if exists "visible comments are readable" on public.comments;
create policy "visible comments under visible posts are readable" on public.comments
for select using (
  author_id = (select auth.uid())
  or public.is_admin()
  or (
    moderation_status = 'visible'
    and exists(select 1 from public.posts p where p.id = post_id and p.moderation_status = 'visible')
  )
);

drop policy if exists "owners or visible post readers can access media" on storage.objects;
create policy "owners or visible community readers can access media" on storage.objects
for select to anon, authenticated
using (
  bucket_id = 'community-media' and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or exists(select 1 from public.posts p where p.moderation_status = 'visible' and name = any(p.image_paths))
    or exists(
      select 1 from public.comments c
      join public.posts p on p.id = c.post_id
      where c.moderation_status = 'visible'
        and p.moderation_status = 'visible'
        and name = any(c.image_paths)
    )
    or (select public.is_admin())
  )
);

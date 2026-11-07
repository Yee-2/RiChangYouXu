-- Allow reading the current avatar of a public, non-deleted profile.
-- Avatar objects remain private and are served with short-lived signed URLs.
create policy "read active profile avatars" on storage.objects
for select to anon, authenticated
using (
  bucket_id = 'community-media'
  and exists (
    select 1 from public.profiles p
    where p.account_status <> 'deleted'
      and p.avatar_path = name
  )
);

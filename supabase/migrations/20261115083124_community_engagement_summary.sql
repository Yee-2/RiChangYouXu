create or replace function public.get_post_engagement(p_post_ids uuid[])
returns table (
  post_id uuid,
  like_count bigint,
  viewer_liked boolean,
  comment_count bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if coalesce(cardinality(p_post_ids), 0) > 20 then
    raise exception 'too_many_post_ids' using errcode = '22023';
  end if;

  return query
  select requested.post_id,
         coalesce(likes.like_count, 0),
         coalesce(likes.viewer_liked, false),
         coalesce(comments.comment_count, 0)
  from (
    select distinct input.post_id
    from unnest(coalesce(p_post_ids, array[]::uuid[])) as input(post_id)
    where input.post_id is not null
  ) as requested
  left join lateral (
    select count(*)::bigint as like_count,
           coalesce(bool_or(like_row.user_id = (select auth.uid())), false) as viewer_liked
    from public.post_likes as like_row
    where like_row.post_id = requested.post_id
  ) as likes on true
  left join lateral (
    select count(*)::bigint as comment_count
    from public.comments as comment_row
    where comment_row.post_id = requested.post_id
  ) as comments on true
  order by requested.post_id;
end;
$$;

revoke all on function public.get_post_engagement(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.get_post_engagement(uuid[])
  to anon, authenticated;

notify pgrst, 'reload schema';

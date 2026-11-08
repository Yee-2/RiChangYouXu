create table if not exists public.user_auth_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  password_set boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.user_auth_settings enable row level security;
revoke all on table public.user_auth_settings from public, anon, authenticated;
grant select on table public.user_auth_settings to authenticated;
drop policy if exists "users can read own auth settings" on public.user_auth_settings;
create policy "users can read own auth settings"
  on public.user_auth_settings
  for select to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.generate_random_profile_name()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  names text[] := array[
    '松弛小岛', '晚风柚子', '薄荷日记', '晴天汽水', '月亮面包',
    '自在橘子', '温柔海盐', '好奇松果', '闪亮云朵', '清醒桃子',
    '慢热星河', '元气小熊', '安静森林', '热烈麦田', '轻盈兔子',
    '慵懒橙子', '勇敢山丘', '软糖星星', '机灵小猫', '暖阳岛屿',
    '微甜汽水', '清风蒲公英', '快乐鱼丸', '可爱树洞', '浪漫月光',
    '认真生活家', '散步的云', '有趣柠檬', '温暖鲸鱼', '自由野莓',
    '明亮小狗', '困困云朵', '晴朗橘猫', '奶油泡芙', '海边旅人',
    '四季有风', '落日收藏家', '春日信使', '银河漫游者', '清甜桃桃',
    '不急慢慢来', '小小探险家', '柔软星球', '清晨面包', '可乐加冰',
    '云端漫步', '温柔收集者', '岛上居民', '认真发呆', '橘子海'
  ];
begin
  return names[(floor(random() * cardinality(names))::integer) + 1];
end;
$$;

revoke all on function public.generate_random_profile_name() from public, anon, authenticated;

update public.profiles p
set display_name = public.generate_random_profile_name()
where p.display_name = '新朋友'
   or p.display_name = '日常伙伴-' || right(p.uid, 6);

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
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

insert into public.user_auth_settings(user_id, password_set)
select u.id, coalesce(u.encrypted_password, '') <> ''
from auth.users u
on conflict (user_id) do update
  set password_set = excluded.password_set,
      updated_at = now();

create or replace function public.sync_user_password_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_auth_settings(user_id, password_set)
  values (new.id, coalesce(new.encrypted_password, '') <> '')
  on conflict (user_id) do update
    set password_set = excluded.password_set,
        updated_at = now();
  return new;
end;
$$;

revoke all on function public.sync_user_password_status() from public, anon, authenticated;
drop trigger if exists auth_user_password_status_updated on auth.users;
create trigger auth_user_password_status_updated
  after update of encrypted_password on auth.users
  for each row
  when (old.encrypted_password is distinct from new.encrypted_password)
  execute function public.sync_user_password_status();

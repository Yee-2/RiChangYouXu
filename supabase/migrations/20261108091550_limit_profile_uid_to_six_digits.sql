-- Keep public profile UIDs numeric, unique, and exactly six digits long.
lock table public.profiles in access exclusive mode;

do $$
begin
  if (select count(*) from public.profiles) > 900000 then
    raise exception 'profile_uid_capacity_exceeded';
  end if;
end;
$$;

drop trigger if exists profiles_uid_immutable on public.profiles;
alter table public.profiles drop constraint if exists profiles_uid_numeric;
alter table public.profiles drop constraint if exists profiles_uid_six_digits;

-- Move every existing value out of the six-digit range before reallocating,
-- so this also works if some accounts already have six-digit UIDs.
update public.profiles
set uid = 'migration-' || id::text;

alter sequence public.profile_uid_seq
  start with 100000
  minvalue 100000
  maxvalue 999999
  restart with 100000
  no cycle;

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
  add constraint profiles_uid_six_digits check (uid ~ '^[0-9]{6}$');

create unique index if not exists profiles_uid_key on public.profiles(uid);

create trigger profiles_uid_immutable
before update of uid on public.profiles
for each row execute function public.prevent_profile_uid_change();

notify pgrst, 'reload schema';

-- This pre-filtering RPC was replaced by admin_list_profiles_filtered. It is
-- no longer called and its legacy email return type is incompatible with
-- auth.users.email varchar(255).
drop function if exists public.admin_list_accounts(uuid, text, integer, integer);

-- Old generated names used six hexadecimal characters, not the current six
-- digit public UID. Match only that exact template so custom names survive.
update public.profiles p
set display_name = public.generate_random_profile_name()
where p.display_name = '新朋友'
   or p.display_name ~ '^日常伙伴-[0-9A-Fa-f]{6}$';

notify pgrst, 'reload schema';

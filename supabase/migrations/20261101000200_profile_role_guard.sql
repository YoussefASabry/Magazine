-- Prevent authenticated users from granting themselves a higher profile role.
-- Service-role requests (setup/migrations) and existing admins may change roles.

create or replace function public.protect_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role
     and coalesce(auth.jwt()->>'role', '') <> 'service_role'
     and not public.is_admin() then
    raise exception 'Only admins can change profile roles'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_protect_role on public.profiles;
create trigger profiles_protect_role
before update on public.profiles
for each row execute function public.protect_profile_role();

begin;
revoke all on function private.require_permission(uuid,public.permission_kind) from public,anon,authenticated;
create or replace function public.bootstrap_admin(target uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from auth.users a join public.profiles p on p.id=a.id
 where a.id=target and a.email is not null and a.email_confirmed_at is not null and p.status='active' and
 (a.raw_app_meta_data->>'provider'='google' or a.raw_app_meta_data->'providers' ? 'google')) then
  raise exception using errcode='22023',message='Confirmed active Google identity required';
 end if;
 insert into private.bootstrap_owner(user_id) values(target);
 insert into public.user_permissions(user_id,permission) values(target,'admin') on conflict do nothing;
 insert into public.audit_logs(actor_id,action,entity_id) values(target,'bootstrap_admin',target);
end $$;
commit;

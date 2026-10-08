begin;
-- getUser verifies the JWT; this rejects retained tokens after session revocation.
create function public.app_session_active(actor uuid,target_session uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.sessions where id=target_session and user_id=actor and (not_after is null or not_after>now()));
$$;
revoke all on function public.app_session_active(uuid,uuid) from public,anon,authenticated;
grant execute on function public.app_session_active(uuid,uuid) to service_role;
commit;

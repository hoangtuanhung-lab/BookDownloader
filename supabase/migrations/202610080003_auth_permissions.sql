begin;
-- One-shot default reader, never repair grants on every login (revocation must persist).
create function private.new_auth_user() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into public.profiles(id,display_name) values(new.id,left(coalesce(new.raw_user_meta_data->>'full_name',''),120));
 insert into public.user_permissions(user_id,permission) values(new.id,'read');
 return new;
end $$;
revoke all on function private.new_auth_user() from public;
create trigger book_auth_user_created after insert on auth.users for each row execute function private.new_auth_user();
-- Backfill existing identities once; no admin inferred from sign-up order.
insert into public.profiles(id,display_name) select id,left(coalesce(raw_user_meta_data->>'full_name',''),120) from auth.users on conflict(id) do nothing;
insert into public.user_permissions(user_id,permission) select id,'read' from public.profiles on conflict do nothing;
create table private.bootstrap_owner(user_id uuid primary key references auth.users(id),constraint one_owner check (true));
create unique index bootstrap_one_owner on private.bootstrap_owner((true));
-- Callable only by the owner through a server CLI. UUID supplied by owner configuration.
create function public.bootstrap_admin(target uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from auth.users where id=target and email is not null and
 (raw_app_meta_data->>'provider'='google' or raw_app_meta_data->'providers' ? 'google')) then
  raise exception using errcode='22023',message='Confirmed Google identity required';
 end if;
 insert into private.bootstrap_owner(user_id) values(target);
 insert into public.user_permissions(user_id,permission) values(target,'admin') on conflict do nothing;
 insert into public.audit_logs(actor_id,action,entity_id) values(target,'bootstrap_admin',target);
end $$;
create function private.require_permission(actor uuid,needed public.permission_kind) returns void
language plpgsql set search_path='' as $$
begin
 -- Transaction lock makes concurrent permission mutations/read checks serialize.
 perform pg_advisory_xact_lock(hashtextextended('book-authz',0));
 if not exists(select 1 from public.profiles p join public.user_permissions u on u.user_id=p.id
 where p.id=actor and p.status='active' and (u.permission=needed or u.permission='admin')) then
  raise exception using errcode='42501',message='Permission denied';
 end if;
end $$;
create function public.app_me(actor uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not exists(select 1 from public.profiles where id=actor and status='active') then
  raise exception using errcode='42501',message='Account blocked or missing';
 end if;
 select jsonb_build_object('id',p.id,'name',p.display_name,'permissions',coalesce((select jsonb_agg(u.permission order by u.permission) from public.user_permissions u where u.user_id=p.id),'[]'::jsonb)) into result from public.profiles p where p.id=actor;
 return result;
end $$;
create function public.app_admin_users(actor uuid,after_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.require_permission(actor,'admin');
 select coalesce(jsonb_agg(row_to_json(page)),'[]'::jsonb) into result from (
 select p.id,p.display_name as name,a.email,p.status,
 coalesce((select jsonb_agg(u.permission order by u.permission) from public.user_permissions u where u.user_id=p.id),'[]'::jsonb) as permissions
 from public.profiles p join auth.users a on a.id=p.id where after_id is null or p.id>after_id order by p.id limit 50) page;
 return result;
end $$;
create function public.app_admin_update(actor uuid,target uuid,permissions public.permission_kind[],account_status text) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform private.require_permission(actor,'admin');
 if account_status not in ('active','blocked') or permissions is null then raise exception using errcode='22023',message='Invalid account update'; end if;
 if not exists(select 1 from public.profiles where id=target) then raise exception using errcode='P0002',message='User missing'; end if;
 -- Never remove/block the last active admin, including concurrent requests.
 if (account_status='blocked' or not 'admin'=any(permissions)) and exists(select 1 from public.user_permissions where user_id=target and permission='admin') and
 not exists(select 1 from public.profiles p join public.user_permissions u on u.user_id=p.id where p.id<>target and p.status='active' and u.permission='admin') then
 raise exception using errcode='23514',message='Last admin must remain active'; end if;
 update public.profiles set status=account_status where id=target;
 delete from public.user_permissions where user_id=target;
 insert into public.user_permissions(user_id,permission) select target,v from (select distinct unnest(permissions) v) values_set;
 insert into public.audit_logs(actor_id,action,entity_id,details) values(actor,'account_permissions',target,jsonb_build_object('permissions',permissions,'status',account_status));
end $$;
create function public.app_preferences(actor uuid,new_value jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.require_permission(actor,'read');
 if new_value is not null then
 insert into public.reader_preferences(user_id,font,font_size,theme,blue_filter,mode) values(actor,new_value->>'font',(new_value->>'fontSize')::integer,new_value->>'theme',(new_value->>'blueFilter')::numeric,new_value->>'mode')
 on conflict(user_id) do update set font=excluded.font,font_size=excluded.font_size,theme=excluded.theme,blue_filter=excluded.blue_filter,mode=excluded.mode;
 end if;
 select jsonb_build_object('font',font,'fontSize',font_size,'theme',theme,'blueFilter',blue_filter,'mode',mode) into result from public.reader_preferences where user_id=actor;
 return result;
end $$;
create function public.app_progress(actor uuid,target_book uuid,new_value jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;current_revision bigint;
begin
 perform private.require_permission(actor,'read');
 if not exists(select 1 from public.books where id=target_book and deleted_at is null and
 (visibility='published' or exists(select 1 from public.user_permissions where user_id=actor and permission in ('manage','admin')))) then raise exception using errcode='P0002',message='Book missing';end if;
 if new_value is not null then
  if not exists(select 1 from public.chapters where id=(new_value->>'chapterId')::uuid and book_id=target_book and status='DONE' and not is_skipped) then raise exception using errcode='P0002',message='Chapter missing';end if;
  select revision into current_revision from public.reading_progress where user_id=actor and book_id=target_book for update;
  if coalesce(current_revision,0) <> (new_value->>'expectedRevision')::bigint then raise exception using errcode='40001',message='Progress conflict';end if;
  insert into public.reading_progress(user_id,book_id,chapter_id,ratio,scroll_position,revision,updated_at) values(actor,target_book,(new_value->>'chapterId')::uuid,(new_value->>'ratio')::numeric,(new_value->>'scrollPosition')::numeric,1,now())
  on conflict(user_id,book_id) do update set chapter_id=excluded.chapter_id,ratio=excluded.ratio,scroll_position=excluded.scroll_position,revision=public.reading_progress.revision+1,updated_at=now();
 end if;
 select jsonb_build_object('chapterId',chapter_id,'ratio',ratio,'scrollPosition',scroll_position,'revision',revision,'updatedAt',updated_at) into result from public.reading_progress where user_id=actor and book_id=target_book;
 return result;
end $$;
-- Browser cannot bypass revision, timestamp or API permission checks on writes.
revoke insert,update,delete on public.reading_progress,public.reader_preferences from authenticated;
-- Explicit service-only RPC grants; authenticated cannot spoof actor UUID.
revoke all on function public.bootstrap_admin(uuid),public.app_me(uuid),public.app_admin_users(uuid,uuid),public.app_admin_update(uuid,uuid,public.permission_kind[],text),public.app_preferences(uuid,jsonb),public.app_progress(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.bootstrap_admin(uuid),public.app_me(uuid),public.app_admin_users(uuid,uuid),public.app_admin_update(uuid,uuid,public.permission_kind[],text),public.app_preferences(uuid,jsonb),public.app_progress(uuid,uuid,jsonb) to service_role;
commit;

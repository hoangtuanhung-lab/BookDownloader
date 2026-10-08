begin;
create table private.runtime_control (
 singleton boolean primary key default true check(singleton),
 maintenance boolean not null default false,
 root_id text, revision bigint not null default 1,
 updated_at timestamptz not null default now()
);
insert into private.runtime_control(singleton) values(true);
create table private.operation_transactions(txid xid8 primary key);
revoke all on private.operation_transactions from public,anon,authenticated,service_role;
create table private.root_requests (
 id uuid primary key, actor_id uuid not null references public.profiles(id),
 request jsonb not null, status text not null check(status in ('pending','done','uncertain')),
 root_id text, created_at timestamptz not null default now()
);
create table private.operation_events (
 id bigint generated always as identity primary key,actor_id uuid references public.profiles(id),
 action text not null,details jsonb not null default '{}',created_at timestamptz not null default now()
);
revoke all on private.runtime_control,private.root_requests,private.operation_events from public,anon,authenticated,service_role;
create function private.require_writable() returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock_shared(610090001);
 if (select maintenance from private.runtime_control where singleton) and not exists(select 1 from private.operation_transactions where txid=pg_current_xact_id()) then
  raise exception using errcode='55000',message='Maintenance enabled';
 end if;
 if tg_op='DELETE' then return old;else return new;end if;
end $$;
revoke all on function private.require_writable() from public,anon,authenticated,service_role;
-- Mutations are fenced in SQL as well as worker admission. Auth identity remains managed by Supabase.
do $$ declare t text; begin
 foreach t in array array['books','chapters','chapter_groups','genres','book_genres','jobs','job_items','outbox_operations','reading_progress','reader_preferences','app_settings','site_rules','site_credentials','user_permissions'] loop
  execute format('create trigger operations_write_gate before insert or update or delete on public.%I for each statement execute function private.require_writable()',t);
 end loop;
 foreach t in array array['uploads','upload_chunks','cover_assets'] loop
  execute format('create trigger operations_write_gate before insert or update or delete on private.%I for each statement execute function private.require_writable()',t);
 end loop;
end $$;
-- Statement triggers must return NULL; the function's OLD/NEW result is ignored.
create function public.app_runtime_root(actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.profiles p join public.user_permissions u on u.user_id=p.id where p.id=actor and p.status='active') then
  raise exception using errcode='42501',message='Account denied';
 end if;
 return (select jsonb_build_object('rootId',root_id,'revision',revision) from private.runtime_control where singleton);
end $$;
create function public.app_operations(actor uuid,operation text,input jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare control private.runtime_control;r private.root_requests;result jsonb;
begin
 perform private.require_permission(actor,'admin');
 if operation='status' then
  return (select jsonb_build_object('maintenance',maintenance,'rootId',root_id,'revision',revision,
   'alerts',jsonb_build_object(
    'expiredLeases',(select count(*) from public.jobs where status='running' and lease_until<now()),
    'stuckJobs',(select count(*) from public.jobs where status in ('running','queued') and created_at<now()-interval '24 hours'),
    'failedJobs',(select count(*) from public.jobs where status='failed'),
    'failedSync',(select count(*) from public.outbox_operations where status='failed'),
    'migrationReview',(select count(*) from private.legacy_book_review r join public.books b on b.id=r.book_id where r.reviewed_at is null and b.deleted_at is null)))
   from private.runtime_control where singleton);
 end if;
 if not pg_try_advisory_xact_lock(610090001) then raise exception using errcode='40001',message='Writer still active';end if;
 select * into control from private.runtime_control where singleton for update;
 if operation='maintenance' then
  if jsonb_typeof(input->'enabled') is distinct from 'boolean' then raise exception using errcode='22023',message='Boolean required';end if;
  update private.runtime_control set maintenance=(input->>'enabled')::boolean,revision=revision+1,updated_at=now() where singleton;
 elsif operation='root-prepare' then
  if not control.maintenance then raise exception using errcode='55000',message='Maintenance required';end if;
  if (input->>'revision')::bigint is distinct from control.revision then raise exception using errcode='40001',message='Revision changed';end if;
  select * into r from private.root_requests where id=(input->>'requestId')::uuid;
  if found then
   if r.actor_id<>actor or r.request is distinct from input-'revision' then raise exception using errcode='40001',message='Request conflict';end if;
   if r.status='done' then return jsonb_build_object('repeated',true,'rootId',r.root_id);end if;
   raise exception using errcode='55000',message='Root request needs reconciliation';
  end if;
  insert into private.root_requests(id,actor_id,request,status) values((input->>'requestId')::uuid,actor,input-'revision','pending');
  return jsonb_build_object('repeated',false,'revision',control.revision);
 elsif operation='root-uncertain' then
  update private.root_requests set status='uncertain' where id=(input->>'requestId')::uuid and actor_id=actor and status='pending';
 elsif operation='root-finish' then
  if not control.maintenance then raise exception using errcode='55000',message='Maintenance required';end if;
  if (input->>'revision')::bigint is distinct from control.revision then raise exception using errcode='40001',message='Revision changed';end if;
  select * into r from private.root_requests where id=(input->>'requestId')::uuid and actor_id=actor and status='pending' for update;
  if not found or coalesce(input->>'rootId','') !~ '^[A-Za-z0-9_-]{1,200}$' then raise exception using errcode='22023',message='Root request invalid';end if;
  -- Existing books can only bind their established root. Moving a library needs a migration.
  if exists(select 1 from public.books where deleted_at is null) and
   coalesce(control.root_id,(select coalesce(report->'review'->'properties'->>'ROOT_FOLDER_ID',report->'review'->'properties'->>'ROOT_FOLDER') from private.legacy_imports order by created_at limit 1),input->>'existingServerRoot','') is distinct from input->>'rootId' then
   raise exception using errcode='55000',message='Existing library root cannot change';
  end if;
  update private.runtime_control set root_id=input->>'rootId',revision=revision+1,updated_at=now() where singleton;
  update private.root_requests set status='done',root_id=input->>'rootId' where id=r.id;
 else raise exception using errcode='22023',message='Unknown operation';end if;
 insert into private.operation_events(actor_id,action,details) values(actor,operation,jsonb_build_object('requestId',input->>'requestId'));
 return public.app_operations(actor,'status');
end $$;
revoke all on function public.app_operations(uuid,text,jsonb),public.app_runtime_root(uuid) from public,anon,authenticated;
grant execute on function public.app_operations(uuid,text,jsonb),public.app_runtime_root(uuid) to service_role;
commit;

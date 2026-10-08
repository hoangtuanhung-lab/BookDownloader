begin;
alter table public.books drop constraint books_download_status_check;
alter table public.books add constraint books_download_status_check check(download_status in ('ANALYZED','QUEUED','IDLE','READY','DOWNLOADING','PAUSED','DONE','ERROR'));
alter table public.books add column control_epoch bigint not null default 1;
alter table public.jobs add column lease_epoch bigint not null default 0;
alter table public.jobs add column cancel_requested boolean not null default false;
insert into public.app_settings values('download','{"BATCH_SIZE":5,"DELAY_MS":800,"MAX_RETRY":3,"MAX_CONCURRENT":2,"FILE_CONCURRENT":2,"AUTO_RESUME":true}') on conflict do nothing;
create index jobs_book_active on public.jobs(book_id,kind) where status in ('running','queued','paused');
-- Chapter edits/deletes and book edits fence in-flight downloads; no network under SQL locks.
create function private.download_fence() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_table_name='chapters' then
  if tg_op='DELETE' or (new.title,new.group_id,new.source_url,new.is_skipped,new.content_version) is distinct from (old.title,old.group_id,old.source_url,old.is_skipped,old.content_version) then
   update public.books set control_epoch=control_epoch+1 where id=old.book_id;
  end if;
  if tg_op='DELETE' then return old;else return new;end if;
 elsif (new.version,new.deleted_at) is distinct from (old.version,old.deleted_at) then new.control_epoch:=old.control_epoch+1;end if;
 return new;
end $$;
create trigger download_book_fence before update on public.books for each row execute function private.download_fence();
create trigger download_chapter_fence before update or delete on public.chapters for each row execute function private.download_fence();
create function private.resume_import_queue() returns trigger language plpgsql set search_path='' as $$
begin
 if new.kind='FILE_IMPORT' and new.status='queued' and old.status in ('paused','failed','cancelled') and not new.cancel_requested then
  update public.books set download_status='IDLE',control_epoch=control_epoch+1 where id=new.book_id and deleted_at is null;
 end if;return new;
end $$;
create trigger resume_import_queue after update on public.jobs for each row execute function private.resume_import_queue();
revoke all on function private.resume_import_queue() from public,anon,authenticated;
create function private.job_actor_allowed(actor uuid,kind public.job_kind,book_id uuid,checkpoint jsonb) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.profiles p join public.user_permissions u on u.user_id=p.id where p.id=actor and p.status='active' and
 (u.permission='admin' or case when kind='ANALYZE' then u.permission='download' when kind='FILE_IMPORT' and (book_id is null or checkpoint ? 'add' or checkpoint ? 'preparing' and (checkpoint->>'preparing')::boolean) then u.permission='manage' else u.permission in ('download','manage') end));
$$;
revoke all on function private.job_actor_allowed(uuid,public.job_kind,uuid,jsonb) from public,anon,authenticated;
grant execute on function private.job_actor_allowed(uuid,public.job_kind,uuid,jsonb) to service_role;
create function public.app_download_settings(actor uuid,new_value jsonb default null) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform private.require_permission(actor,'admin');
 if new_value is not null then
  if jsonb_typeof(new_value->'AUTO_RESUME')<>'boolean' or (new_value->>'BATCH_SIZE')::int not between 1 and 100 or (new_value->>'DELAY_MS')::int not between 0 and 10000 or (new_value->>'MAX_RETRY')::int not between 1 and 10 or (new_value->>'MAX_CONCURRENT')::int not between 1 and 10 or (new_value->>'FILE_CONCURRENT')::int not between 1 and 10 or not new_value ?& array['BATCH_SIZE','DELAY_MS','MAX_RETRY','MAX_CONCURRENT','FILE_CONCURRENT','AUTO_RESUME'] then raise exception using errcode='22023',message='Invalid download settings';end if;
  update public.app_settings set value=new_value where key='download';
  insert into public.audit_logs(actor_id,action) values(actor,'download_settings');
 end if;
 return (select value from public.app_settings where key='download');
end $$;
create function public.app_download(actor uuid,operation text,input jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.books;saved_job public.jobs;target uuid;v jsonb;other uuid;pos integer;result jsonb:='[]';
begin
 perform private.require_permission(actor,'download');
 if operation='list' then
  return jsonb_build_object('books',coalesce((select jsonb_agg(to_jsonb(x)) from (
   select bl.id,bl.name,bl.source_type as "sourceType",bl.download_status as status,bl.version,
   count(c.id)::int as total,count(c.id) filter(where c.status='DONE' and not c.is_skipped)::int as done,
   count(c.id) filter(where c.status='ERROR')::int as errors,count(c.id) filter(where c.is_skipped)::int as skipped,
   count(c.id) filter(where c.status='PENDING' and not c.is_skipped)::int as pending,
   coalesce(max(j.priority),0) as priority,max(j.next_run_at) as "nextRunAt",max(j.checkpoint->>'error') as error,
   bool_or(j.status='running') as "inFlight",max(j.checkpoint->>'phase') as phase
   from public.books bl left join public.chapters c on c.book_id=bl.id
   left join lateral(select * from public.jobs where book_id=bl.id and kind in ('WEB_DOWNLOAD','FILE_IMPORT') order by created_at desc limit 1) j on true
   where bl.deleted_at is null and (coalesce(input->>'filter','all')='all' or bl.source_type=input->>'filter')
   group by bl.id order by priority desc,bl.created_at,bl.id offset greatest(0,coalesce((input->>'offset')::int,0)) limit 24
  ) x),'[]'), 'total',(select count(*) from public.books where deleted_at is null and (coalesce(input->>'filter','all')='all' or source_type=input->>'filter')));
 elsif operation='errors' then
  target:=(input->>'id')::uuid;
  if not exists(select 1 from public.books where id=target and deleted_at is null) then raise exception using errcode='P0002',message='Book missing';end if;
  return coalesce((select jsonb_agg(to_jsonb(x)) from (select id,title,display_number as "displayNumber",order_key as "order",status,error_code as error,retry_count as retries,is_skipped as skipped from public.chapters where book_id=target and (status='ERROR' or is_skipped) order by order_key offset greatest(0,coalesce((input->>'offset')::int,0)) limit 100) x),'[]');
 elsif operation='start-all' then
  for b in select * from public.books where deleted_at is null and source_type='WEB' and download_status='ANALYZED' order by created_at limit 200 loop
   perform public.app_download(actor,'start',jsonb_build_object('id',b.id));result:=result||jsonb_build_array(b.id);
  end loop;return jsonb_build_object('started',result);
 end if;
 target:=(input->>'id')::uuid;select * into b from public.books where id=target and deleted_at is null for update;
 if not found then raise exception using errcode='P0002',message='Book missing';end if;
 if operation='chapter' then
  if (input->>'version')::bigint is distinct from b.version then raise exception using errcode='40001',message='Book changed';end if;
  if input->>'action'='delete' then
   perform private.require_permission(actor,'manage');perform public.app_manage(actor,'chapter-action',input);
  elsif input->>'action' in ('retry','pause','cancel') then
   if not exists(select 1 from public.chapters where id=(input->>'chapter')::uuid and book_id=target) then raise exception using errcode='P0002',message='Chapter missing';end if;
   if input->>'action'='retry' then
    update public.chapters set status='PENDING',is_skipped=false,error_code=null,retry_count=0 where id=(input->>'chapter')::uuid and (status<>'DONE' or is_skipped);
   elsif input->>'action'='cancel' then
    update public.chapters set status='DONE',is_skipped=true,file_id=null,retry_count=0,error_code=null where id=(input->>'chapter')::uuid and status<>'DONE';
   else
    update public.chapters set status='ERROR',is_skipped=true,error_code='MANUAL_PAUSE: Tạm dừng thủ công' where id=(input->>'chapter')::uuid and status<>'DONE';
   end if;
   update public.books set version=version+1 where id=target;perform private.enqueue_sync(target,b.version+1);
   if input->>'action'='retry' then perform public.app_download(actor,'start',jsonb_build_object('id',b.id));end if;
   insert into public.audit_logs(actor_id,action,entity_id,details) values(actor,'chapter_'||(input->>'action'),target,jsonb_build_object('chapter',input->>'chapter'));
  else raise exception using errcode='22023',message='Invalid chapter action';end if;
  return '{"ok":true}';
 elsif operation in ('up','down') then
  if b.download_status not in ('IDLE','QUEUED') then return '{"ok":true}';end if;
  perform pg_advisory_xact_lock(71007001);
  select * into saved_job from public.jobs where book_id=target and kind in ('WEB_DOWNLOAD','FILE_IMPORT') and status='queued' order by created_at desc limit 1 for update;
  if saved_job.id is null then return '{"ok":true}';end if;
  -- Stable rank with ties broken by UUID; swap neighboring priorities in one transaction.
  with ranks as(select q.id,row_number() over(order by q.priority desc,q.created_at,q.id)::int as n from public.jobs q join public.books x on x.id=q.book_id where x.deleted_at is null and x.source_type=b.source_type and x.download_status in ('IDLE','QUEUED') and q.status='queued' and q.kind in ('WEB_DOWNLOAD','FILE_IMPORT'))
  select n into pos from ranks where id=saved_job.id;
  with ranks as(select q.id,row_number() over(order by q.priority desc,q.created_at,q.id)::int as n from public.jobs q join public.books x on x.id=q.book_id where x.deleted_at is null and x.source_type=b.source_type and x.download_status in ('IDLE','QUEUED') and q.status='queued' and q.kind in ('WEB_DOWNLOAD','FILE_IMPORT'))
  select id into other from ranks where n=pos+case operation when 'up' then -1 else 1 end;
  if other is not null then
   update public.jobs q set priority=r.rank from (select id,100000-row_number() over(order by priority desc,created_at,id)::int as rank from public.jobs where kind in ('WEB_DOWNLOAD','FILE_IMPORT')) r where q.id=r.id;
   select priority into pos from public.jobs where id=other;
   update public.jobs set priority=(select priority from public.jobs where id=saved_job.id) where id=other;
   update public.jobs set priority=pos where id=saved_job.id;
  end if;
 elsif operation in ('pause','cancel') then
  update public.books set download_status='PAUSED',control_epoch=control_epoch+1 where id=target;
  update public.jobs set status=case operation when 'pause' then 'paused' else 'cancelled' end,cancel_requested=true,lease_owner=null,lease_until=null where book_id=target and kind in ('WEB_DOWNLOAD','FILE_IMPORT') and status<>'done';
 elsif operation in ('start','retry','verify') then
  if b.source_type='FOLDER' and operation<>'verify' then raise exception using errcode='22023',message='FOLDER has no download source';end if;
  if operation='retry' then update public.chapters set status='PENDING',retry_count=0,error_code=null,is_skipped=false where book_id=target and status='ERROR';end if;
  if b.source_type='FILE' then
   select * into saved_job from public.jobs where book_id=target and kind='FILE_IMPORT' and checkpoint ? 'importId' order by created_at desc limit 1 for update;
   if operation<>'verify' and (saved_job.id is null or saved_job.status='done') then raise exception using errcode='22023',message='Import temp unavailable; import file again';end if;
  else
   insert into public.jobs(kind,actor_id,book_id,dedupe_key,checkpoint) values('WEB_DOWNLOAD',actor,target,'download:'||target,jsonb_build_object('mode','download')) on conflict(dedupe_key) do nothing;
   select * into saved_job from public.jobs where dedupe_key='download:'||target for update;
  end if;
  if operation='verify' and b.source_type='FILE' and saved_job.id is null then
   insert into public.jobs(kind,actor_id,book_id,dedupe_key,checkpoint) values('WEB_DOWNLOAD',actor,target,'verify:'||target,jsonb_build_object('mode','verify')) on conflict(dedupe_key) do update set status='queued' returning * into saved_job;
  end if;
  -- Idempotent start does not steal a current lease.
  if saved_job.status='running' and saved_job.lease_until>now() then return '{"ok":true}';end if;
  update public.jobs set status='queued',actor_id=actor,next_run_at=now(),cancel_requested=false,lease_owner=null,lease_until=null,checkpoint=checkpoint-'error'-'work'||jsonb_build_object('mode',case operation when 'verify' then 'verify' else 'download' end,'manualBatch',true) where id=saved_job.id;
  update public.books set download_status=case when operation='verify' then b.download_status else 'IDLE' end,control_epoch=control_epoch+1 where id=target;
 else raise exception using errcode='22023',message='Unknown download operation';end if;
 insert into public.audit_logs(actor_id,action,entity_id) values(actor,'download_'||operation,target);
 return '{"ok":true}';
end $$;
revoke all on function private.download_fence(),public.app_download(uuid,text,jsonb),public.app_download_settings(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.app_download(uuid,text,jsonb),public.app_download_settings(uuid,jsonb) to service_role;
commit;

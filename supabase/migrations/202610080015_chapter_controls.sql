-- Phase 7: distinguish cancelled/skipped chapters from paused errors; staged trash and WEB retry.
begin;
create or replace function public.app_manage(actor uuid,operation text,input jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.books;v jsonb;result jsonb;target uuid;asset uuid;g text;gid uuid;u private.uploads;idx integer;data bytea;total bigint;job uuid;
begin
 perform private.require_permission(actor,'manage');
 if operation='list' then
  if coalesce(input->>'sort','name') not in ('name','author','updated') or coalesce((input->>'offset')::integer,0)<0 or length(coalesce(input->>'q',''))>200 then raise exception using errcode='22023',message='Invalid page';end if;
  select jsonb_build_object('books',coalesce((select jsonb_agg(private.managed_for_actor(page,actor)) from (select * from public.books where deleted_at is null and private.reader_normalize(name||' '||author||' '||coalesce((select string_agg(g.name,' ') from public.book_genres bg join public.genres g on g.id=bg.genre_id where bg.book_id=books.id),'')) like '%'||private.reader_normalize(coalesce(input->>'q',''))||'%' order by case input->>'sort' when 'author' then author else '' end,case when input->>'sort'='updated' then updated_at end desc,normalized_name,id offset coalesce((input->>'offset')::integer,0) limit 24) page),'[]'::jsonb),'total',(select count(*) from public.books where deleted_at is null and private.reader_normalize(name||' '||author||' '||coalesce((select string_agg(g.name,' ') from public.book_genres bg join public.genres g on g.id=bg.genre_id where bg.book_id=books.id),'')) like '%'||private.reader_normalize(coalesce(input->>'q',''))||'%')) into result;return result;
 elsif operation='genres' then
  return coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name) from public.genres where listed),'[]'::jsonb);
 elsif operation='genre-save' then
  g:=trim(input->>'name');if length(g) not between 1 and 100 then raise exception using errcode='22023',message='Invalid genre';end if;
  select id into gid from public.genres where private.reader_normalize(name)=private.reader_normalize(g) order by id limit 1;
  if gid is null then insert into public.genres(name) values(g) returning id into gid;else update public.genres set listed=true where id=gid;end if;return jsonb_build_object('id',gid);
 elsif operation='genre-drop' then
  update public.genres set listed=false where id=(input->>'id')::uuid;return '{"ok":true}';
 elsif operation='genre-import' then
  update public.genres set listed=true where id in(select genre_id from public.book_genres);return '{"ok":true}';
 elsif operation='upload-start' then
  if (select count(*) from private.uploads where actor_id=actor and expires_at>now() and state<>'consumed')>=8 then raise exception using errcode='22023',message='Too many uploads';end if;
  if length(input->>'name') not between 1 and 180 or input->>'purpose' not in ('import','toc','cover','chapter') or (input->>'size')::int not between 1 and (case input->>'purpose' when 'cover' then 5000000 when 'chapter' then 2000000 else 67108864 end) then raise exception using errcode='22023',message='Invalid upload';end if;
  insert into private.uploads(actor_id,purpose,name,size) values(actor,input->>'purpose',input->>'name',(input->>'size')::int) returning id into target;return jsonb_build_object('id',target);
 elsif operation in ('upload-chunk','upload-complete','upload-drop') then
  select * into u from private.uploads where id=(input->>'id')::uuid and actor_id=actor and expires_at>now() for update;if not found then raise exception using errcode='P0002',message='Upload missing';end if;
  if operation='upload-drop' then delete from private.uploads where id=u.id;return '{"ok":true}';end if;
  if u.state<>'open' then if operation='upload-complete' and u.state='ready' then return jsonb_build_object('id',u.id);end if;raise exception using errcode='40001',message='Upload not open';end if;
  if operation='upload-chunk' then
   idx:=(input->>'index')::integer;data:=decode(input->>'data','base64');if idx<0 or idx>=ceil(u.size/262144.0) or octet_length(data)<>least(262144,u.size-idx*262144) then raise exception using errcode='22023',message='Invalid chunk';end if;
   if exists(select 1 from private.upload_chunks where upload_id=u.id and chunk_index=idx and bytes<>data) then raise exception using errcode='40001',message='Chunk conflict';end if;
   insert into private.upload_chunks values(u.id,idx,data) on conflict do nothing;return '{"ok":true}';
  end if;
  select sum(octet_length(bytes)) into total from private.upload_chunks where upload_id=u.id;if total is distinct from u.size then raise exception using errcode='22023',message='Incomplete upload';end if;
  update private.uploads set state='ready' where id=u.id;return jsonb_build_object('id',u.id);
 elsif operation='import' then
  if input ? 'upload' then
   select * into u from private.uploads where id=(input->>'upload')::uuid and actor_id=actor and purpose='import' and state='ready' and expires_at>now() for update;
   if not found then raise exception using errcode='P0002',message='Upload missing';end if;
   if input ? 'toc' and not exists(select 1 from private.uploads where id=(input->>'toc')::uuid and actor_id=actor and purpose='toc' and state='ready' and expires_at>now()) then raise exception using errcode='P0002',message='TOC missing';end if;
  elsif coalesce(input->>'folder','')='' then raise exception using errcode='22023',message='Import source missing';end if;
  insert into public.jobs(kind,actor_id,dedupe_key,checkpoint) values('FILE_IMPORT',actor,'import:'||coalesce(input->>'upload',gen_random_uuid()::text),jsonb_build_object('request',input)) on conflict(dedupe_key) do update set dedupe_key=excluded.dedupe_key returning id into job;return jsonb_build_object('jobId',job);
 elsif operation='save' then
  if jsonb_typeof(input->'items')<>'array' or jsonb_array_length(input->'items') not between 1 and 24 then raise exception using errcode='22023',message='Invalid batch';end if;
  result:='[]';
  for v in select value from jsonb_array_elements(input->'items') loop
   begin
    target:=(v->>'id')::uuid;select * into b from public.books where id=target and deleted_at is null for update;
    if not found then raise exception using errcode='P0002',message='Book missing';end if;
    if v->>'version' is null or b.version<>(v->>'version')::bigint then raise exception using errcode='40001',message='Book changed';end if;
    if length(trim(v->>'name')) not between 1 and 120 or length(v->>'author')>100 then raise exception using errcode='22023',message='Invalid metadata';end if;
    if v ? 'coverAsset' and v->>'coverAsset' is not null then
     asset:=(v->>'coverAsset')::uuid;if not exists(select 1 from private.cover_assets where id=asset and actor_id=actor and book_id is null and expires_at>now()) then raise exception using errcode='P0002',message='Cover asset missing';end if;
     update private.cover_assets set book_id=target,expires_at='infinity' where id=asset;
    end if;
    update public.books set name=trim(v->>'name'),normalized_name=private.reader_normalize(trim(v->>'name')),author=v->>'author',visibility=(v->>'visibility')::public.book_visibility,version=version+1,updated_at=now() where id=target returning * into b;
    perform private.set_genres(target,v->'genres');perform private.enqueue_sync(target,b.version);
    if v ? 'coverAsset' then insert into public.outbox_operations(book_id,kind,dedupe_key,payload) values(target,'COVER',target::text||':cover:'||b.version,jsonb_build_object('version',b.version,'asset',v->'coverAsset'));end if;
    insert into public.audit_logs(actor_id,action,entity_id) values(actor,'book_edit',target);result:=result||jsonb_build_array(jsonb_build_object('id',target,'ok',true,'version',b.version));
   exception when others then result:=result||jsonb_build_array(jsonb_build_object('id',v->>'id','ok',false,'error',case sqlstate when '40001' then 'Thông tin đã thay đổi; tải lại trước khi lưu' when '23505' then 'Tên truyện bị trùng' when 'P0002' then 'Không tìm thấy truyện hoặc ảnh bìa' else 'Thông tin không hợp lệ' end));end;
  end loop;return result;
 elsif operation='jobs' then
  return coalesce((select jsonb_agg(jsonb_build_object('id',id,'kind',kind,'bookId',book_id,'status',status,'error',checkpoint->>'error','result',checkpoint->'result') order by created_at desc) from (select * from public.jobs where kind='FILE_IMPORT' and actor_id=actor order by created_at desc limit 50) j),'[]'::jsonb);
 elsif operation='job-retry' then
  update public.jobs set status='queued',next_run_at=now(),lease_owner=null,lease_until=null where id=(input->>'id')::uuid and actor_id=actor and kind='FILE_IMPORT' and status='failed';return '{"ok":true}';
 end if;
 target:=(input->>'id')::uuid;select * into b from public.books where id=target and deleted_at is null for update;if not found then raise exception using errcode='P0002',message='Book missing';end if;
 if operation='chapters' then
  return jsonb_build_object('book',private.managed_book(b),'chapters',coalesce((select jsonb_agg(to_jsonb(page)) from (select c.id,c.order_key as "order",c.display_number as "displayNumber",c.title,c.source_url as url,c.status,c.error_code as error,coalesce(p.name,case when g.kind='PART' then g.name end,'') as part,coalesce(case when g.kind='VOLUME' then g.name end,'') as volume from public.chapters c left join public.chapter_groups g on g.id=c.group_id left join public.chapter_groups p on p.id=g.parent_id where c.book_id=target order by c.order_key offset greatest(0,coalesce((input->>'offset')::int,0)) limit 200) page),'[]'::jsonb),'groups',coalesce((select jsonb_agg(to_jsonb(g)) from public.chapter_groups g where book_id=target),'[]'::jsonb));
 end if;
 if input->>'version' is null or b.version<>(input->>'version')::bigint then raise exception using errcode='40001',message='Book changed';end if;
 if operation='delete' then
  update public.books set deleted_at=now(),visibility='hidden',version=version+1 where id=target;
  update public.jobs set status='cancelled',lease_owner=null,lease_until=null where book_id=target and status<>'done';
  delete from public.reading_progress where book_id=target;
  update public.outbox_operations set status='done',lease_owner=null,lease_until=null where book_id=target and status in ('pending','running','failed');
  if (input->>'trash')::boolean then insert into public.outbox_operations(book_id,kind,dedupe_key,payload) values(target,'TRASH',target::text||':trash',jsonb_build_object('folder',b.folder_id));end if;
  insert into public.audit_logs(actor_id,action,entity_id,details) values(actor,'book_delete',target,jsonb_build_object('trash',input->'trash'));return '{"ok":true}';
 elsif operation='sync-retry' then
  update public.outbox_operations set status='pending',next_run_at=now(),lease_owner=null,lease_until=null where book_id=target and status='failed';return '{"ok":true}';
 elsif operation='chapter-action' then
  v:=(select to_jsonb(c) from public.chapters c where c.id=(input->>'chapter')::uuid and c.book_id=target);if v is null then raise exception using errcode='P0002',message='Chapter missing';end if;
  if input->>'action'='delete' then
   if v->>'status'='DONE' and v->>'file_id' is not null then
    insert into public.outbox_operations(book_id,kind,dedupe_key,payload) select target,'CHAPTER_TRASH','chapter-trash:'||(v->>'id')||':'||(v->>'file_id'),jsonb_build_object('file',r.file_id,'owner',r.owner_subject) from public.drive_resources r where r.file_id=v->>'file_id' and r.book_id=target and r.chapter_id=(v->>'id')::uuid and r.kind='CHAPTER' on conflict do nothing;
   end if;
   if v->>'status'='ERROR' then insert into public.removed_chapters(book_id,legacy_order,display_number,title,reason,details) values(target,(v->>'legacy_order')::numeric,v->>'display_number',v->>'title','Xóa thủ công chương lỗi',v);end if;
   delete from public.reading_progress where chapter_id=(v->>'id')::uuid;delete from public.drive_resources where chapter_id=(v->>'id')::uuid;delete from public.job_items where chapter_id=(v->>'id')::uuid;delete from public.chapters where id=(v->>'id')::uuid;
  elsif input->>'action' in ('retry','cancel','pause') then
   if input->>'action'='retry' then update public.chapters set status='PENDING',retry_count=0,error_code=null,is_skipped=false where id=(v->>'id')::uuid and (status<>'DONE' or is_skipped);elsif input->>'action'='cancel' then update public.chapters set status='DONE',is_skipped=true,file_id=null,retry_count=0,error_code=null where id=(v->>'id')::uuid and status<>'DONE';else update public.chapters set status='ERROR',is_skipped=true,error_code='MANUAL_PAUSE: Tạm dừng thủ công' where id=(v->>'id')::uuid and status<>'DONE';end if;
  elsif input->>'action'='edit' then
   if length(input->>'title')>120 or length(input->>'url')>2000 then raise exception using errcode='22023',message='Invalid chapter';end if;
   update public.chapters set title=input->>'title',source_url=input->>'url',content_version=content_version+1 where id=(v->>'id')::uuid;
  else raise exception using errcode='22023',message='Invalid chapter action';end if;
  if input->>'action'='retry' then update public.jobs set status='queued',next_run_at=now() where book_id=target and kind='FILE_IMPORT' and status='paused' and checkpoint ? 'importId';end if;
  update public.books set version=version+1,updated_at=now() where id=target returning * into b;perform private.enqueue_sync(target,b.version);insert into public.audit_logs(actor_id,action,entity_id,details) values(actor,'chapter_'||(input->>'action'),target,jsonb_build_object('chapter',v->>'id'));if b.source_type='WEB' and ((input->>'action'='retry') or (input->>'action'='edit' and v->>'status'='ERROR')) then
   if input->>'action'='edit' then update public.chapters set status='PENDING',retry_count=0,error_code=null,is_skipped=false where id=(v->>'id')::uuid;end if;
   insert into public.jobs(kind,actor_id,book_id,dedupe_key,checkpoint) values('WEB_DOWNLOAD',actor,target,'download:'||target,jsonb_build_object('mode','download')) on conflict(dedupe_key) do update set status='queued',actor_id=actor,cancel_requested=false,lease_owner=null,lease_until=null,next_run_at=now(),checkpoint=public.jobs.checkpoint-'work'-'error';
   update public.books set download_status='IDLE' where id=target;
  end if;return '{"ok":true}';
 elsif operation='chapter-add' then
  if input->>'kind'='link' and b.source_type='FILE' then raise exception using errcode='22023',message='FILE cannot add URL';end if;
  if input->>'kind'='file' and not exists(select 1 from private.uploads where id=(input->>'upload')::uuid and actor_id=actor and purpose='chapter' and state='ready' and expires_at>now()) then raise exception using errcode='P0002',message='Upload missing';end if;
  insert into public.jobs(kind,actor_id,book_id,dedupe_key,checkpoint) values('FILE_IMPORT',actor,target,'add:'||gen_random_uuid(),jsonb_build_object('add',input)) returning id into job;return jsonb_build_object('jobId',job);
 end if;
 raise exception using errcode='22023',message='Unknown manage operation';
end $$;
commit;

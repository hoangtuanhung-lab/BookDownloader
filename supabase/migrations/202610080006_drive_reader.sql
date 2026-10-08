begin;
create table private.reader_cache (
 cache_key text primary key, payload jsonb not null, bytes integer not null check(bytes between 1 and 60000),
 expires_at timestamptz not null, touched_at timestamptz not null default now()
);
revoke all on private.reader_cache from public,anon,authenticated,service_role;
-- Resource mapping is authoritative; no file ID supplied by the browser.
create function public.app_reader_resource(actor uuid,target_book uuid,target_chapter uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.books; c public.chapters; r public.drive_resources; k text; cached jsonb; junk text;
begin
 perform private.require_permission(actor,'read');
 select * into b from public.books where id=target_book and deleted_at is null and
 (visibility='published' or exists(select 1 from public.user_permissions where user_id=actor and permission in ('manage','admin')));
 if not found then raise exception using errcode='P0002',message='Book missing'; end if;
 if target_chapter is not null then
  select * into c from public.chapters where id=target_chapter and book_id=b.id and status='DONE' and not is_skipped;
  if not found then raise exception using errcode='P0002',message='Chapter missing'; end if;
  select * into r from public.drive_resources where file_id=c.file_id and book_id=b.id and chapter_id=c.id and kind='CHAPTER' and sync_status='synced';
 else
  select * into r from public.drive_resources where book_id=b.id and kind='COVER' and sync_status='synced';
 end if;
 if not found then raise exception using errcode='P0002',message='Resource missing'; end if;
 select value #>> '{}' into junk from public.app_settings where key='JUNK_WORDS';
 junk:=coalesce(junk,'truyen full, truyenfull, truyenfullvn, truyenfulllive, truyenfull vn');
 k:=b.id::text||':'||coalesce(c.id::text,'cover')||':'||r.file_id||':'||r.metadata_version||':'||b.version||':'||coalesce(c.content_version,0)||':reader-v1:'||md5(junk);
 select payload into cached from private.reader_cache where cache_key=k and expires_at>now();
 return jsonb_build_object('fileId',r.file_id,'bookName',b.name,'sourceType',b.source_type,'cacheKey',k,'cached',cached,'junkWords',junk);
end $$;
create function public.app_reader_cache(actor uuid,target_book uuid,target_chapter uuid,expected_key text,new_value jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare resource jsonb; amount integer; victim text;
begin
 resource:=public.app_reader_resource(actor,target_book,target_chapter);
 if resource->>'cacheKey'<>expected_key then raise exception using errcode='40001',message='Resource changed'; end if;
 if new_value is null or jsonb_typeof(new_value->'text') is distinct from 'string' or jsonb_typeof(new_value->'title') is distinct from 'string' then raise exception using errcode='22023',message='Invalid cache'; end if;
 amount:=octet_length(new_value::text);if amount>60000 then return; end if;
 perform pg_advisory_xact_lock(hashtextextended('book-reader-cache',0));
 delete from private.reader_cache where expires_at<=now() or cache_key=expected_key;
 while (select coalesce(sum(bytes),0) from private.reader_cache)+amount>8000000 loop
  select cache_key into victim from private.reader_cache order by touched_at,cache_key limit 1;
  exit when victim is null; delete from private.reader_cache where cache_key=victim;
 end loop;
 insert into private.reader_cache(cache_key,payload,bytes,expires_at) values(expected_key,new_value,amount,now()+interval '5 minutes');
end $$;
revoke all on function public.app_reader_resource(uuid,uuid,uuid),public.app_reader_cache(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.app_reader_resource(uuid,uuid,uuid),public.app_reader_cache(uuid,uuid,uuid,text,jsonb) to service_role;
commit;

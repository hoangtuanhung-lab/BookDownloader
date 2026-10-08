begin;
create function private.reader_normalize(value text) returns text language sql immutable set search_path='' as $$
 select translate(regexp_replace(normalize(lower(coalesce(value,'')),NFD),U&'[\0300-\036f]','','g'),'đ','d');
$$;
revoke all on function private.reader_normalize(text) from public;
create function private.reader_book(actor uuid,b public.books) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',b.id,'name',b.name,'author',b.author,'genres',coalesce((select jsonb_agg(g.name order by bg.position) from public.book_genres bg join public.genres g on g.id=bg.genre_id where bg.book_id=b.id),'[]'::jsonb),'label',b.label,'chapterCount',(select count(*) from public.chapters c where c.book_id=b.id and c.status='DONE' and not c.is_skipped),'hasCover',exists(select 1 from public.drive_resources where book_id=b.id and kind='COVER' and sync_status='synced'),'version',b.version,
 'progress',(select jsonb_build_object('chapterId',p.chapter_id,'ratio',p.ratio,'scrollPosition',p.scroll_position,'revision',p.revision,'updatedAt',p.updated_at) from public.reading_progress p join public.chapters c on c.id=p.chapter_id and c.book_id=b.id and c.status='DONE' and not c.is_skipped where p.user_id=actor and p.book_id=b.id),
 'progressIndex',case when exists(select 1 from public.reading_progress p join public.chapters c on c.id=p.chapter_id and c.book_id=b.id and c.status='DONE' and not c.is_skipped where p.user_id=actor and p.book_id=b.id) then (select count(*) from public.chapters c where c.book_id=b.id and c.status='DONE' and not c.is_skipped and c.order_key<(select x.order_key from public.reading_progress p join public.chapters x on x.id=p.chapter_id and x.book_id=b.id and x.status='DONE' and not x.is_skipped where p.user_id=actor and p.book_id=b.id)) else null end);
$$;
revoke all on function private.reader_book(uuid,public.books) from public;
create function public.app_reader_book(actor uuid,target_book uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.books;
begin
 perform private.require_permission(actor,'read');
 select * into b from public.books where id=target_book and visibility='published' and deleted_at is null;
 if not found then raise exception using errcode='P0002',message='Book missing'; end if;
 return private.reader_book(actor,b);
end $$;
create function public.app_library(actor uuid,query text default '',sort_by text default 'name',page_offset integer default 0) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; amount bigint;
begin
 perform private.require_permission(actor,'read');
 if length(query)>200 or sort_by not in ('name','author','updated','progress') or page_offset<0 or page_offset>10000000 then raise exception using errcode='22023',message='Invalid page';end if;
 select count(*) into amount from public.books b where b.visibility='published' and b.deleted_at is null and strpos(private.reader_normalize(b.name||' '||b.author||' '||coalesce((select string_agg(g.name,' ') from public.book_genres bg join public.genres g on g.id=bg.genre_id where bg.book_id=b.id),'')),private.reader_normalize(query))>0;
 select coalesce(jsonb_agg(dto),'[]'::jsonb) into result from (
 select private.reader_book(actor,b) dto from public.books b
 left join public.reading_progress p on p.book_id=b.id and p.user_id=actor
 where b.visibility='published' and b.deleted_at is null and strpos(private.reader_normalize(b.name||' '||b.author||' '||coalesce((select string_agg(g.name,' ') from public.book_genres bg join public.genres g on g.id=bg.genre_id where bg.book_id=b.id),'')),private.reader_normalize(query))>0
 order by case when sort_by='updated' then b.updated_at end desc nulls last,case when sort_by='progress' then p.updated_at end desc nulls last,case when sort_by='author' then private.reader_normalize(b.author) end,private.reader_normalize(b.name),b.id limit 24 offset page_offset) page;
 return jsonb_build_object('books',result,'total',amount,'offset',page_offset);
end $$;
create function public.app_reader_chapters(actor uuid,target_book uuid,page_offset integer default 0,page_limit integer default 200) returns jsonb
language plpgsql security definer set search_path='' as $$
declare book jsonb; result jsonb; junk text;
begin
 book:=public.app_reader_book(actor,target_book);
 if page_offset<0 or page_offset>10000000 or page_limit<1 or page_limit>200 then raise exception using errcode='22023',message='Invalid chapter page';end if;
 select value #>> '{}' into junk from public.app_settings where key='JUNK_WORDS';junk:=coalesce(junk,'truyen full, truyenfull, truyenfullvn, truyenfulllive, truyenfull vn');
 select coalesce(jsonb_agg(dto order by index),'[]'::jsonb) into result from (
 select jsonb_build_object('id',c.id,'index',c.index,'order',c.legacy_order,'displayNumber',c.display_number,'title',c.title,
 'part',case when g.kind='PART' then g.name when parent.kind='PART' then parent.name else '' end,'volume',case when g.kind='VOLUME' then g.name else '' end,
 'cacheTag',case when r.file_id is not null then md5(target_book::text||':'||c.id::text||':'||r.file_id||':'||r.metadata_version||':'||(book->>'version')||':'||c.content_version||':reader-v1:'||md5(junk)) else '' end) dto,c.index
 from (select *,row_number() over(order by order_key,id)-1 as index from public.chapters where book_id=target_book and status='DONE' and not is_skipped) c
 left join public.chapter_groups g on g.id=c.group_id and g.book_id=target_book left join public.chapter_groups parent on parent.id=g.parent_id and parent.book_id=target_book
 left join public.drive_resources r on r.file_id=c.file_id and r.chapter_id=c.id and r.book_id=target_book and r.kind='CHAPTER' and r.sync_status='synced'
 order by c.index limit page_limit offset page_offset) page;
 return jsonb_build_object('book',book,'chapters',result,'total',book->'chapterCount','offset',page_offset);
end $$;
alter table public.reader_preferences add column view text check(view in ('scroll','page'));
create or replace function public.app_preferences(actor uuid,new_value jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.require_permission(actor,'read');
 if new_value is not null then
 insert into public.reader_preferences(user_id,font,font_size,theme,blue_filter,mode,view) values(actor,new_value->>'font',(new_value->>'fontSize')::integer,new_value->>'theme',(new_value->>'blueFilter')::numeric,new_value->>'mode',new_value->>'view')
 on conflict(user_id) do update set font=excluded.font,font_size=excluded.font_size,theme=excluded.theme,blue_filter=excluded.blue_filter,mode=excluded.mode,view=excluded.view;
 end if;
 select jsonb_build_object('font',font,'fontSize',font_size,'theme',theme,'blueFilter',blue_filter,'mode',mode)||case when view is null then '{}'::jsonb else jsonb_build_object('view',view) end into result from public.reader_preferences where user_id=actor;
 return result;
end $$;
revoke all on function public.app_reader_book(uuid,uuid),public.app_library(uuid,text,text,integer),public.app_reader_chapters(uuid,uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.app_reader_book(uuid,uuid),public.app_library(uuid,text,text,integer),public.app_reader_chapters(uuid,uuid,integer,integer) to service_role;
commit;

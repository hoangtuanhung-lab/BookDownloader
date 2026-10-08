-- Phase 8 load finding: limit the eligible rows before joins/JSON construction.
begin;
create or replace function public.app_reader_chapters(actor uuid,target_book uuid,page_offset integer default 0,page_limit integer default 200) returns jsonb
language plpgsql security definer set search_path='' as $$
declare book jsonb; result jsonb; junk text;
begin
 book:=public.app_reader_book(actor,target_book);
 if page_offset<0 or page_offset>10000000 or page_limit<1 or page_limit>200 then raise exception using errcode='22023',message='Invalid chapter page';end if;
 select value #>> '{}' into junk from public.app_settings where key='JUNK_WORDS';
 junk:=coalesce(junk,'truyen full, truyenfull, truyenfullvn, truyenfulllive, truyenfull vn');
 with eligible as materialized (
  select * from public.chapters where book_id=target_book and status='DONE' and not is_skipped
  order by order_key,id limit page_limit offset page_offset
 ), numbered as (
  select *,row_number() over(order by order_key,id)-1+page_offset as index from eligible
 )
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',c.id,'index',c.index,'order',c.legacy_order,'displayNumber',c.display_number,'title',c.title,
  'part',case when g.kind='PART' then g.name when parent.kind='PART' then parent.name else '' end,
  'volume',case when g.kind='VOLUME' then g.name else '' end,
  'cacheTag',case when r.file_id is not null then md5(target_book::text||':'||c.id::text||':'||r.file_id||':'||r.metadata_version||':'||(book->>'version')||':'||c.content_version||':reader-v1:'||md5(junk)) else '' end
 ) order by c.index),'[]'::jsonb) into result
 from numbered c
 left join public.chapter_groups g on g.id=c.group_id and g.book_id=target_book
 left join public.chapter_groups parent on parent.id=g.parent_id and parent.book_id=target_book
 left join public.drive_resources r on r.file_id=c.file_id and r.chapter_id=c.id and r.book_id=target_book and r.kind='CHAPTER' and r.sync_status='synced';
 return jsonb_build_object('book',book,'chapters',result,'total',book->'chapterCount','offset',page_offset);
end $$;
commit;

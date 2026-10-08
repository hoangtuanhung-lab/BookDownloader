begin;
create function public.app_manage_cover(actor uuid,target_book uuid,target_chapter uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.books;r public.drive_resources;
begin
 perform private.require_permission(actor,'manage');select * into b from public.books where id=target_book and deleted_at is null;if not found then raise exception using errcode='P0002',message='Book missing';end if;
 select * into r from public.drive_resources where book_id=b.id and kind='COVER' and sync_status='synced';if not found then raise exception using errcode='P0002',message='Cover missing';end if;
 return jsonb_build_object('fileId',r.file_id,'bookName',b.name,'sourceType',b.source_type,'cacheKey',b.id::text||':'||r.file_id||':'||b.version||':'||r.metadata_version,'cached',null,'junkWords','');
end $$;
revoke all on function public.app_manage_cover(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.app_manage_cover(uuid,uuid,uuid) to service_role;
commit;

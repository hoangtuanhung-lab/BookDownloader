-- Reader-facing roles cannot select operational/Drive/source metadata.
begin;
revoke select on public.books,public.chapters from authenticated;
grant select(id,name,author,label,visibility,version,created_at,updated_at) on public.books to authenticated;
grant select(id,book_id,group_id,order_key,display_number,title,status,content_version,is_skipped) on public.chapters to authenticated;
commit;

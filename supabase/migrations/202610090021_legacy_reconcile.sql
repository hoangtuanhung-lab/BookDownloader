begin;
alter table public.chapters add column legacy_updated_at timestamptz;
create table private.legacy_transfers(source_key text primary key references private.legacy_imports(source_key),checksum text not null,report jsonb not null,created_at timestamptz not null default now());
create table private.legacy_archives(source_key text references private.legacy_imports(source_key),kind text not null,content jsonb not null,primary key(source_key,kind));
revoke all on private.legacy_transfers,private.legacy_archives from public,anon,authenticated,service_role;
create or replace function public.review_legacy_book(actor uuid,target uuid,expected_checksum text) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform private.require_permission(actor,'admin');
 perform pg_advisory_xact_lock_shared(610090001);
 perform pg_advisory_xact_lock(hashtextextended('book-writer:'||target::text,0));
 perform 1 from public.books where id=target and deleted_at is null for update;
 if not found or not exists(select 1 from private.legacy_imports l join public.migration_items m on m.run_id=l.run_id where m.entity_kind='book' and m.new_id=target and l.checksum=expected_checksum and l.owner_id=actor) then
  raise exception using errcode='22023',message='Migration checksum/owner mismatch';
 end if;
 if exists(select 1 from public.drive_resources where book_id=target and (sync_status<>'synced' or content_hash is null or content_hash !~ '^[a-f0-9]{64}$')) then
  raise exception using errcode='55000',message='Verified file hashes required';
 end if;
 if exists(select 1 from public.books b join public.chapters c on c.book_id=b.id where b.id=target and b.source_type='FILE' and c.status<>'DONE' and not c.is_skipped)
 and not exists(select 1 from public.jobs j join public.drive_resources r on r.file_id=j.checkpoint->>'importId' and r.book_id=j.book_id and r.kind='IMPORT' and r.sync_status='synced' and r.content_hash ~ '^[a-f0-9]{64}$' where j.book_id=target and j.kind='FILE_IMPORT' and j.status='paused') then
  raise exception using errcode='55000',message='Pending legacy FILE manifest needs reconciliation';
 end if;
 update private.legacy_book_review set reviewed_at=now(),actor_id=actor where book_id=target;
 update public.jobs set checkpoint=checkpoint-'migrationReviewRequired' where book_id=target and status='paused';
 insert into public.audit_logs(actor_id,action,entity_id) values(actor,'legacy_review',target);
end $$;
commit;

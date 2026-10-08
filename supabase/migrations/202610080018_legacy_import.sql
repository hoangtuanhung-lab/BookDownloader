-- Phase 8: private ledger. A changed snapshot requires an explicit delta plan.
begin;
create table private.legacy_imports (
 source_key text primary key check(length(source_key) between 1 and 120),
 checksum text not null check(checksum ~ '^[a-f0-9]{64}$'),
 run_id uuid not null references public.migration_runs(id),
 owner_id uuid not null references public.profiles(id),
 report jsonb not null,
 created_at timestamptz not null default now()
);
revoke all on private.legacy_imports from public,anon,authenticated,service_role;
create table private.legacy_book_review (
 book_id uuid primary key references public.books(id) on delete cascade,
 reviewed_at timestamptz, actor_id uuid references public.profiles(id)
);
revoke all on private.legacy_book_review from public,anon,authenticated,service_role;
create function private.migration_write_allowed(target uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select not exists(select 1 from private.legacy_book_review where book_id=target and reviewed_at is null);
$$;
revoke all on function private.migration_write_allowed(uuid) from public,anon,authenticated;
grant execute on function private.migration_write_allowed(uuid) to service_role;
alter function public.app_download(uuid,text,jsonb) set schema private;
alter function private.app_download(uuid,text,jsonb) rename to download_before_migration_review;
revoke all on function private.download_before_migration_review(uuid,text,jsonb) from public,anon,authenticated,service_role;
create function public.app_download(actor uuid,operation text,input jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform private.require_permission(actor,'download');
 if operation in ('start','retry','verify') or operation='chapter' and input->>'action'='retry' then
  if exists(select 1 from private.legacy_book_review where book_id=(input->>'id')::uuid and reviewed_at is null) then
   raise exception using errcode='55000',message='Migration review required';
  end if;
 elsif operation='start-all' and exists(select 1 from private.legacy_book_review r join public.books b on b.id=r.book_id where r.reviewed_at is null and b.deleted_at is null and b.source_type='WEB' and b.download_status='ANALYZED') then
  raise exception using errcode='55000',message='Migration review required';
 end if;
 return private.download_before_migration_review(actor,operation,input);
end $$;
revoke all on function public.app_download(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.app_download(uuid,text,jsonb) to service_role;
alter function private.job_actor_allowed(uuid,public.job_kind,uuid,jsonb) rename to job_actor_before_migration_review;
revoke all on function private.job_actor_before_migration_review(uuid,public.job_kind,uuid,jsonb) from public,anon,authenticated,service_role;
create function private.job_actor_allowed(actor uuid,kind public.job_kind,book_id uuid,checkpoint jsonb) returns boolean
language sql stable security definer set search_path='' as $$
 select not exists(select 1 from private.legacy_book_review r where r.book_id=$3 and r.reviewed_at is null)
 and private.job_actor_before_migration_review(actor,kind,book_id,checkpoint);
$$;
revoke all on function private.job_actor_allowed(uuid,public.job_kind,uuid,jsonb) from public,anon,authenticated;
grant execute on function private.job_actor_allowed(uuid,public.job_kind,uuid,jsonb) to service_role;
-- Server/operator only. Real file/root access and legacy writer freeze must be checked first.
create function public.review_legacy_book(actor uuid,target uuid,expected_checksum text) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform private.require_permission(actor,'admin');
 perform pg_advisory_xact_lock(hashtextextended('book-writer:'||target::text,0));
 perform 1 from public.books where id=target and deleted_at is null for update;
 if not found or not exists(select 1 from private.legacy_imports l join public.migration_items m on m.run_id=l.run_id where m.entity_kind='book' and m.new_id=target and l.checksum=expected_checksum and l.owner_id=actor) then
  raise exception using errcode='22023',message='Migration checksum/owner mismatch';
 end if;
 if exists(select 1 from public.drive_resources where book_id=target and (sync_status<>'synced' or content_hash is null or content_hash !~ '^[a-f0-9]{64}$')) then
  raise exception using errcode='55000',message='Verified file hashes required';
 end if;
 if exists(select 1 from public.books b join public.chapters c on c.book_id=b.id where b.id=target and b.source_type='FILE' and c.status<>'DONE' and not c.is_skipped) then
  raise exception using errcode='55000',message='Pending legacy FILE manifest needs explicit reconciliation';
 end if;
 update private.legacy_book_review set reviewed_at=now(),actor_id=actor where book_id=target;
 update public.jobs set checkpoint=checkpoint-'migrationReviewRequired' where book_id=target and status='paused';
 insert into public.audit_logs(actor_id,action,entity_id) values(actor,'legacy_review',target);
end $$;
revoke all on function public.review_legacy_book(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.review_legacy_book(uuid,uuid,text) to service_role;
commit;

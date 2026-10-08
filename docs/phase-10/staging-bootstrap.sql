-- BookDownloader: bootstrap application schema on a fresh Supabase STAGING project.
-- Generated 2026-10-09 from the 23 immutable migration files below.
-- Copy the ENTIRE file into Supabase SQL Editor and run as postgres.
-- No local auth fixtures, test users, secrets, Drive writes or billing actions.
-- Application DDL + migration checksums commit together. Stop on any error.
-- Already-installed application schemas are refused; this is not an upgrade script.
-- Source revision: 3f5e63872dec02fef16d0a57e99b6c46e2b46589
begin;
set local lock_timeout = '10s';
set local statement_timeout = '60s';
select pg_advisory_xact_lock(610080001);
do $bootstrap_guard$
begin
 if to_regclass('auth.users') is null or to_regclass('auth.sessions') is null or to_regprocedure('auth.uid()') is null then
  raise exception 'Supabase Auth schema is required. Do not run local-auth fixtures on Supabase.';
 end if;
 if to_regclass('public.profiles') is not null or to_regclass('public.books') is not null or to_regclass('public.schema_migrations') is not null then
  raise exception 'Application schema already exists. Stop and inspect migrations; do not rerun bootstrap.';
 end if;
end
$bootstrap_guard$;
create table public.schema_migrations (
 name text primary key,
 checksum text not null,
 applied_at timestamptz not null default now()
);
revoke all on public.schema_migrations from public,anon,authenticated,service_role;

-- MIGRATION 202610080001_foundation.sql SHA256 130ac2fea86dcc7b0330c0353326ca2bfd1f37a33b538457ac7f009d5e1fd01f
-- Phase 1. PostgreSQL 17 / Supabase. No real users or content are seeded.
-- Supabase provides auth.users/auth.uid; local-only equivalents live in tools/dev.
create schema if not exists private;
revoke all on schema private from public;
create type public.permission_kind as enum ('read','download','manage','admin');
create type public.book_visibility as enum ('hidden','published');
create type public.job_kind as enum ('ANALYZE','WEB_DOWNLOAD','FILE_IMPORT','DRIVE_SYNC');
create table public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 display_name text not null default '', avatar_url text,
 status text not null default 'active' check(status in ('active','blocked')),
 created_at timestamptz not null default now()
);
create table public.user_permissions (
 user_id uuid references public.profiles(id) on delete cascade,
 permission public.permission_kind not null, primary key(user_id,permission)
);
create table public.books (
 id uuid primary key default gen_random_uuid(), legacy_id text unique,
 name text not null check(length(name) between 1 and 120),
 normalized_name text not null check(length(normalized_name)>0), author text not null default '',
 source_url text not null default '', source_type text not null check(source_type in ('WEB','FILE','FOLDER')),
 label text not null default 'Chương', folder_id text unique,
 download_status text not null default 'ANALYZED' check(download_status in ('ANALYZED','QUEUED','DOWNLOADING','PAUSED','DONE','ERROR')),
 visibility public.book_visibility not null default 'hidden', version bigint not null default 1 check(version>0),
 deleted_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(source_type <> 'WEB' or source_url ~ '^https?://')
);
create unique index books_live_name on public.books(normalized_name) where deleted_at is null;
create index books_library on public.books(visibility, normalized_name, id) where deleted_at is null;
create index books_search on public.books using gin(to_tsvector('simple',name||' '||author));
create table public.genres(id uuid primary key default gen_random_uuid(),name text not null unique);
create table public.book_genres(
 book_id uuid references public.books(id) on delete cascade, genre_id uuid references public.genres(id),
 position smallint not null check(position>=0), primary key(book_id,genre_id), unique(book_id,position)
);
create table public.chapter_groups(
 id uuid primary key default gen_random_uuid(),book_id uuid not null references public.books(id) on delete cascade,
 parent_id uuid, kind text not null check(kind in ('PART','VOLUME')), name text not null,
 order_key numeric not null, unique(id,book_id),
 foreign key(parent_id,book_id) references public.chapter_groups(id,book_id), check(parent_id is distinct from id)
);
create table public.chapters(
 id uuid primary key default gen_random_uuid(),book_id uuid not null references public.books(id) on delete cascade,
 group_id uuid, legacy_order numeric not null, order_key numeric not null, display_number text not null default '',
 title text not null default '', source_url text not null default '',
 status text not null default 'PENDING' check(status in ('PENDING','DONE','ERROR')),
 file_id text unique, retry_count integer not null default 0 check(retry_count>=0), error_code text,
 content_version bigint not null default 1 check(content_version>0), is_skipped boolean not null default false,
 unique(id,book_id), unique(book_id,order_key), foreign key(group_id,book_id) references public.chapter_groups(id,book_id)
);
create index chapters_reader on public.chapters(book_id,order_key,id) where status='DONE' and not is_skipped;
create table public.reading_progress(
 user_id uuid references public.profiles(id) on delete cascade,book_id uuid references public.books(id) on delete cascade,
 chapter_id uuid, ratio numeric not null default 0 check(ratio between 0 and 1),
 scroll_position numeric not null default 0 check(scroll_position>=0), revision bigint not null default 1 check(revision>0),
 updated_at timestamptz not null default now(),primary key(user_id,book_id),
 foreign key(chapter_id,book_id) references public.chapters(id,book_id)
);
create table public.reader_preferences(
 user_id uuid primary key references public.profiles(id) on delete cascade, font text not null default 'Literata',
 font_size integer not null default 20 check(font_size between 12 and 48), theme text not null default 'day' check(theme in ('day','night')),
 blue_filter numeric not null default 0 check(blue_filter between 0 and 1), mode text not null default 'chapter' check(mode in ('chapter','continuous'))
);
create table public.jobs(
 id uuid primary key default gen_random_uuid(), kind public.job_kind not null,
 book_id uuid references public.books(id) on delete cascade, actor_id uuid references public.profiles(id),
 priority integer not null default 0, status text not null default 'queued' check(status in ('queued','running','paused','done','failed','cancelled')),
 attempts integer not null default 0 check(attempts>=0), next_run_at timestamptz not null default now(),
 lease_owner text,lease_until timestamptz,checkpoint jsonb not null default '{}',dedupe_key text not null unique,
 created_at timestamptz not null default now(), check((lease_owner is null)=(lease_until is null)),
 check(status <> 'running' or lease_owner is not null)
);
create index jobs_claim on public.jobs(kind,next_run_at,priority desc,id) where status in ('queued','running');
create table public.job_items(
 id uuid primary key default gen_random_uuid(),job_id uuid not null references public.jobs(id) on delete cascade,
 chapter_id uuid references public.chapters(id),status text not null default 'pending' check(status in ('pending','done','failed')),
 attempts integer not null default 0 check(attempts>=0),checkpoint jsonb not null default '{}',unique(job_id,chapter_id)
);
create table public.app_settings(key text primary key,value jsonb not null);
create table public.site_rules(domain text primary key,config jsonb not null);
create table public.site_credentials(domain text primary key references public.site_rules(domain),secret_reference text not null);
create table public.drive_resources(
 file_id text primary key,book_id uuid not null references public.books(id) on delete cascade,
 chapter_id uuid,owner_subject text not null,kind text not null check(kind in ('CHAPTER','INFO','COVER','IMPORT','REMOVED_LOG')),
 metadata_version bigint not null check(metadata_version>0),sync_status text not null default 'pending' check(sync_status in ('pending','synced','error')),
 content_hash text,foreign key(chapter_id,book_id) references public.chapters(id,book_id)
);
create unique index drive_book_singleton on public.drive_resources(book_id,kind) where kind in ('INFO','COVER','IMPORT','REMOVED_LOG');
create table public.outbox_operations(
 id uuid primary key default gen_random_uuid(),book_id uuid references public.books(id),kind text not null,
 dedupe_key text not null unique,payload jsonb not null,status text not null default 'pending' check(status in ('pending','running','done','failed')),
 attempts integer not null default 0 check(attempts>=0),next_run_at timestamptz not null default now(),lease_owner text,lease_until timestamptz,
 check((lease_owner is null)=(lease_until is null))
);
create index outbox_pending on public.outbox_operations(next_run_at,id) where status='pending';
create table public.audit_logs(id bigint generated always as identity primary key,actor_id uuid references public.profiles(id),action text not null,entity_id uuid,details jsonb not null default '{}',created_at timestamptz not null default now());
create table public.removed_chapters(id uuid primary key default gen_random_uuid(),book_id uuid not null references public.books(id),legacy_order numeric,display_number text,title text,reason text not null,removed_at timestamptz not null default now());
create table public.migration_runs(id uuid primary key default gen_random_uuid(),baseline_commit text not null,status text not null check(status in ('dry_run','running','done','failed')),report jsonb not null default '{}',created_at timestamptz not null default now());
create table public.migration_items(run_id uuid references public.migration_runs(id) on delete cascade,legacy_id text,entity_kind text not null,new_id uuid,status text not null check(status in ('pending','mapped','failed')),primary key(run_id,entity_kind,legacy_id));
-- Security-definer helpers read only authorization data, fixed search_path; no user-controlled SQL.
create function private.has_permission(required public.permission_kind) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles p join public.user_permissions u on u.user_id=p.id
 where p.id=auth.uid() and p.status='active' and (u.permission=required or u.permission='admin'));
$$;
create function private.can_read_book(target uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select private.has_permission('read') and exists(select 1 from public.books b where b.id=target and b.deleted_at is null and (b.visibility='published' or private.has_permission('manage')));
$$;
revoke all on function private.has_permission(public.permission_kind),private.can_read_book(uuid) from public;
grant usage on schema private to authenticated;
grant execute on function private.has_permission(public.permission_kind),private.can_read_book(uuid) to authenticated;
alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant all on public.profiles to service_role;
alter table public.user_permissions enable row level security;
revoke all on public.user_permissions from anon, authenticated;
grant all on public.user_permissions to service_role;
alter table public.books enable row level security;
revoke all on public.books from anon, authenticated;
grant all on public.books to service_role;
alter table public.genres enable row level security;
revoke all on public.genres from anon, authenticated;
grant all on public.genres to service_role;
alter table public.book_genres enable row level security;
revoke all on public.book_genres from anon, authenticated;
grant all on public.book_genres to service_role;
alter table public.chapter_groups enable row level security;
revoke all on public.chapter_groups from anon, authenticated;
grant all on public.chapter_groups to service_role;
alter table public.chapters enable row level security;
revoke all on public.chapters from anon, authenticated;
grant all on public.chapters to service_role;
alter table public.reading_progress enable row level security;
revoke all on public.reading_progress from anon, authenticated;
grant all on public.reading_progress to service_role;
alter table public.reader_preferences enable row level security;
revoke all on public.reader_preferences from anon, authenticated;
grant all on public.reader_preferences to service_role;
alter table public.jobs enable row level security;
revoke all on public.jobs from anon, authenticated;
grant all on public.jobs to service_role;
alter table public.job_items enable row level security;
revoke all on public.job_items from anon, authenticated;
grant all on public.job_items to service_role;
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;
grant all on public.app_settings to service_role;
alter table public.site_rules enable row level security;
revoke all on public.site_rules from anon, authenticated;
grant all on public.site_rules to service_role;
alter table public.site_credentials enable row level security;
revoke all on public.site_credentials from anon, authenticated;
grant all on public.site_credentials to service_role;
alter table public.drive_resources enable row level security;
revoke all on public.drive_resources from anon, authenticated;
grant all on public.drive_resources to service_role;
alter table public.outbox_operations enable row level security;
revoke all on public.outbox_operations from anon, authenticated;
grant all on public.outbox_operations to service_role;
alter table public.audit_logs enable row level security;
revoke all on public.audit_logs from anon, authenticated;
grant all on public.audit_logs to service_role;
alter table public.removed_chapters enable row level security;
revoke all on public.removed_chapters from anon, authenticated;
grant all on public.removed_chapters to service_role;
alter table public.migration_runs enable row level security;
revoke all on public.migration_runs from anon, authenticated;
grant all on public.migration_runs to service_role;
alter table public.migration_items enable row level security;
revoke all on public.migration_items from anon, authenticated;
grant all on public.migration_items to service_role;
grant usage on schema public to anon,authenticated,service_role;
grant usage,select on all sequences in schema public to service_role;
grant select on public.profiles to authenticated;
create policy read_visible on public.profiles for select to authenticated using (id=auth.uid() and private.has_permission('read'));
grant select on public.user_permissions to authenticated;
create policy read_visible on public.user_permissions for select to authenticated using (user_id=auth.uid() and private.has_permission('read'));
grant select on public.books to authenticated;
create policy read_visible on public.books for select to authenticated using (private.can_read_book(id));
grant select on public.genres to authenticated;
create policy read_visible on public.genres for select to authenticated using (private.has_permission('read'));
grant select on public.book_genres to authenticated;
create policy read_visible on public.book_genres for select to authenticated using (private.can_read_book(book_id));
grant select on public.chapter_groups to authenticated;
create policy read_visible on public.chapter_groups for select to authenticated using (private.can_read_book(book_id));
grant select on public.chapters to authenticated;
create policy read_visible on public.chapters for select to authenticated using (private.can_read_book(book_id) and (private.has_permission('manage') or (status='DONE' and not is_skipped)));
grant select,insert,update,delete on public.reading_progress to authenticated;
create policy own_rows on public.reading_progress to authenticated using (user_id=auth.uid() and private.can_read_book(book_id) and (chapter_id is null or exists(select 1 from public.chapters c where c.id=chapter_id and c.book_id=reading_progress.book_id and c.status='DONE' and not c.is_skipped))) with check (user_id=auth.uid() and private.can_read_book(book_id) and (chapter_id is null or exists(select 1 from public.chapters c where c.id=chapter_id and c.book_id=reading_progress.book_id and c.status='DONE' and not c.is_skipped)));
grant select,insert,update,delete on public.reader_preferences to authenticated;
create policy own_rows on public.reader_preferences to authenticated using (user_id=auth.uid() and private.has_permission('read')) with check (user_id=auth.uid() and private.has_permission('read'));
-- Service role intentionally bypasses RLS; never put it in browser bundles.
revoke all on schema private from service_role;
create function public.app_health() returns integer language sql stable set search_path='' as $$ select 1 $$;
revoke all on function public.app_health() from public,anon,authenticated;
grant execute on function public.app_health() to service_role;

insert into public.schema_migrations(name,checksum) values ('202610080001_foundation.sql','130ac2fea86dcc7b0330c0353326ca2bfd1f37a33b538457ac7f009d5e1fd01f');

-- MIGRATION 202610080002_reader_columns.sql SHA256 b0047612934b78f4a461029f031e587046e0bb42bcbfee60f8193d6f59748b0b
-- Reader-facing roles cannot select operational/Drive/source metadata.
revoke select on public.books,public.chapters from authenticated;
grant select(id,name,author,label,visibility,version,created_at,updated_at) on public.books to authenticated;
grant select(id,book_id,group_id,order_key,display_number,title,status,content_version,is_skipped) on public.chapters to authenticated;

insert into public.schema_migrations(name,checksum) values ('202610080002_reader_columns.sql','b0047612934b78f4a461029f031e587046e0bb42bcbfee60f8193d6f59748b0b');

-- MIGRATION 202610080003_auth_permissions.sql SHA256 c08a81ff8ca125fe6bd4995a272b19f91fd01469f2ff1a37ef503d38fe4c12f5
-- One-shot default reader, never repair grants on every login (revocation must persist).
create function private.new_auth_user() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into public.profiles(id,display_name) values(new.id,left(coalesce(new.raw_user_meta_data->>'full_name',''),120));
 insert into public.user_permissions(user_id,permission) values(new.id,'read');
 return new;
end $$;
revoke all on function private.new_auth_user() from public;
create trigger book_auth_user_created after insert on auth.users for each row execute function private.new_auth_user();
-- Backfill existing identities once; no admin inferred from sign-up order.
insert into public.profiles(id,display_name) select id,left(coalesce(raw_user_meta_data->>'full_name',''),120) from auth.users on conflict(id) do nothing;
insert into public.user_permissions(user_id,permission) select id,'read' from public.profiles on conflict do nothing;
create table private.bootstrap_owner(user_id uuid primary key references auth.users(id),constraint one_owner check (true));
create unique index bootstrap_one_owner on private.bootstrap_owner((true));
-- Callable only by the owner through a server CLI. UUID supplied by owner configuration.
create function public.bootstrap_admin(target uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from auth.users where id=target and email is not null and
 (raw_app_meta_data->>'provider'='google' or raw_app_meta_data->'providers' ? 'google')) then
  raise exception using errcode='22023',message='Confirmed Google identity required';
 end if;
 insert into private.bootstrap_owner(user_id) values(target);
 insert into public.user_permissions(user_id,permission) values(target,'admin') on conflict do nothing;
 insert into public.audit_logs(actor_id,action,entity_id) values(target,'bootstrap_admin',target);
end $$;
create function private.require_permission(actor uuid,needed public.permission_kind) returns void
language plpgsql set search_path='' as $$
begin
 -- Transaction lock makes concurrent permission mutations/read checks serialize.
 perform pg_advisory_xact_lock(hashtextextended('book-authz',0));
 if not exists(select 1 from public.profiles p join public.user_permissions u on u.user_id=p.id
 where p.id=actor and p.status='active' and (u.permission=needed or u.permission='admin')) then
  raise exception using errcode='42501',message='Permission denied';
 end if;
end $$;
create function public.app_me(actor uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not exists(select 1 from public.profiles where id=actor and status='active') then
  raise exception using errcode='42501',message='Account blocked or missing';
 end if;
 select jsonb_build_object('id',p.id,'name',p.display_name,'permissions',coalesce((select jsonb_agg(u.permission order by u.permission) from public.user_permissions u where u.user_id=p.id),'[]'::jsonb)) into result from public.profiles p where p.id=actor;
 return result;
end $$;
create function public.app_admin_users(actor uuid,after_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.require_permission(actor,'admin');
 select coalesce(jsonb_agg(row_to_json(page)),'[]'::jsonb) into result from (
 select p.id,p.display_name as name,a.email,p.status,
 coalesce((select jsonb_agg(u.permission order by u.permission) from public.user_permissions u where u.user_id=p.id),'[]'::jsonb) as permissions
 from public.profiles p join auth.users a on a.id=p.id where after_id is null or p.id>after_id order by p.id limit 50) page;
 return result;
end $$;
create function public.app_admin_update(actor uuid,target uuid,permissions public.permission_kind[],account_status text) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform private.require_permission(actor,'admin');
 if account_status not in ('active','blocked') or permissions is null then raise exception using errcode='22023',message='Invalid account update'; end if;
 if not exists(select 1 from public.profiles where id=target) then raise exception using errcode='P0002',message='User missing'; end if;
 -- Never remove/block the last active admin, including concurrent requests.
 if (account_status='blocked' or not 'admin'=any(permissions)) and exists(select 1 from public.user_permissions where user_id=target and permission='admin') and
 not exists(select 1 from public.profiles p join public.user_permissions u on u.user_id=p.id where p.id<>target and p.status='active' and u.permission='admin') then
 raise exception using errcode='23514',message='Last admin must remain active'; end if;
 update public.profiles set status=account_status where id=target;
 delete from public.user_permissions where user_id=target;
 insert into public.user_permissions(user_id,permission) select target,v from (select distinct unnest(permissions) v) values_set;
 insert into public.audit_logs(actor_id,action,entity_id,details) values(actor,'account_permissions',target,jsonb_build_object('permissions',permissions,'status',account_status));
end $$;
create function public.app_preferences(actor uuid,new_value jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.require_permission(actor,'read');
 if new_value is not null then
 insert into public.reader_preferences(user_id,font,font_size,theme,blue_filter,mode) values(actor,new_value->>'font',(new_value->>'fontSize')::integer,new_value->>'theme',(new_value->>'blueFilter')::numeric,new_value->>'mode')
 on conflict(user_id) do update set font=excluded.font,font_size=excluded.font_size,theme=excluded.theme,blue_filter=excluded.blue_filter,mode=excluded.mode;
 end if;
 select jsonb_build_object('font',font,'fontSize',font_size,'theme',theme,'blueFilter',blue_filter,'mode',mode) into result from public.reader_preferences where user_id=actor;
 return result;
end $$;
create function public.app_progress(actor uuid,target_book uuid,new_value jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;current_revision bigint;
begin
 perform private.require_permission(actor,'read');
 if not exists(select 1 from public.books where id=target_book and deleted_at is null and
 (visibility='published' or exists(select 1 from public.user_permissions where user_id=actor and permission in ('manage','admin')))) then raise exception using errcode='P0002',message='Book missing';end if;
 if new_value is not null then
  if not exists(select 1 from public.chapters where id=(new_value->>'chapterId')::uuid and book_id=target_book and status='DONE' and not is_skipped) then raise exception using errcode='P0002',message='Chapter missing';end if;
  select revision into current_revision from public.reading_progress where user_id=actor and book_id=target_book for update;
  if coalesce(current_revision,0) <> (new_value->>'expectedRevision')::bigint then raise exception using errcode='40001',message='Progress conflict';end if;
  insert into public.reading_progress(user_id,book_id,chapter_id,ratio,scroll_position,revision,updated_at) values(actor,target_book,(new_value->>'chapterId')::uuid,(new_value->>'ratio')::numeric,(new_value->>'scrollPosition')::numeric,1,now())
  on conflict(user_id,book_id) do update set chapter_id=excluded.chapter_id,ratio=excluded.ratio,scroll_position=excluded.scroll_position,revision=public.reading_progress.revision+1,updated_at=now();
 end if;
 select jsonb_build_object('chapterId',chapter_id,'ratio',ratio,'scrollPosition',scroll_position,'revision',revision,'updatedAt',updated_at) into result from public.reading_progress where user_id=actor and book_id=target_book;
 return result;
end $$;
-- Browser cannot bypass revision, timestamp or API permission checks on writes.
revoke insert,update,delete on public.reading_progress,public.reader_preferences from authenticated;
-- Explicit service-only RPC grants; authenticated cannot spoof actor UUID.
revoke all on function public.bootstrap_admin(uuid),public.app_me(uuid),public.app_admin_users(uuid,uuid),public.app_admin_update(uuid,uuid,public.permission_kind[],text),public.app_preferences(uuid,jsonb),public.app_progress(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.bootstrap_admin(uuid),public.app_me(uuid),public.app_admin_users(uuid,uuid),public.app_admin_update(uuid,uuid,public.permission_kind[],text),public.app_preferences(uuid,jsonb),public.app_progress(uuid,uuid,jsonb) to service_role;

insert into public.schema_migrations(name,checksum) values ('202610080003_auth_permissions.sql','c08a81ff8ca125fe6bd4995a272b19f91fd01469f2ff1a37ef503d38fe4c12f5');

-- MIGRATION 202610080004_bootstrap_verified.sql SHA256 84c90787a4729b41c2357786169ac1868c58b7f5a1138a5515abe7bb1aa8651b
revoke all on function private.require_permission(uuid,public.permission_kind) from public,anon,authenticated;
create or replace function public.bootstrap_admin(target uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from auth.users a join public.profiles p on p.id=a.id
 where a.id=target and a.email is not null and a.email_confirmed_at is not null and p.status='active' and
 (a.raw_app_meta_data->>'provider'='google' or a.raw_app_meta_data->'providers' ? 'google')) then
  raise exception using errcode='22023',message='Confirmed active Google identity required';
 end if;
 insert into private.bootstrap_owner(user_id) values(target);
 insert into public.user_permissions(user_id,permission) values(target,'admin') on conflict do nothing;
 insert into public.audit_logs(actor_id,action,entity_id) values(target,'bootstrap_admin',target);
end $$;

insert into public.schema_migrations(name,checksum) values ('202610080004_bootstrap_verified.sql','84c90787a4729b41c2357786169ac1868c58b7f5a1138a5515abe7bb1aa8651b');

-- MIGRATION 202610080005_active_sessions.sql SHA256 4a75288594a155667fd13d5a353fffe286a8be3e03312f3dba16cd436be7c33f
-- getUser verifies the JWT; this rejects retained tokens after session revocation.
create function public.app_session_active(actor uuid,target_session uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.sessions where id=target_session and user_id=actor and (not_after is null or not_after>now()));
$$;
revoke all on function public.app_session_active(uuid,uuid) from public,anon,authenticated;
grant execute on function public.app_session_active(uuid,uuid) to service_role;

insert into public.schema_migrations(name,checksum) values ('202610080005_active_sessions.sql','4a75288594a155667fd13d5a353fffe286a8be3e03312f3dba16cd436be7c33f');

-- MIGRATION 202610080006_drive_reader.sql SHA256 b0e2bc2b5ccc047807aeacf4adc4bf8562e0669715d3b3e6e42348d4c00c07cf
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

insert into public.schema_migrations(name,checksum) values ('202610080006_drive_reader.sql','b0e2bc2b5ccc047807aeacf4adc4bf8562e0669715d3b3e6e42348d4c00c07cf');

-- MIGRATION 202610080007_reader_library.sql SHA256 52300211dab28d567c9b972dfd0aff96685d23374d7061ccc37efed434881688
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

insert into public.schema_migrations(name,checksum) values ('202610080007_reader_library.sql','52300211dab28d567c9b972dfd0aff96685d23374d7061ccc37efed434881688');

-- MIGRATION 202610080008_management_analysis.sql SHA256 1b86401f189e874bfb3cf6e3871a0cce686746beb693db63715e72ec050185e1
-- Upload bodies are temporary, service-only and bounded. No browser table grants.
create table private.uploads(id uuid primary key default gen_random_uuid(),actor_id uuid not null references public.profiles(id),purpose text not null check(purpose in ('import','toc','cover','chapter')),name text not null,size integer not null check(size between 1 and 67108864),state text not null default 'open' check(state in ('open','ready','consumed')),expires_at timestamptz not null default now()+interval '24 hours');
create table private.upload_chunks(upload_id uuid references private.uploads(id) on delete cascade,chunk_index integer check(chunk_index between 0 and 255),bytes bytea not null check(octet_length(bytes) between 1 and 262144),primary key(upload_id,chunk_index));
create table private.cover_assets(id uuid primary key default gen_random_uuid(),actor_id uuid not null references public.profiles(id),bytes bytea not null,hash text not null,book_id uuid references public.books(id),expires_at timestamptz not null default now()+interval '24 hours');
alter table public.genres add column listed boolean not null default true;
alter table public.removed_chapters add column details jsonb not null default '{}';
alter table public.chapters add constraint chapter_source_unique unique(book_id,source_url) deferrable initially deferred;
-- Empty URLs are shared by imports, so use a partial index instead.
alter table public.chapters drop constraint chapter_source_unique;
create unique index chapters_live_url on public.chapters(book_id,source_url) where source_url<>'';
create unique index books_live_source on public.books(source_url) where source_url<>'' and deleted_at is null;
insert into public.app_settings(key,value) values('analysis','{"SITE_RULES":"","JUNK_WORDS":"","DELAY_MS":500}') on conflict do nothing;
create function private.enqueue_sync(target uuid,v bigint) returns void language sql set search_path='' as $$
 insert into public.outbox_operations(book_id,kind,dedupe_key,payload) values(target,'BOOK_SYNC',target::text||':sync:'||v,jsonb_build_object('version',v)) on conflict(dedupe_key) do nothing;
$$;
create function private.set_genres(target uuid,values_list jsonb) returns void language plpgsql set search_path='' as $$
declare g text;gid uuid;pos integer:=0;
begin
 if jsonb_typeof(values_list)<>'array' or jsonb_array_length(values_list)>6 then raise exception using errcode='22023',message='Invalid genres';end if;
 delete from public.book_genres where book_id=target;
 for g in select distinct on(private.reader_normalize(value)) value from jsonb_array_elements_text(values_list) with ordinality order by private.reader_normalize(value),ordinality loop
  if length(trim(g)) not between 1 and 100 then raise exception using errcode='22023',message='Invalid genre';end if;
 end loop;
 -- Preserve user order: first item is the primary genre, never alphabetize it.
 for g in select value from jsonb_array_elements_text(values_list) loop
  select id into gid from public.genres where private.reader_normalize(name)=private.reader_normalize(g) order by id limit 1;
  if gid is null then insert into public.genres(name) values(trim(g)) returning id into gid;end if;
  if not exists(select 1 from public.book_genres where book_id=target and genre_id=gid) then insert into public.book_genres values(target,gid,pos);pos:=pos+1;end if;
 end loop;
end $$;
create function private.managed_book(b public.books) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',b.id,'name',b.name,'author',b.author,'genres',coalesce((select jsonb_agg(g.name order by bg.position) from public.book_genres bg join public.genres g on g.id=bg.genre_id where bg.book_id=b.id),'[]'::jsonb),'visibility',b.visibility,'version',b.version,'sourceType',b.source_type,'sourceUrl',b.source_url,'folderId',b.folder_id,'status',b.download_status,'total',(select count(*) from public.chapters where book_id=b.id and not is_skipped),'done',(select count(*) from public.chapters where book_id=b.id and status='DONE' and not is_skipped),'hasCover',exists(select 1 from public.drive_resources where book_id=b.id and kind='COVER'),'sync',case when exists(select 1 from public.outbox_operations where book_id=b.id and status='failed') then 'error' when exists(select 1 from public.outbox_operations where book_id=b.id and status in ('pending','running')) then 'pending' else 'synced' end);
$$;
create function public.app_manage(actor uuid,operation text,input jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.books;v jsonb;result jsonb;target uuid;asset uuid;g text;gid uuid;u private.uploads;idx integer;data bytea;total bigint;job uuid;
begin
 perform private.require_permission(actor,'manage');
 if operation='list' then
  if coalesce((input->>'offset')::integer,0)<0 or length(coalesce(input->>'q',''))>200 then raise exception using errcode='22023',message='Invalid page';end if;
  select jsonb_build_object('books',coalesce((select jsonb_agg(private.managed_book(page)) from (select * from public.books where deleted_at is null and private.reader_normalize(name||' '||author) like '%'||private.reader_normalize(coalesce(input->>'q',''))||'%' order by normalized_name,id offset coalesce((input->>'offset')::integer,0) limit 24) page),'[]'::jsonb),'total',(select count(*) from public.books where deleted_at is null and private.reader_normalize(name||' '||author) like '%'||private.reader_normalize(coalesce(input->>'q',''))||'%')) into result;return result;
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
    if b.version<>(v->>'version')::bigint then raise exception using errcode='40001',message='Book changed';end if;
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
 if b.version<>(input->>'version')::bigint then raise exception using errcode='40001',message='Book changed';end if;
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
   if v->>'status'='ERROR' then insert into public.removed_chapters(book_id,legacy_order,display_number,title,reason,details) values(target,(v->>'legacy_order')::numeric,v->>'display_number',v->>'title','Xóa thủ công chương lỗi',v);end if;
   delete from public.reading_progress where chapter_id=(v->>'id')::uuid;delete from public.drive_resources where chapter_id=(v->>'id')::uuid;delete from public.job_items where chapter_id=(v->>'id')::uuid;delete from public.chapters where id=(v->>'id')::uuid;
  elsif input->>'action' in ('retry','cancel','pause') then
   if input->>'action'='retry' then update public.chapters set status='PENDING',retry_count=0,error_code=null,is_skipped=false where id=(v->>'id')::uuid and status<>'DONE';else update public.chapters set is_skipped=true where id=(v->>'id')::uuid and status<>'DONE';end if;
  elsif input->>'action'='edit' then
   if length(input->>'title')>120 or length(input->>'url')>2000 then raise exception using errcode='22023',message='Invalid chapter';end if;
   update public.chapters set title=input->>'title',source_url=input->>'url',content_version=content_version+1 where id=(v->>'id')::uuid;
  else raise exception using errcode='22023',message='Invalid chapter action';end if;
  update public.books set version=version+1,updated_at=now() where id=target returning * into b;perform private.enqueue_sync(target,b.version);insert into public.audit_logs(actor_id,action,entity_id,details) values(actor,'chapter_'||(input->>'action'),target,jsonb_build_object('chapter',v->>'id'));return '{"ok":true}';
 elsif operation='chapter-add' then
  if input->>'kind'='link' and b.source_type='FILE' then raise exception using errcode='22023',message='FILE cannot add URL';end if;
  if input->>'kind'='file' and not exists(select 1 from private.uploads where id=(input->>'upload')::uuid and actor_id=actor and purpose='chapter' and state='ready' and expires_at>now()) then raise exception using errcode='P0002',message='Upload missing';end if;
  insert into public.jobs(kind,actor_id,book_id,dedupe_key,checkpoint) values('FILE_IMPORT',actor,target,'add:'||gen_random_uuid(),jsonb_build_object('add',input)) returning id into job;return jsonb_build_object('jobId',job);
 end if;
 raise exception using errcode='22023',message='Unknown manage operation';
end $$;
create function public.app_analysis(actor uuid,operation text,input jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare raw text;job uuid;v jsonb;result jsonb:='[]';
begin
 perform private.require_permission(actor,'download');
 if operation='list' then
  return jsonb_build_object('jobs',coalesce((select jsonb_agg(jsonb_build_object('id',j.id,'url',j.checkpoint->'request'->>'url','status',j.status,'error',j.checkpoint->>'error','book',case when b.id is not null and b.deleted_at is null then private.managed_book(b) else null end) order by j.created_at,j.id) from (select * from public.jobs where kind='ANALYZE' and status<>'cancelled' order by created_at desc limit 100) j left join public.books b on b.id=j.book_id),'[]'::jsonb));
 elsif operation='queue' then
  if jsonb_array_length(input->'urls') not between 1 and 50 or input->>'mode' not in ('auto','manual') or input->>'mode'='manual' and ((input->>'total')::integer not between 1 and 20000 or length(input->>'name') not between 1 and 120) then raise exception using errcode='22023',message='Invalid analysis';end if;
  if (select count(*) from public.jobs where kind='ANALYZE' and status in ('queued','running','failed'))+jsonb_array_length(input->'urls')>50 then raise exception using errcode='22023',message='Analysis queue full';end if;
  for raw in select jsonb_array_elements_text(input->'urls') loop
   if length(raw)>2000 or raw!~'^https?://' then raise exception using errcode='22023',message='Invalid URL';end if;
   insert into public.jobs(kind,actor_id,dedupe_key,checkpoint) values('ANALYZE',actor,'analysis:'||raw,jsonb_build_object('request',input-'urls'||jsonb_build_object('url',raw))) on conflict(dedupe_key) do update set dedupe_key=excluded.dedupe_key returning id into job;result:=result||jsonb_build_array(jsonb_build_object('id',job,'url',raw));
  end loop;return result;
 elsif operation in ('retry','drop') then
  update public.jobs set status=case operation when 'retry' then 'queued' else 'cancelled' end,lease_owner=null,lease_until=null,next_run_at=now() where id=(input->>'id')::uuid and kind='ANALYZE' and (status in ('failed','queued','done') or operation='drop');return '{"ok":true}';
 elsif operation='genre-bulk' then
  perform private.require_permission(actor,'manage');
  for v in select to_jsonb(b) from public.books b where deleted_at is null and download_status='ANALYZED' loop
   begin perform private.set_genres((v->>'id')::uuid,input->'genres');update public.books set version=version+1 where id=(v->>'id')::uuid;perform private.enqueue_sync((v->>'id')::uuid,(v->>'version')::bigint+1);result:=result||jsonb_build_array(jsonb_build_object('id',v->>'id','ok',true));exception when others then result:=result||jsonb_build_array(jsonb_build_object('id',v->>'id','ok',false));end;
  end loop;insert into public.audit_logs(actor_id,action,details) values(actor,'analysis_genres',input);return result;
 end if;raise exception using errcode='22023',message='Invalid analysis operation';
end $$;
create function public.app_settings(actor uuid,new_value jsonb default null) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform private.require_permission(actor,'admin');if new_value is not null then
 if length(new_value->>'SITE_RULES')>2000 or length(new_value->>'JUNK_WORDS')>10000 or (new_value->>'DELAY_MS')::int not between 0 and 10000 then raise exception using errcode='22023',message='Invalid settings';end if;
 update public.app_settings set value=new_value where key='analysis';insert into public.audit_logs(actor_id,action) values(actor,'analysis_settings');end if;return (select value from public.app_settings where key='analysis');
end $$;
-- Covers decoded server-side; preview bytes are scoped to the original actor.
create function public.app_cover_asset(actor uuid,upload uuid default null,asset_id uuid default null,content text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare u private.uploads;a private.cover_assets;bytes bytea;
begin
 perform private.require_permission(actor,'manage');
 if asset_id is not null then select * into a from private.cover_assets where id=asset_id and actor_id=actor and expires_at>now();if not found then raise exception using errcode='P0002',message='Asset missing';end if;return jsonb_build_object('bytes',encode(a.bytes,'base64'));
 end if;
 select * into u from private.uploads where id=upload and actor_id=actor and purpose='cover' and state='ready' and expires_at>now() for update;if not found then raise exception using errcode='P0002',message='Upload missing';end if;
 if content is null then select string_agg(encode(c.bytes,'hex'),'' order by c.chunk_index) into content from private.upload_chunks c where upload_id=upload;return jsonb_build_object('bytes',encode(decode(content,'hex'),'base64'));end if;
 bytes:=decode(content,'base64');if octet_length(bytes)>5000000 then raise exception using errcode='22023',message='Invalid cover';end if;
 insert into private.cover_assets(actor_id,bytes,hash) values(actor,bytes,md5(encode(bytes,'hex'))) returning * into a;update private.uploads set state='consumed' where id=upload;delete from private.upload_chunks where upload_id=upload;return jsonb_build_object('id',a.id);
end $$;
revoke all on function private.enqueue_sync(uuid,bigint),private.set_genres(uuid,jsonb),private.managed_book(public.books) from public,anon,authenticated;
revoke all on function public.app_manage(uuid,text,jsonb),public.app_analysis(uuid,text,jsonb),public.app_settings(uuid,jsonb),public.app_cover_asset(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.app_manage(uuid,text,jsonb),public.app_analysis(uuid,text,jsonb),public.app_settings(uuid,jsonb),public.app_cover_asset(uuid,uuid,uuid,text) to service_role;

insert into public.schema_migrations(name,checksum) values ('202610080008_management_analysis.sql','1b86401f189e874bfb3cf6e3871a0cce686746beb693db63715e72ec050185e1');

-- MIGRATION 202610080009_management_followup.sql SHA256 9305b38e556f2704258d7095680feb96f2428bbcaea1abded5acc3a7e41c012f
-- Follow-up only: Phase 5–6 migrations already applied keep their checksums.
alter table private.cover_assets add column created_at timestamptz not null default now();
create function private.managed_for_actor(b public.books,actor uuid) returns jsonb language sql stable set search_path='' as $$
 select private.managed_book(b)||jsonb_build_object('progress',case when exists(select 1 from public.user_permissions where user_id=actor and permission in ('read','admin')) then (select jsonb_build_object('ratio',r.ratio,'chapterId',r.chapter_id,'index',(select count(*) from public.chapters c where c.book_id=b.id and c.status='DONE' and not c.is_skipped and c.order_key<=(select order_key from public.chapters where id=r.chapter_id))) from public.reading_progress r where r.user_id=actor and r.book_id=b.id) else null end);
$$;
revoke all on function private.managed_for_actor(public.books,uuid) from public,anon,authenticated;
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
    if b.version<>(v->>'version')::bigint then raise exception using errcode='40001',message='Book changed';end if;
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
 if b.version<>(input->>'version')::bigint then raise exception using errcode='40001',message='Book changed';end if;
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
   if v->>'status'='ERROR' then insert into public.removed_chapters(book_id,legacy_order,display_number,title,reason,details) values(target,(v->>'legacy_order')::numeric,v->>'display_number',v->>'title','Xóa thủ công chương lỗi',v);end if;
   delete from public.reading_progress where chapter_id=(v->>'id')::uuid;delete from public.drive_resources where chapter_id=(v->>'id')::uuid;delete from public.job_items where chapter_id=(v->>'id')::uuid;delete from public.chapters where id=(v->>'id')::uuid;
  elsif input->>'action' in ('retry','cancel','pause') then
   if input->>'action'='retry' then update public.chapters set status='PENDING',retry_count=0,error_code=null,is_skipped=false where id=(v->>'id')::uuid and status<>'DONE';else update public.chapters set is_skipped=true where id=(v->>'id')::uuid and status<>'DONE';end if;
  elsif input->>'action'='edit' then
   if length(input->>'title')>120 or length(input->>'url')>2000 then raise exception using errcode='22023',message='Invalid chapter';end if;
   update public.chapters set title=input->>'title',source_url=input->>'url',content_version=content_version+1 where id=(v->>'id')::uuid;
  else raise exception using errcode='22023',message='Invalid chapter action';end if;
  update public.books set version=version+1,updated_at=now() where id=target returning * into b;perform private.enqueue_sync(target,b.version);insert into public.audit_logs(actor_id,action,entity_id,details) values(actor,'chapter_'||(input->>'action'),target,jsonb_build_object('chapter',v->>'id'));return '{"ok":true}';
 elsif operation='chapter-add' then
  if input->>'kind'='link' and b.source_type='FILE' then raise exception using errcode='22023',message='FILE cannot add URL';end if;
  if input->>'kind'='file' and not exists(select 1 from private.uploads where id=(input->>'upload')::uuid and actor_id=actor and purpose='chapter' and state='ready' and expires_at>now()) then raise exception using errcode='P0002',message='Upload missing';end if;
  insert into public.jobs(kind,actor_id,book_id,dedupe_key,checkpoint) values('FILE_IMPORT',actor,target,'add:'||gen_random_uuid(),jsonb_build_object('add',input)) returning id into job;return jsonb_build_object('jobId',job);
 end if;
 raise exception using errcode='22023',message='Unknown manage operation';
end $$;
create or replace function public.app_settings(actor uuid,new_value jsonb default null) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform private.require_permission(actor,'admin');if new_value is not null then
 if length(new_value->>'SITE_RULES')>2000 or length(new_value->>'JUNK_WORDS')>10000 or (new_value->>'DELAY_MS')::int not between 0 and 10000 then raise exception using errcode='22023',message='Invalid settings';end if;
 update public.app_settings set value=new_value where key='analysis';
 insert into public.app_settings(key,value) values('JUNK_WORDS',new_value->'JUNK_WORDS') on conflict(key) do update set value=excluded.value;
 insert into public.audit_logs(actor_id,action) values(actor,'analysis_settings');end if;return (select value from public.app_settings where key='analysis');
end $$;
update public.app_settings set value=jsonb_build_object('SITE_RULES','','JUNK_WORDS','truyen full, truyenfull, truyenfullvn, truyenfulllive, truyenfull vn','DELAY_MS',800) where key='analysis' and value='{"SITE_RULES":"","JUNK_WORDS":"","DELAY_MS":500}';

insert into public.schema_migrations(name,checksum) values ('202610080009_management_followup.sql','9305b38e556f2704258d7095680feb96f2428bbcaea1abded5acc3a7e41c012f');

-- MIGRATION 202610080010_management_cover.sql SHA256 bbb3c797d293441a5919cd3834a100fbfd82cbc16ae4b4bc49c1c0747c079feb
create function public.app_manage_cover(actor uuid,target_book uuid,target_chapter uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.books;r public.drive_resources;
begin
 perform private.require_permission(actor,'manage');select * into b from public.books where id=target_book and deleted_at is null;if not found then raise exception using errcode='P0002',message='Book missing';end if;
 select * into r from public.drive_resources where book_id=b.id and kind='COVER' and sync_status='synced';if not found then raise exception using errcode='P0002',message='Cover missing';end if;
 return jsonb_build_object('fileId',r.file_id,'bookName',b.name,'sourceType',b.source_type,'cacheKey',b.id::text||':'||r.file_id||':'||b.version||':'||r.metadata_version,'cached',null,'junkWords','');
end $$;
revoke all on function public.app_manage_cover(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.app_manage_cover(uuid,uuid,uuid) to service_role;

insert into public.schema_migrations(name,checksum) values ('202610080010_management_cover.sql','bbb3c797d293441a5919cd3834a100fbfd82cbc16ae4b4bc49c1c0747c079feb');

-- MIGRATION 202610080011_management_guards.sql SHA256 ef2cd202fcd912c09a13dfbc91be7b3edcc3221d0ae3af6b79ea00ad29109878
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
   if v->>'status'='ERROR' then insert into public.removed_chapters(book_id,legacy_order,display_number,title,reason,details) values(target,(v->>'legacy_order')::numeric,v->>'display_number',v->>'title','Xóa thủ công chương lỗi',v);end if;
   delete from public.reading_progress where chapter_id=(v->>'id')::uuid;delete from public.drive_resources where chapter_id=(v->>'id')::uuid;delete from public.job_items where chapter_id=(v->>'id')::uuid;delete from public.chapters where id=(v->>'id')::uuid;
  elsif input->>'action' in ('retry','cancel','pause') then
   if input->>'action'='retry' then update public.chapters set status='PENDING',retry_count=0,error_code=null,is_skipped=false where id=(v->>'id')::uuid and status<>'DONE';else update public.chapters set is_skipped=true where id=(v->>'id')::uuid and status<>'DONE';end if;
  elsif input->>'action'='edit' then
   if length(input->>'title')>120 or length(input->>'url')>2000 then raise exception using errcode='22023',message='Invalid chapter';end if;
   update public.chapters set title=input->>'title',source_url=input->>'url',content_version=content_version+1 where id=(v->>'id')::uuid;
  else raise exception using errcode='22023',message='Invalid chapter action';end if;
  update public.books set version=version+1,updated_at=now() where id=target returning * into b;perform private.enqueue_sync(target,b.version);insert into public.audit_logs(actor_id,action,entity_id,details) values(actor,'chapter_'||(input->>'action'),target,jsonb_build_object('chapter',v->>'id'));return '{"ok":true}';
 elsif operation='chapter-add' then
  if input->>'kind'='link' and b.source_type='FILE' then raise exception using errcode='22023',message='FILE cannot add URL';end if;
  if input->>'kind'='file' and not exists(select 1 from private.uploads where id=(input->>'upload')::uuid and actor_id=actor and purpose='chapter' and state='ready' and expires_at>now()) then raise exception using errcode='P0002',message='Upload missing';end if;
  insert into public.jobs(kind,actor_id,book_id,dedupe_key,checkpoint) values('FILE_IMPORT',actor,target,'add:'||gen_random_uuid(),jsonb_build_object('add',input)) returning id into job;return jsonb_build_object('jobId',job);
 end if;
 raise exception using errcode='22023',message='Unknown manage operation';
end $$;
create function private.removed_group_details() returns trigger language plpgsql set search_path='' as $$
declare g public.chapter_groups;p public.chapter_groups;
begin
 select * into g from public.chapter_groups where id=(new.details->>'group_id')::uuid;
 if g.parent_id is not null then select * into p from public.chapter_groups where id=g.parent_id;end if;
 new.details:=new.details||jsonb_build_object('part',coalesce(p.name,case when g.kind='PART' then g.name end,''),'vol',coalesce(case when g.kind='VOLUME' then g.name end,''));return new;
end $$;
revoke all on function private.removed_group_details() from public,anon,authenticated;
create trigger removed_group_names before insert on public.removed_chapters for each row execute function private.removed_group_details();

insert into public.schema_migrations(name,checksum) values ('202610080011_management_guards.sql','ef2cd202fcd912c09a13dfbc91be7b3edcc3221d0ae3af6b79ea00ad29109878');

-- MIGRATION 202610080012_analysis_requeue.sql SHA256 bf55302cde795eec8cfb4f41803ee2ce570efc142ee65d84ef7120cbb6f5e831
create or replace function public.app_analysis(actor uuid,operation text,input jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare raw text;job uuid;v jsonb;result jsonb:='[]';
begin
 perform private.require_permission(actor,'download');
 if operation='list' then
  return jsonb_build_object('jobs',coalesce((select jsonb_agg(jsonb_build_object('id',j.id,'url',j.checkpoint->'request'->>'url','status',j.status,'error',j.checkpoint->>'error','book',case when b.id is not null and b.deleted_at is null then private.managed_book(b) else null end) order by j.created_at,j.id) from (select * from public.jobs where kind='ANALYZE' and status<>'cancelled' order by created_at desc limit 100) j left join public.books b on b.id=j.book_id),'[]'::jsonb));
 elsif operation='queue' then
  if jsonb_array_length(input->'urls') not between 1 and 50 or input->>'mode' not in ('auto','manual') or input->>'mode'='manual' and ((input->>'total')::integer not between 1 and 20000 or length(input->>'name') not between 1 and 120) then raise exception using errcode='22023',message='Invalid analysis';end if;
  if (select count(*) from public.jobs where kind='ANALYZE' and status in ('queued','running','failed'))+jsonb_array_length(input->'urls')>50 then raise exception using errcode='22023',message='Analysis queue full';end if;
  for raw in select jsonb_array_elements_text(input->'urls') loop
   if length(raw)>2000 or raw!~'^https?://' then raise exception using errcode='22023',message='Invalid URL';end if;
   insert into public.jobs(kind,actor_id,dedupe_key,checkpoint) values('ANALYZE',actor,'analysis:'||raw,jsonb_build_object('request',input-'urls'||jsonb_build_object('url',raw))) on conflict(dedupe_key) do update set status=case when public.jobs.status='running' then 'running' else 'queued' end,actor_id=case when public.jobs.status='running' then public.jobs.actor_id else excluded.actor_id end,checkpoint=case when public.jobs.status='running' then public.jobs.checkpoint else excluded.checkpoint end,lease_owner=case when public.jobs.status='running' then public.jobs.lease_owner else null end,lease_until=case when public.jobs.status='running' then public.jobs.lease_until else null end,next_run_at=now() returning id into job;result:=result||jsonb_build_array(jsonb_build_object('id',job,'url',raw));
  end loop;return result;
 elsif operation in ('retry','drop') then
  update public.jobs set status=case operation when 'retry' then 'queued' else 'cancelled' end,lease_owner=null,lease_until=null,next_run_at=now(),checkpoint=case when operation='retry' then jsonb_build_object('request',checkpoint->'request') else checkpoint end where id=(input->>'id')::uuid and kind='ANALYZE' and (status in ('failed','queued','done') or operation='drop');return '{"ok":true}';
 elsif operation='genre-bulk' then
  perform private.require_permission(actor,'manage');
  for v in select to_jsonb(b) from public.books b where deleted_at is null and download_status='ANALYZED' loop
   begin perform private.set_genres((v->>'id')::uuid,input->'genres');update public.books set version=version+1 where id=(v->>'id')::uuid;perform private.enqueue_sync((v->>'id')::uuid,(v->>'version')::bigint+1);result:=result||jsonb_build_array(jsonb_build_object('id',v->>'id','ok',true));exception when others then result:=result||jsonb_build_array(jsonb_build_object('id',v->>'id','ok',false));end;
  end loop;insert into public.audit_logs(actor_id,action,details) values(actor,'analysis_genres',input);return result;
 end if;raise exception using errcode='22023',message='Invalid analysis operation';
end $$;

insert into public.schema_migrations(name,checksum) values ('202610080012_analysis_requeue.sql','bf55302cde795eec8cfb4f41803ee2ce570efc142ee65d84ef7120cbb6f5e831');

-- MIGRATION 202610080013_import_pause.sql SHA256 41ad78123ad1881b13d473d5b9f1f74764969b71d55b217220a2148f31cf035b
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
   if v->>'status'='ERROR' then insert into public.removed_chapters(book_id,legacy_order,display_number,title,reason,details) values(target,(v->>'legacy_order')::numeric,v->>'display_number',v->>'title','Xóa thủ công chương lỗi',v);end if;
   delete from public.reading_progress where chapter_id=(v->>'id')::uuid;delete from public.drive_resources where chapter_id=(v->>'id')::uuid;delete from public.job_items where chapter_id=(v->>'id')::uuid;delete from public.chapters where id=(v->>'id')::uuid;
  elsif input->>'action' in ('retry','cancel','pause') then
   if input->>'action'='retry' then update public.chapters set status='PENDING',retry_count=0,error_code=null,is_skipped=false where id=(v->>'id')::uuid and status<>'DONE';else update public.chapters set is_skipped=true where id=(v->>'id')::uuid and status<>'DONE';end if;
  elsif input->>'action'='edit' then
   if length(input->>'title')>120 or length(input->>'url')>2000 then raise exception using errcode='22023',message='Invalid chapter';end if;
   update public.chapters set title=input->>'title',source_url=input->>'url',content_version=content_version+1 where id=(v->>'id')::uuid;
  else raise exception using errcode='22023',message='Invalid chapter action';end if;
  if input->>'action'='retry' then update public.jobs set status='queued',next_run_at=now() where book_id=target and kind='FILE_IMPORT' and status='paused' and checkpoint ? 'importId';end if;
  update public.books set version=version+1,updated_at=now() where id=target returning * into b;perform private.enqueue_sync(target,b.version);insert into public.audit_logs(actor_id,action,entity_id,details) values(actor,'chapter_'||(input->>'action'),target,jsonb_build_object('chapter',v->>'id'));return '{"ok":true}';
 elsif operation='chapter-add' then
  if input->>'kind'='link' and b.source_type='FILE' then raise exception using errcode='22023',message='FILE cannot add URL';end if;
  if input->>'kind'='file' and not exists(select 1 from private.uploads where id=(input->>'upload')::uuid and actor_id=actor and purpose='chapter' and state='ready' and expires_at>now()) then raise exception using errcode='P0002',message='Upload missing';end if;
  insert into public.jobs(kind,actor_id,book_id,dedupe_key,checkpoint) values('FILE_IMPORT',actor,target,'add:'||gen_random_uuid(),jsonb_build_object('add',input)) returning id into job;return jsonb_build_object('jobId',job);
 end if;
 raise exception using errcode='22023',message='Unknown manage operation';
end $$;

insert into public.schema_migrations(name,checksum) values ('202610080013_import_pause.sql','41ad78123ad1881b13d473d5b9f1f74764969b71d55b217220a2148f31cf035b');

-- MIGRATION 202610080014_download_runtime.sql SHA256 f95506a5d4e68fe34b10e195f959a12e9eb33302498624efb74945a937c30451
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

insert into public.schema_migrations(name,checksum) values ('202610080014_download_runtime.sql','f95506a5d4e68fe34b10e195f959a12e9eb33302498624efb74945a937c30451');

-- MIGRATION 202610080015_chapter_controls.sql SHA256 b069edcf2af945165160687b127b0047d8df18514b91dd097ee1a7139c4f0cf8
-- Phase 7: distinguish cancelled/skipped chapters from paused errors; staged trash and WEB retry.
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

insert into public.schema_migrations(name,checksum) values ('202610080015_chapter_controls.sql','b069edcf2af945165160687b127b0047d8df18514b91dd097ee1a7139c4f0cf8');

-- MIGRATION 202610080016_monitor_queue.sql SHA256 6f0cfb77deead9d5bf887fb97dabf8520f4980276e467c86f2ed5d0dce654375
-- Phase 7 monitor selects download job rather than add-chapter tasks; bounded bulk reports remaining.
create or replace function public.app_download(actor uuid,operation text,input jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
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
   left join lateral(select * from public.jobs where book_id=bl.id and kind in ('WEB_DOWNLOAD','FILE_IMPORT') and not checkpoint ? 'add' order by created_at desc limit 1) j on true
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
  end loop;return jsonb_build_object('started',result,'remaining',(select count(*) from public.books where deleted_at is null and source_type='WEB' and download_status='ANALYZED'));
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

insert into public.schema_migrations(name,checksum) values ('202610080016_monitor_queue.sql','6f0cfb77deead9d5bf887fb97dabf8520f4980276e467c86f2ed5d0dce654375');

-- MIGRATION 202610080017_manual_url_chapters.sql SHA256 7d1ffbc1e865f1bb974fe2197097809edaa2f697a509b422e60080db2966647a
-- Phase 7: explicit manual URL chapters on FOLDER are allowed; verify alone never schedules network.
create or replace function public.app_download(actor uuid,operation text,input jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
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
   left join lateral(select * from public.jobs where book_id=bl.id and kind in ('WEB_DOWNLOAD','FILE_IMPORT') and not checkpoint ? 'add' order by created_at desc limit 1) j on true
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
  end loop;return jsonb_build_object('started',result,'remaining',(select count(*) from public.books where deleted_at is null and source_type='WEB' and download_status='ANALYZED'));
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
  with ranks as(select q.id,row_number() over(order by q.priority desc,q.created_at,q.id)::int as n from public.jobs q join public.books x on x.id=q.book_id where x.deleted_at is null and (x.source_type='FILE')=(b.source_type='FILE') and x.download_status in ('IDLE','QUEUED') and q.status='queued' and q.kind in ('WEB_DOWNLOAD','FILE_IMPORT'))
  select n into pos from ranks where id=saved_job.id;
  with ranks as(select q.id,row_number() over(order by q.priority desc,q.created_at,q.id)::int as n from public.jobs q join public.books x on x.id=q.book_id where x.deleted_at is null and (x.source_type='FILE')=(b.source_type='FILE') and x.download_status in ('IDLE','QUEUED') and q.status='queued' and q.kind in ('WEB_DOWNLOAD','FILE_IMPORT'))
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
  if b.source_type='FOLDER' and operation<>'verify' and not exists(select 1 from public.jobs where book_id=target and kind='WEB_DOWNLOAD' and checkpoint->>'manualLinks'='true') then raise exception using errcode='22023',message='FOLDER has no download source';end if;
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

insert into public.schema_migrations(name,checksum) values ('202610080017_manual_url_chapters.sql','7d1ffbc1e865f1bb974fe2197097809edaa2f697a509b422e60080db2966647a');

-- MIGRATION 202610080018_legacy_import.sql SHA256 1d69903e229c6f07c694295d2d7ddfb02daa04399a63e739d5f57065152cabe3
-- Phase 8: private ledger. A changed snapshot requires an explicit delta plan.
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

insert into public.schema_migrations(name,checksum) values ('202610080018_legacy_import.sql','1d69903e229c6f07c694295d2d7ddfb02daa04399a63e739d5f57065152cabe3');

-- MIGRATION 202610080019_reader_pagination.sql SHA256 b04f793afedb704edb9637532d4cc06c15611a423b4fb276c09565849d192212
-- Phase 8 load finding: limit the eligible rows before joins/JSON construction.
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

insert into public.schema_migrations(name,checksum) values ('202610080019_reader_pagination.sql','b04f793afedb704edb9637532d4cc06c15611a423b4fb276c09565849d192212');

-- MIGRATION 202610090020_operations.sql SHA256 0175e7a29ebc32ec2db1fbead1137a5ade9556a158f51ba0f26f27e9c0a7deec
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

insert into public.schema_migrations(name,checksum) values ('202610090020_operations.sql','0175e7a29ebc32ec2db1fbead1137a5ade9556a158f51ba0f26f27e9c0a7deec');

-- MIGRATION 202610090021_legacy_reconcile.sql SHA256 aaf1a4d3698fa3bbc75c83561cf0ae676c50ebf00afd6be6743ee6b70ecf6063
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

insert into public.schema_migrations(name,checksum) values ('202610090021_legacy_reconcile.sql','aaf1a4d3698fa3bbc75c83561cf0ae676c50ebf00afd6be6743ee6b70ecf6063');

-- MIGRATION 202610090022_legacy_log_refs.sql SHA256 183e1f0dfb6b56fb8f9ea1a2ac613f8790d6a9721193dfd1045e6d59c2184a5e
create table private.legacy_log_refs(source_key text references private.legacy_imports(source_key),row_index integer,checksum text,primary key(source_key,row_index,checksum));
revoke all on private.legacy_log_refs from public,anon,authenticated,service_role;

insert into public.schema_migrations(name,checksum) values ('202610090022_legacy_log_refs.sql','183e1f0dfb6b56fb8f9ea1a2ac613f8790d6a9721193dfd1045e6d59c2184a5e');

-- MIGRATION 202610090023_operations_receipts.sql SHA256 2902af6037843633793a9efc413ddc47dd8505031dcb2aa2e43381adfff5efdf
-- Correct record/alias ambiguity and permit replay of completed receipts after revision advances.
create or replace function public.app_operations(actor uuid,operation text,input jsonb default '{}') returns jsonb
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
    'migrationReview',(select count(*) from private.legacy_book_review lr join public.books b on b.id=lr.book_id where lr.reviewed_at is null and b.deleted_at is null)))
   from private.runtime_control where singleton);
 end if;
 if not pg_try_advisory_xact_lock(610090001) then raise exception using errcode='40001',message='Writer still active';end if;
 select * into control from private.runtime_control where singleton for update;
 if operation='maintenance' then
  if jsonb_typeof(input->'enabled') is distinct from 'boolean' then raise exception using errcode='22023',message='Boolean required';end if;
  update private.runtime_control set maintenance=(input->>'enabled')::boolean,revision=revision+1,updated_at=now() where singleton;
 elsif operation='root-prepare' then
  if not control.maintenance then raise exception using errcode='55000',message='Maintenance required';end if;
  select * into r from private.root_requests where id=(input->>'requestId')::uuid;
  if found then
   if r.actor_id<>actor or r.request is distinct from input-'revision' then raise exception using errcode='40001',message='Request conflict';end if;
   if r.status='done' then return jsonb_build_object('repeated',true,'rootId',r.root_id);end if;
   raise exception using errcode='55000',message='Root request needs reconciliation';
  end if;
  if (input->>'revision')::bigint is distinct from control.revision then raise exception using errcode='40001',message='Revision changed';end if;
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

insert into public.schema_migrations(name,checksum) values ('202610090023_operations_receipts.sql','2902af6037843633793a9efc413ddc47dd8505031dcb2aa2e43381adfff5efdf');

revoke all on public.schema_migrations from public,anon,authenticated,service_role;
commit;

-- Expected: migration_count = 23, profiles/books/maintenance_table populated.
select
 (select count(*) from public.schema_migrations) as migration_count,
 to_regclass('public.profiles') as profiles,
 to_regclass('public.books') as books,
 to_regclass('private.runtime_control') as maintenance_table;

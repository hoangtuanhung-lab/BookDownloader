-- Phase 1. PostgreSQL 17 / Supabase. No real users or content are seeded.
-- Supabase provides auth.users/auth.uid; local-only equivalents live in tools/dev.
begin;
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
commit;

-- Local ONLY: model auth columns owned by Supabase in cloud.
alter table auth.users add column if not exists email text;
alter table auth.users add column if not exists raw_app_meta_data jsonb not null default '{}';
alter table auth.users add column if not exists raw_user_meta_data jsonb not null default '{}';
alter table auth.users add column if not exists email_confirmed_at timestamptz;
create table if not exists auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id) on delete cascade,not_after timestamptz);

begin;
create table private.legacy_log_refs(source_key text references private.legacy_imports(source_key),row_index integer,checksum text,primary key(source_key,row_index,checksum));
revoke all on private.legacy_log_refs from public,anon,authenticated,service_role;
commit;

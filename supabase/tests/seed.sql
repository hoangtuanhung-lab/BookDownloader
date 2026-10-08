-- Synthetic identities/content; runner always rolls this transaction back.
insert into auth.users(id) select ('00000000-0000-4000-8000-00000000000'||n)::uuid from generate_series(1,6) n;
insert into public.profiles(id,display_name,status) select id,'Synthetic user',case when id::text like '%6' then 'blocked' else 'active' end from auth.users where id::text like '00000000-0000-4000-8000-00000000000%' on conflict(id) do update set display_name=excluded.display_name,status=excluded.status;
delete from public.user_permissions where user_id::text like '00000000-0000-4000-8000-00000000000%';
insert into public.user_permissions(user_id,permission) values
 ('00000000-0000-4000-8000-000000000001','read'),('00000000-0000-4000-8000-000000000002','read'),
 ('00000000-0000-4000-8000-000000000003','download'),('00000000-0000-4000-8000-000000000004','manage'),
 ('00000000-0000-4000-8000-000000000004','read'),('00000000-0000-4000-8000-000000000005','admin'),('00000000-0000-4000-8000-000000000006','read');
insert into public.books(id,name,normalized_name,source_type,visibility,deleted_at) values
 ('10000000-0000-4000-8000-000000000001','Published sample','published sample','FILE','published',null),
 ('10000000-0000-4000-8000-000000000002','Hidden sample','hidden sample','FOLDER','hidden',null),
 ('10000000-0000-4000-8000-000000000003','Deleted sample','deleted sample','FILE','published',now());
insert into public.chapters(id,book_id,legacy_order,order_key,display_number,status,is_skipped) values
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',-999998.5,-999998.5,'1-2','DONE',false),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',2,2,'*','ERROR',false),
 ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002',1,1,'1','DONE',false),
 ('20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001',3,3,'3','DONE',true);
insert into public.reader_preferences(user_id) values ('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');

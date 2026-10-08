begin;
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
commit;

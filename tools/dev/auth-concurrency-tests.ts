import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localPool} from '../../packages/infrastructure/src/database';
import {migrate} from './migrate';
const original=process.env.DATABASE_URL||'postgresql://postgres:local-only-password@127.0.0.1:55432/bookdownloader';
const admin=localPool(original),name='book_auth_test_'+randomUUID().replaceAll('-','');
const isolated=new URL(original);isolated.pathname='/'+name;
let pool:ReturnType<typeof localPool>|undefined;
try{
 await admin.query('create database '+name);
 process.env.DATABASE_URL=isolated.href;await migrate();pool=localPool(isolated.href);
 const ids=['60000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000002'];
 for(const id of ids){await pool.query("insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data) values($1,'synthetic@gmail.com',now(),'{\"provider\":\"google\"}')",[id]);await pool.query("insert into public.user_permissions(user_id,permission) values($1,'admin')",[id]);}
 const first=await pool.connect(),second=await pool.connect();
 try{
  await first.query('begin');await second.query('begin');await first.query('set local role service_role');await second.query('set local role service_role');
  const secondPid=(await second.query('select pg_backend_pid() as id')).rows[0].id;
  await first.query('select public.app_admin_update($1,$1,$2,$3)',[ids[0],['read'],'active']);
  const pending=second.query('select public.app_admin_update($1,$1,$2,$3)',[ids[1],['read'],'active']).then(()=>({code:'unexpected_success'}),(error:{code:string})=>error);
  let waiting=false;
  for(let attempt=0;attempt<50&&!waiting;attempt++){waiting=(await pool.query("select exists(select 1 from pg_locks where pid=$1 and locktype='advisory' and not granted) as waiting",[secondPid])).rows[0].waiting;if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));}
  assert(waiting,'Second permission mutation must serialize behind first transaction');
  await first.query('commit');assert.equal((await pending).code,'23514');await second.query('rollback');
  assert.equal((await pool.query("select count(*)::int as n from public.user_permissions u join public.profiles p on p.id=u.user_id where u.permission='admin' and p.status='active'")).rows[0].n,1);
  console.log('PASS concurrent self-demotions serialize and preserve last active admin (1/1).');
 }finally{await first.query('rollback');await second.query('rollback');first.release();second.release();}
}finally{process.env.DATABASE_URL=original;await pool?.end();await admin.query('drop database if exists '+name);await admin.end();}

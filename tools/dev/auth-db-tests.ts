import assert from 'node:assert/strict';
import {localPool} from '../../packages/infrastructure/src/database';
import {migrate} from './migrate';
import {handleApi} from '../../netlify/functions/api';
import {AppError,type Permission} from '../../packages/contracts/src/index';
import type {AuthServices} from '../../packages/infrastructure/src/auth';
await migrate();
const pool=localPool(process.env.DATABASE_URL||'postgresql://postgres:local-only-password@127.0.0.1:55432/bookdownloader'),db=await pool.connect();
const uid=(n:number)=>`30000000-0000-4000-8000-00000000000${n}`,book='40000000-0000-4000-8000-000000000001',chapter='50000000-0000-4000-8000-000000000001';
let passed=0;
async function check(name:string,fn:()=>Promise<void>){await fn();passed++;console.log('PASS '+name);}
async function deny(sql:string,args:unknown[]=[],code='42501'){await db.query('savepoint denial');let error:any;try{await db.query(sql,args);}catch(e){error=e;}await db.query('rollback to savepoint denial');assert.equal(error?.code,code);}
async function role(name:string,n=1){await db.query('reset role');await db.query(`set local role ${name}`);await db.query("select set_config('request.jwt.claim.sub',$1,true)",[uid(n)]);}
const origin='https://app.test';
function service(n:number):AuthServices{return {
 async verify(token){if(token!=='verified-'+n)throw new AppError('UNAUTHENTICATED',401,'Invalid token');return {id:uid(n),email:'synthetic@gmail.com',email_confirmed_at:'2026-10-08',app_metadata:{provider:'google'}};},
 async rpc(name,args){const calls:Record<string,string>={app_me:'select public.app_me($1) as value',app_admin_users:'select public.app_admin_users($1,$2) as value',app_admin_update:'select public.app_admin_update($1,$2,$3,$4) as value',app_preferences:'select public.app_preferences($1,$2) as value',app_progress:'select public.app_progress($1,$2,$3) as value'};
 const params:Record<string,unknown[]>={app_me:[args.actor],app_admin_users:[args.actor,args.after_id],app_admin_update:[args.actor,args.target,args.permissions,args.account_status],app_preferences:[args.actor,args.new_value],app_progress:[args.actor,args.target_book,args.new_value]};
 await db.query('savepoint rpc_call');try{return (await db.query(calls[name],params[name])).rows[0].value;}catch(e:any){await db.query('rollback to savepoint rpc_call');const status=e.code==='42501'?403:e.code==='P0002'?404:['40001','23514'].includes(e.code)?409:500;throw new AppError('RPC_REJECTED',status,'Rejected');}
 }};}
async function api(n:number,path:string,method='GET',body?:unknown){return handleApi(new Request(origin+'/api'+path,{method,headers:{Authorization:'Bearer verified-'+n,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),{APP_ORIGINS:origin},undefined,service(n));}
try{
 await db.query('begin');
 for(let n=1;n<=6;n++)await db.query("insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values($1,$2,now(),$3,$4)",[uid(n),'synthetic'+n+'@gmail.com',{provider:'google'},{full_name:'Synthetic '+n}]);
 await check('new user gets one profile/read, no first-login admin',async()=>{assert.equal((await db.query('select count(*)::int as n from public.profiles where id=$1',[uid(1)])).rows[0].n,1);assert.deepEqual((await db.query('select permission from public.user_permissions where user_id=$1',[uid(1)])).rows,[{permission:'read'}]);});
 await role('authenticated');
 await check('browser cannot call actor-based or bootstrap RPCs',async()=>{for(const sql of ['select public.app_me($1)','select public.bootstrap_admin($1)','select public.app_admin_users($1)','select public.app_progress($1,$1)','select public.app_preferences($1)'])await deny(sql,[uid(1)]);});
 await role('service_role');
 await check('retained/revoked/expired sessions rejected in SQL',async()=>{
  assert.equal((await db.query('select public.app_session_active($1,$2) as active',[uid(1),uid(2)])).rows[0].active,false);
  await role('postgres');await db.query("insert into auth.sessions(id,user_id,not_after) values($1,$2,now()+interval '1 hour')",[uid(2),uid(1)]);await role('service_role');
  assert.equal((await db.query('select public.app_session_active($1,$2) as active',[uid(1),uid(2)])).rows[0].active,true);
  assert.equal((await db.query('select public.app_session_active($1,$2) as active',[uid(2),uid(2)])).rows[0].active,false);
  await role('postgres');await db.query("update auth.sessions set not_after=now()-interval '1 hour' where id=$1",[uid(2)]);await role('service_role');
  assert.equal((await db.query('select public.app_session_active($1,$2) as active',[uid(1),uid(2)])).rows[0].active,false);
 });
 await check('owner bootstrap is explicit and audited',async()=>{await db.query('select public.bootstrap_admin($1)',[uid(1)]);assert.equal((await db.query("select count(*)::int as n from public.audit_logs where action='bootstrap_admin' and entity_id=$1",[uid(1)])).rows[0].n,1);});
 await check('bootstrap cannot run twice or select another owner',async()=>{await deny('select public.bootstrap_admin($1)',[uid(1)],'23505');await deny('select public.bootstrap_admin($1)',[uid(2)],'23505');});
 await check('reader self-elevation blocked at SQL RPC',()=>deny('select public.app_admin_update($1,$2,$3,$4)',[uid(2),uid(2),['admin'],'active']));
 await check('last admin cannot be demoted/blocked',async()=>{await deny('select public.app_admin_update($1,$2,$3,$4)',[uid(1),uid(1),['read'],'active'],'23514');await deny('select public.app_admin_update($1,$2,$3,$4)',[uid(1),uid(1),['admin'],'blocked'],'23514');});
 await check('admin grants independent permissions with audit',async()=>{await db.query('select public.app_admin_update($1,$2,$3,$4)',[uid(1),uid(3),['download'],'active']);await db.query('select public.app_admin_update($1,$2,$3,$4)',[uid(1),uid(4),['manage'],'active']);assert.deepEqual((await db.query('select public.app_me($1) as value',[uid(3)])).rows[0].value.permissions,['download']);});
 await check('blocked user fails app_me',async()=>{await db.query('select public.app_admin_update($1,$2,$3,$4)',[uid(1),uid(6),['read'],'blocked']);await deny('select public.app_me($1)',[uid(6)]);});
 await check('revoked read not regenerated at subsequent login/me',async()=>{await db.query('select public.app_admin_update($1,$2,$3,$4)',[uid(1),uid(5),[],'active']);assert.deepEqual((await db.query('select public.app_me($1) as value',[uid(5)])).rows[0].value.permissions,[]);});
 await role('postgres');await db.query("insert into public.books(id,name,normalized_name,source_type,visibility) values($1,'Auth fixture','auth fixture','FILE','published')",[book]);await db.query("insert into public.chapters(id,book_id,legacy_order,order_key,status) values($1,$2,1,1,'DONE')",[chapter,book]);await role('service_role');
 const prefs={font:'Literata',fontSize:22,theme:'night',blueFilter:0.5,mode:'continuous'};
 await check('API backed by real SQL reads/writes own preferences',async()=>{assert.equal((await api(2,'/me/preferences','PUT',prefs)).status,200);assert.deepEqual(await (await api(2,'/me/preferences')).json(),prefs);assert.equal(await (await api(1,'/me/preferences')).json(),null);});
 await check('progress revisions and server timestamps enforce conflict',async()=>{const value={chapterId:chapter,ratio:0.4,scrollPosition:12,expectedRevision:0};const first=await api(2,'/me/progress/'+book,'PUT',value);assert.equal(first.status,200);const data=await first.json();assert.equal(data.revision,1);assert(data.updatedAt);assert.equal((await api(2,'/me/progress/'+book,'PUT',value)).status,409);assert.equal(await (await api(1,'/me/progress/'+book)).json(),null);assert.equal((await api(2,'/me/progress/'+book,'PUT',{...value,expectedRevision:1})).status,200);});
 await check('API direct admin request by reader/download/manage denied',async()=>{for(const n of [2,3,4])assert.equal((await api(n,'/admin/users')).status,403);});
 await check('admin API grants permissions transactionally',async()=>{assert.equal((await api(1,'/admin/users/'+uid(4),'PUT',{permissions:['read','manage'],status:'active'})).status,200);assert.deepEqual((await (await api(4,'/me')).json()).permissions,['read','manage']);});
 await check('blocked/revoked users rejected across API and RLS',async()=>{assert.equal((await api(6,'/me')).status,403);assert.equal((await api(5,'/books')).status,403);await role('authenticated',6);assert.equal((await db.query('select id from public.books')).rowCount,0);await role('service_role');});
 await check('download-only cannot read preferences or library',async()=>{assert.equal((await api(3,'/me/preferences')).status,403);assert.equal((await api(3,'/books')).status,403);assert.equal((await api(3,'/download')).status,501);});
 await check('changing publication immediately hides stored progress',async()=>{await db.query("update public.books set visibility='hidden' where id=$1",[book]);assert.equal((await api(2,'/me/progress/'+book)).status,404);await role('authenticated',2);assert.equal((await db.query('select * from public.reading_progress')).rowCount,0);await role('service_role');});
 console.log(`Auth SQL/API: ${passed} passed; all synthetic data rolled back.`);
}finally{await db.query('rollback');db.release();await pool.end();}

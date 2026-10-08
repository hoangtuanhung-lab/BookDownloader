import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {localPool} from '../../packages/infrastructure/src/database';
import {migrate} from './migrate';
await migrate();
const pool=localPool(process.env.DATABASE_URL || 'postgresql://postgres:local-only-password@127.0.0.1:55432/bookdownloader'),db=await pool.connect();
let passed=0;
const user=(n:number)=>`00000000-0000-4000-8000-00000000000${n}`;
const book=(n:number)=>`10000000-0000-4000-8000-00000000000${n}`;
const chapter=(n:number)=>`20000000-0000-4000-8000-00000000000${n}`;
async function role(name:string,n?:number) {await db.query('reset role');await db.query(`set local role ${name}`);await db.query("select set_config('request.jwt.claim.sub',$1,true)",[n?user(n):'']);}
async function check(name:string,fn:()=>Promise<void>) {await fn();passed++;console.log('PASS '+name);}
async function deny(sql:string,args:unknown[]=[],code='42501') {
 await db.query('savepoint expected_denial');
 let error:unknown;
 try {await db.query(sql,args);} catch(e){error=e;}
 await db.query('rollback to savepoint expected_denial');
 assert.equal((error as {code:string})?.code,code,'Query must be rejected');
}
try {
 await db.query('begin');await db.query(await readFile('supabase/tests/seed.sql','utf8'));
 await check('all 20 application tables enable RLS',async()=>{
  const rows=(await db.query("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind='r' and relname<>'schema_migrations'")).rows;
  assert.equal(rows.length,20);assert(rows.every(r=>r.relrowsecurity));
 });
 await role('anon');
 await check('anonymous cannot read library',()=>deny('select id from public.books'));
 await check('anonymous cannot call database health RPC',()=>deny('select public.app_health()'));
 await role('authenticated',1);
 await check('reader sees published live book only',async()=>assert.deepEqual((await db.query('select id from public.books order by id')).rows,[{id:book(1)}]));
 await check('reader cannot read hidden chapter by direct UUID',async()=>assert.equal((await db.query('select id from public.chapters where id=$1',[chapter(3)])).rowCount,0));
 await check('reader excludes errored/skipped chapters',async()=>assert.deepEqual((await db.query('select id from public.chapters order by id')).rows,[{id:chapter(1)}]));
 await check('reader cannot select source URLs/Drive IDs',async()=>{await deny('select source_url from public.books');await deny('select file_id from public.chapters');});
 await check('reader cannot change books/publication',()=>deny("update public.books set visibility='published' where id=$1",[book(2)]));
 await check('reader cannot grant own admin',()=>deny('insert into public.user_permissions values($1,\'admin\')',[user(1)]));
 await check('reader cannot access internal tables',async()=>{for(const name of ['jobs','job_items','site_credentials','app_settings','site_rules','drive_resources','outbox_operations','audit_logs','removed_chapters','migration_runs','migration_items'])await deny('select * from public.'+name);});
 await check('preferences isolate each user',async()=>assert.deepEqual((await db.query('select user_id from public.reader_preferences')).rows,[{user_id:user(1)}]));
 await check('cross-user preference write denied',()=>deny('insert into public.reader_preferences(user_id) values($1)',[user(3)]));
 await check('direct preference updates denied',()=>deny("update public.reader_preferences set theme='night' where user_id=$1",[user(2)]));
 await check('own progress insert succeeds',async()=>{await deny('insert into public.reading_progress(user_id,book_id) values($1,$2)',[user(1),book(1)]);await role('service_role');await db.query('select public.app_progress($1,$2,$3)',[user(1),book(1),{chapterId:chapter(1),ratio:0.5,scrollPosition:0,expectedRevision:0}]);await role('authenticated',1);assert.equal((await db.query('select ratio from public.reading_progress')).rows[0].ratio,'0.5');});
 await check('hidden/errored/skipped chapter progress denied',async()=>{for(const [b,c] of [[2,3],[1,2],[1,4]]) await deny('insert into public.reading_progress(user_id,book_id,chapter_id) values($1,$2,$3) on conflict(user_id,book_id) do update set chapter_id=excluded.chapter_id',[user(1),book(b),chapter(c)]);});
 await role('authenticated',2);
 await check('second reader cannot see first progress',async()=>assert.equal((await db.query('select * from public.reading_progress')).rowCount,0));
 await check('second reader cannot write first progress',()=>deny('insert into public.reading_progress(user_id,book_id) values($1,$2)',[user(1),book(1)]));
 await role('authenticated',3);
 await check('download-only has no reader access',async()=>assert.equal((await db.query('select id from public.books')).rowCount,0));
 await role('authenticated',4);
 await check('manage+read sees hidden/live books',async()=>assert.equal((await db.query('select id from public.books')).rowCount,2));
 await role('authenticated',5);
 await check('admin still cannot self-write browser grants',()=>deny('insert into public.user_permissions values($1,\'manage\')',[user(5)]));
 await check('admin sees hidden but not deleted',async()=>assert.equal((await db.query('select id from public.books')).rowCount,2));
 await role('authenticated',6);
 await check('blocked account loses read and preferences',async()=>{assert.equal((await db.query('select id from public.books')).rowCount,0);await deny('insert into public.reader_preferences(user_id) values($1)',[user(6)]);});
 await role('service_role');
 await check('service role health RPC accesses DB',async()=>assert.equal((await db.query('select public.app_health() as result')).rows[0].result,1));
 await check('service role has expected full library access',async()=>assert.equal((await db.query('select id from public.books')).rowCount,3));
 await role('postgres');
 await check('legacy fractional negative order/display survives SQL',async()=>assert.deepEqual((await db.query('select legacy_order,display_number from public.chapters where id=$1',[chapter(1)])).rows[0],{legacy_order:'-999998.5',display_number:'1-2'}));
 await check('book/chapter mismatch rejected by composite FK',()=>deny('insert into public.reading_progress(user_id,book_id,chapter_id) values($1,$2,$3)',[user(2),book(2),chapter(1)],'23503'));
 await check('duplicate live normalized name rejected',()=>deny("insert into public.books(name,normalized_name,source_type) values('duplicate','published sample','FILE')",[],'23505'));
 await check('progress ratio bounded',()=>deny('insert into public.reading_progress(user_id,book_id,ratio) values($1,$2,1.1)',[user(2),book(1)],'23514'));
 await check('active lease requires owner/deadline',()=>deny("insert into public.jobs(kind,dedupe_key,status) values('ANALYZE','synthetic','running')",[],'23514'));
 console.log(`SQL/RLS: ${passed} passed; synthetic seed rolled back.`);
} finally {await db.query('rollback');db.release();await pool.end();}

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localPool} from '../../packages/infrastructure/src/database';
import {migrate} from './migrate';
import {handleApi} from '../../netlify/functions/api';
import {syncBookInfo} from '../../packages/infrastructure/src/library-writer';
import {AppError} from '../../packages/contracts/src/index';
import type {AuthServices} from '../../packages/infrastructure/src/auth';
import {fixture} from '../../tests/phase-3/drive-fixture';
const original=process.env.DATABASE_URL||'postgresql://postgres:local-only-password@127.0.0.1:55432/bookdownloader';
const admin=localPool(original),name='book_storage_test_'+randomUUID().replaceAll('-',''),url=new URL(original);url.pathname='/'+name;
const actor='80000000-0000-4000-8000-000000000001',book='80000000-0000-4000-8000-000000000002',chapter='80000000-0000-4000-8000-000000000003',other='80000000-0000-4000-8000-000000000004';
let pool:ReturnType<typeof localPool>|undefined;let passed=0;
async function check(label:string,fn:()=>Promise<void>){await fn();passed++;console.log('PASS '+label);}
try{
 await admin.query('create database '+name);process.env.DATABASE_URL=url.href;await migrate();pool=localPool(url.href);const db=await pool.connect();
 try{
  await db.query("insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data) values($1,'synthetic@gmail.com',now(),'{\"provider\":\"google\"}')",[actor]);
  await db.query("insert into public.books(id,name,normalized_name,source_type,visibility,folder_id) values($1,'Truyện mẫu','truyen mau','FILE','published','book'),($2,'Khác','khac','FILE','published','other')",[book,other]);
  const f=fixture();const file=await f.drive.putText('book','Chương 001.txt','Truyện mẫu\n\nChương 001: Khởi đầu\n\nNội dung chương mẫu kiểm thử local.',1);
  await db.query("insert into public.chapters(id,book_id,legacy_order,order_key,status,file_id) values($1,$2,1,1,'DONE',$3)",[chapter,book,file]);
  await db.query("insert into public.drive_resources(file_id,book_id,chapter_id,owner_subject,kind,metadata_version,sync_status) values($1,$2,$3,'synthetic-owner','CHAPTER',1,'synced')",[file,book,chapter]);
  const services:AuthServices={async verify(){return {id:actor,email:'synthetic@gmail.com',email_confirmed_at:'2026-10-08',app_metadata:{provider:'google'}};},async rpc(rpc,args){const params:Record<string,unknown[]>={app_me:[args.actor],app_reader_resource:[args.actor,args.target_book,args.target_chapter],app_reader_cache:[args.actor,args.target_book,args.target_chapter,args.expected_key,args.new_value]};const sql:Record<string,string>={app_me:'select public.app_me($1) as value',app_reader_resource:'select public.app_reader_resource($1,$2,$3) as value',app_reader_cache:'select public.app_reader_cache($1,$2,$3,$4,$5) as value'};try{return (await db.query(sql[rpc],params[rpc])).rows[0].value;}catch(error:any){throw new AppError('RPC_REJECTED',error.code==='42501'?403:error.code==='P0002'?404:error.code==='40001'?409:500,'Rejected');}}};
  const api=(target=book)=>handleApi(new Request(`https://app.test/api/books/${target}/chapters/${chapter}/content`,{headers:{Authorization:'Bearer synthetic'}}),{},undefined,services,f.drive);
  await check('API reads synthetic chapter through SQL authorization + Drive adapter',async()=>{const response=await api();assert.equal(response.status,200);assert.deepEqual(await response.json(),{text:'Nội dung chương mẫu kiểm thử local.',title:'Khởi đầu'});});
  await check('cache persists in database across a separate connection',async()=>{const next=await pool!.query('select public.app_reader_resource($1,$2,$3) as value',[actor,book,chapter]);assert.equal(next.rows[0].value.cached.text,'Nội dung chương mẫu kiểm thử local.');const requests=f.calls.length;assert.equal((await api()).status,200);assert.equal(f.calls.length,requests);});
  await check('cross-book chapter rejected before Drive/cache',async()=>{const requests=f.calls.length;assert.equal((await api(other)).status,404);assert.equal(f.calls.length,requests);});
  await check('hiding book denies even a populated cache',async()=>{await db.query("update public.books set visibility='hidden' where id=$1",[book]);assert.equal((await api()).status,404);await db.query("update public.books set visibility='published' where id=$1",[book]);});
  await check('revoked read denies even a populated cache',async()=>{await db.query('delete from public.user_permissions where user_id=$1',[actor]);assert.equal((await api()).status,403);await db.query("insert into public.user_permissions values($1,'read')",[actor]);});
  await check('skipped chapter and missing mapping deny access',async()=>{await db.query('update public.chapters set is_skipped=true where id=$1',[chapter]);assert.equal((await api()).status,404);await db.query('update public.chapters set is_skipped=false where id=$1',[chapter]);await db.query("update public.drive_resources set sync_status='error' where file_id=$1",[file]);assert.equal((await api()).status,404);await db.query("update public.drive_resources set sync_status='synced' where file_id=$1",[file]);});
  await check('content version invalidates stored cache',async()=>{await db.query('update public.chapters set content_version=2 where id=$1',[chapter]);const resource=(await db.query('select public.app_reader_resource($1,$2,$3) as value',[actor,book,chapter])).rows[0].value;assert.equal(resource.cached,null);assert.equal((await api()).status,200);});
  await check('browser roles cannot call actor RPCs or inspect cache',async()=>{await db.query('set role authenticated');for(const sql of ['select public.app_reader_resource($1,$2,$3)','select public.app_reader_cache($1,$2,$3,null,null)'])await assert.rejects(db.query(sql,[actor,book,chapter]),{code:'42501'});await assert.rejects(db.query('select * from private.reader_cache'),{code:'42501'});await db.query('reset role');});
  await check('invalid cache payload is rejected by SQL',async()=>{const resource=(await db.query('select public.app_reader_resource($1,$2,$3) as value',[actor,book,chapter])).rows[0].value;await assert.rejects(db.query('select public.app_reader_cache($1,$2,$3,$4,$5)',[actor,book,chapter,resource.cacheKey,{}]),{code:'22023'});});
  await check('global cache byte cap evicts old entries; individual cap bypasses oversized content',async()=>{await db.query('delete from private.reader_cache');await db.query("insert into private.reader_cache select 'old-'||n,jsonb_build_object('text',repeat('x',59000),'title',''),59030,now()+interval '1 hour',now()-interval '1 hour' from generate_series(1,135) n");const resource=(await db.query('select public.app_reader_resource($1,$2,$3) as value',[actor,book,chapter])).rows[0].value;await db.query('select public.app_reader_cache($1,$2,$3,$4,$5)',[actor,book,chapter,resource.cacheKey,{text:'x'.repeat(59000),title:''}]);assert(Number((await db.query('select sum(bytes) as total from private.reader_cache')).rows[0].total)<=8_000_000);assert.equal((await db.query("select count(*)::int n from private.reader_cache where cache_key='old-1'")).rows[0].n,0);await db.query('select public.app_reader_cache($1,$2,$3,$4,$5)',[actor,book,chapter,resource.cacheKey,{text:'x'.repeat(60001),title:''}]);assert.equal((await db.query('select payload from private.reader_cache where cache_key=$1',[resource.cacheKey])).rows[0].payload.text.length,59000);});
  await check('info write records durable ID and repeat does not create duplicate',async()=>{const first=await syncBookInfo(db,f.drive,book,1,'synthetic-owner');const second=await syncBookInfo(db,f.drive,book,1,'synthetic-owner');assert.equal(first,second);assert.equal((await db.query("select count(*)::int n from public.drive_resources where book_id=$1 and kind='INFO'",[book])).rows[0].n,1);});
  await check('stale metadata cannot overwrite newer book; Drive failure rolls back success marker',async()=>{await db.query('update public.books set version=2 where id=$1',[book]);await assert.rejects(syncBookInfo(db,f.drive,book,1,'synthetic-owner'),{code:'CONFLICT'});f.faults.push({status:403});await assert.rejects(syncBookInfo(db,f.drive,book,2,'synthetic-owner'),{code:'DRIVE_FORBIDDEN'});assert.equal(Number((await db.query("select metadata_version from public.drive_resources where book_id=$1 and kind='INFO'",[book])).rows[0].metadata_version),1);});
  await check('concurrent info writes serialize in database and create one singleton',async()=>{
   let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
   const originalPut=f.drive.putText.bind(f.drive);let firstCall=true;f.drive.putText=async(...args)=>{if(firstCall){firstCall=false;entered();await gate;}return originalPut(...args);};
   const second=await pool!.connect();try{
    const first=syncBookInfo(db,f.drive,book,2,'synthetic-owner');await started;
    const pid=(await second.query('select pg_backend_pid() as id')).rows[0].id;
    const pending=syncBookInfo(second,f.drive,book,2,'synthetic-owner');let waiting=false;
    for(let n=0;n<50&&!waiting;n++){waiting=(await pool!.query('select exists(select 1 from pg_locks where pid=$1 and not granted) as waiting',[pid])).rows[0].waiting;if(!waiting)await new Promise(r=>setTimeout(r,10));}
    assert(waiting);release();const ids=await Promise.all([first,pending]);assert.equal(ids[0],ids[1]);assert.equal([...f.files.values()].filter(file=>file.name==='info.txt').length,1);
   }finally{release();f.drive.putText=originalPut;second.release();}
  });
  await check('cleaning settings change invalidates cache and preserves legacy junk filtering',async()=>{
   await db.query("insert into public.app_settings(key,value) values('JUNK_WORDS',$1)",[JSON.stringify('kiểm thử local')]);
   const resource=(await db.query('select public.app_reader_resource($1,$2,$3) as value',[actor,book,chapter])).rows[0].value;
   assert.equal(resource.cached,null);assert.equal(resource.junkWords,'kiểm thử local');assert.equal((await api()).status,200);
  });
  console.log(`Storage SQL/API: ${passed} passed; isolated synthetic database removed.`);
 }finally{db.release();}
}finally{process.env.DATABASE_URL=original;await pool?.end();await admin.query('drop database if exists '+name);await admin.end();}

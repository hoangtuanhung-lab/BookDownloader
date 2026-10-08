import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { localPool } from '../../packages/infrastructure/src/database';
// Deliberately local-only. Production migrations are reviewed separately.
export async function migrate() {
 const pool=localPool(process.env.DATABASE_URL || 'postgresql://postgres:local-only-password@127.0.0.1:55432/bookdownloader');
 const db=await pool.connect();
 try {
  await db.query("select pg_advisory_lock(610080001)");
  if (!(await db.query("select to_regclass('auth.users') as name")).rows[0].name) await db.query(await readFile('tools/dev/local-auth.sql','utf8'));
  await db.query('create table if not exists public.schema_migrations(name text primary key, checksum text not null, applied_at timestamptz not null default now())');
  await db.query('revoke all on public.schema_migrations from public,anon,authenticated');
  for(const name of (await readdir('supabase/migrations')).filter(n=>n.endsWith('.sql')).sort()) {
   const sql=await readFile('supabase/migrations/'+name,'utf8'),checksum=createHash('sha256').update(sql).digest('hex');
   const prior=(await db.query('select checksum from public.schema_migrations where name=$1',[name])).rows[0];
   if(prior) {if(prior.checksum!==checksum)throw new Error('Applied migration checksum changed: '+name);continue;}
   // File transaction and ledger are one atomic transaction.
   await db.query('begin');
   await db.query(sql.replace(/^begin;$/m,'').replace(/^commit;$/m,''));
   await db.query('insert into public.schema_migrations(name,checksum) values($1,$2)',[name,checksum]);
   await db.query('commit');
   console.log('Applied '+name);
  }
 } catch(error) {await db.query('rollback');throw error;}
 finally {await db.query('select pg_advisory_unlock(610080001)');db.release();await pool.end();}
}
if (process.argv[1]?.endsWith('migrate.ts')) migrate().catch(()=>{console.error('Local migration failed. Check database/migration; no connection details logged.');process.exitCode=1;});

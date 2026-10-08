import {localPool} from './database';
export async function checkDatabase(env:NodeJS.ProcessEnv):Promise<void> {
 if(env.APP_ENV==='local') {
  if(!env.DATABASE_URL) throw new Error('Missing local database');
  const pool=localPool(env.DATABASE_URL);
  try {await pool.query('select public.app_health()');} finally {await pool.end();}
  return;
 }
 if(!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing staging database config');
 const base=new URL(env.SUPABASE_URL);
 if(base.protocol!=='https:') throw new Error('HTTPS required');
 const result=await fetch(new URL('/rest/v1/rpc/app_health',base),{
  method:'POST',signal:AbortSignal.timeout(3000),headers:{'apikey':env.SUPABASE_SERVICE_ROLE_KEY,'Authorization':'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json'},body:'{}'
 });
 if(!result.ok || await result.json()!==1) throw new Error('Database health unavailable');
}

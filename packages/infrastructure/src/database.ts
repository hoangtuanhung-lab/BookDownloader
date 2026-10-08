import pg from 'pg';
export function localPool(url:string):pg.Pool {
  const parsed=new URL(url);
  if (!['127.0.0.1','localhost','db'].includes(parsed.hostname)) throw new Error('Local SQL runner refuses remote database');
  return new pg.Pool({connectionString:url,max:3,connectionTimeoutMillis:3000,statement_timeout:5000});
}

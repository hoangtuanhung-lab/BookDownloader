import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthServices} from '../../packages/infrastructure/src/auth';
const env={SUPABASE_URL:'https://auth.test',SUPABASE_SERVICE_ROLE_KEY:'server-secret-sentinel'};
const claims={sub:'00000000-0000-4000-8000-000000000001',session_id:'00000000-0000-4000-8000-000000000002',exp:Math.floor(Date.now()/1000)+3600,iss:'https://auth.test/auth/v1',role:'authenticated',aud:'authenticated'};
const token='fixture.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.signature';
const identity={id:'00000000-0000-4000-8000-000000000001',email:'sample@gmail.com',email_confirmed_at:'2026-10-08',app_metadata:{provider:'google'}};
test('server verifies bearer through Auth endpoint, not client claims',async(t)=>{
 const requests:Request[]=[];t.mock.method(globalThis,'fetch',async(input:any,init:any)=>{requests.push(new Request(input,init));return Response.json(requests.length===1?identity:true);});
 assert.deepEqual(await createAuthServices(env).verify(token),identity);
 assert.equal(requests[0].url,'https://auth.test/auth/v1/user');assert.equal(requests[0].headers.get('authorization'),'Bearer '+token);assert.equal(requests[0].headers.get('apikey'),'server-secret-sentinel');
});
test('Auth rejects invalid/expired session; no metadata decoder fallback',async(t)=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({message:'bad token'},{status:401}));await assert.rejects(createAuthServices(env).verify('forged'),{status:401});
});
test('only confirmed Google identities accepted',async(t)=>{
 let value:any={...identity,app_metadata:{provider:'email'}};
 t.mock.method(globalThis,'fetch',async()=>Response.json(value));await assert.rejects(createAuthServices(env).verify('token'),{status:403});
 value={...identity,email_confirmed_at:null};await assert.rejects(createAuthServices(env).verify('token'),{status:403});
});
test('RPC uses server role and maps denial/conflict without raw error',async(t)=>{
 const requests:Request[]=[];let code='42501';t.mock.method(globalThis,'fetch',async(input:any,init:any)=>{requests.push(new Request(input,init));return Response.json({code,message:'DO_NOT_EXPOSE password'},{status:400});});
 await assert.rejects(createAuthServices(env).rpc('app_me',{actor:identity.id}),(e:any)=>e.status===403&&!e.message.includes('DO_NOT_EXPOSE'));
 assert.equal(requests[0].headers.get('authorization'),'Bearer server-secret-sentinel');
 code='40001';await assert.rejects(createAuthServices(env).rpc('app_progress',{}),{status:409});
});
test('network failure sanitized; HTTP config rejected',async(t)=>{
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('DO_NOT_EXPOSE token');});await assert.rejects(createAuthServices(env).verify('token'),(e:any)=>e.status===503&&!e.message.includes('DO_NOT_EXPOSE'));
 assert.throws(()=>createAuthServices({...env,SUPABASE_URL:'http://auth.test'}),{status:503});
});

test('expired claims/wrong issuer and revoked sessions rejected after Auth verification',async(t)=>{
 let active=false;t.mock.method(globalThis,'fetch',async(input:any)=>Response.json(String(input).includes('/auth/v1/user')?identity:active));
 await assert.rejects(createAuthServices(env).verify(token),{status:401});
 active=true;
 for(const mutation of [{exp:0},{iss:'https://evil.test/auth/v1'},{sub:claims.session_id},{role:'service_role'}]){
  const bad='fixture.'+Buffer.from(JSON.stringify({...claims,...mutation})).toString('base64url')+'.signature';await assert.rejects(createAuthServices(env).verify(bad),{status:401});
 }
});

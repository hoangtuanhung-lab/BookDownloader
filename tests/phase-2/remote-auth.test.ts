import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthServices} from '../../packages/infrastructure/src/auth';
import {handleApi} from '../../netlify/functions/api';
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

test('admin permission save accepts PostgREST void 204; reload sees the saved permissions',async(t)=>{
 const origin='https://app.test',target=claims.session_id;
 let writes=0,saved:string[]=['read'];
 t.mock.method(globalThis,'fetch',async(input:any,init:any)=>{
  const request=new Request(input,init),path=new URL(request.url).pathname;
  if(path==='/auth/v1/user')return Response.json(identity);
  if(path.endsWith('/app_session_active'))return Response.json(true);
  if(path.endsWith('/app_me'))return Response.json({id:identity.id,name:'Owner',permissions:['admin']});
  if(path.endsWith('/app_admin_update')){
   const body=await request.json();assert.equal(body.actor,identity.id);assert.equal(body.target,target);
   assert.equal(body.account_status,'active');saved=body.permissions;writes++;
   return new Response(null,{status:204});
  }
  if(path.endsWith('/app_admin_users'))return Response.json([{id:target,name:'Reader',email:'reader@example.test',status:'active',permissions:saved}]);
  throw Error('Unexpected transport request');
 });
 const save=await handleApi(new Request(origin+'/api/admin/users/'+target,{method:'PUT',headers:{Authorization:'Bearer '+token,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({permissions:['read','manage'],status:'active'})}),{...env,APP_ORIGINS:origin});
 assert.equal(save.status,200);assert.deepEqual(await save.json(),{ok:true});assert.equal(writes,1);
 const reload=await handleApi(new Request(origin+'/api/admin/users',{headers:{Authorization:'Bearer '+token}}),env);
 assert.equal(reload.status,200);assert.deepEqual((await reload.json())[0].permissions,['read','manage']);assert.equal(writes,1);
});

test('RPC supports empty success and JSON null for void functions',async(t)=>{
 let response=new Response(null,{status:204});
 t.mock.method(globalThis,'fetch',async()=>response);
 const services=createAuthServices(env);
 assert.equal(await services.rpc('bootstrap_admin',{target:identity.id}),null);
 response=new Response('',{status:200});assert.equal(await services.rpc('bootstrap_admin',{target:identity.id}),null);
 response=Response.json(null);assert.equal(await services.rpc('bootstrap_admin',{target:identity.id}),null);
});

test('empty or plain-text RPC failures never become success or expose upstream text',async(t)=>{
 let response=new Response(null,{status:503});
 t.mock.method(globalThis,'fetch',async()=>response);
 const services=createAuthServices(env);
 await assert.rejects(services.rpc('app_admin_update',{}),{status:503});
 response=new Response('DO_NOT_EXPOSE secret',{status:502});
 await assert.rejects(services.rpc('app_admin_update',{}),(e:any)=>e.status===503&&!e.message.includes('DO_NOT_EXPOSE'));
});

test('malformed RPC JSON is sanitized rather than reported as a completed write',async(t)=>{
 t.mock.method(globalThis,'fetch',async()=>new Response('{DO_NOT_EXPOSE secret',{status:200}));
 await assert.rejects(createAuthServices(env).rpc('app_admin_update',{}),(e:any)=>e.status===503&&!e.message.includes('DO_NOT_EXPOSE'));
});

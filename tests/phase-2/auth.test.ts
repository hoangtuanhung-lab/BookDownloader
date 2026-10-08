import test from 'node:test';
import assert from 'node:assert/strict';
import {handleApi} from '../../netlify/functions/api';
import {AppError,hasPermission,type Account} from '../../packages/contracts/src/index';
import type {AuthServices} from '../../packages/infrastructure/src/auth';
const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const origin='https://app.test',env={APP_ORIGINS:origin};
function services(permissions:Account['permissions']=['read'],blocked=false):AuthServices & {calls:Record<string,unknown>[]} {
 const calls:Record<string,unknown>[]=[];
 return {calls,async verify(token){if(token!=='valid')throw new AppError('UNAUTHENTICATED',401,'Phiên đăng nhập đã hết hạn');return {id,email:'sample@gmail.com',email_confirmed_at:'2026-10-08',app_metadata:{provider:'google'}};},async rpc(name,args){calls.push({name,...args});if(blocked)throw new AppError('FORBIDDEN',403,'Tài khoản bị khóa');if(name==='app_me')return {id,name:'Reader',permissions};if(name==='app_admin_users')return [];return null;}};
}
const req=(path:string,method='GET',body?:unknown,token='valid',from=origin)=>new Request(origin+'/api'+path,{method,headers:{Authorization:'Bearer '+token,Origin:from,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
test('anonymous and malformed bearer denied before service calls',async()=>{
 for(const token of ['', 'Basic xyz','Bearer invalid token'])assert.equal((await handleApi(new Request(origin+'/api/me',{headers:{Authorization:token}}),env,undefined,services())).status,401);
});
test('expired/forged token denied; blocked account denied',async()=>{
 for(const token of ['expired','forged'])assert.equal((await handleApi(req('/me','GET',undefined,token),env,undefined,services())).status,401);
 assert.equal((await handleApi(req('/me'),env,undefined,services(['read'],true))).status,403);
});
test('me identity and current permissions are server-derived',async()=>{
 const res=await handleApi(req('/me'),env,undefined,services(['read']));assert.deepEqual(await res.json(),{id,name:'Reader',permissions:['read']});assert.equal(res.headers.get('Cache-Control'),'no-store');
});
for(const [permissions,permission,path] of [[['read'],'read','/books'],[['download'],'download','/download'],[['manage'],'manage','/manage'],[['admin'],'admin','/admin/missing']] as const)test('independent permission '+permission,async()=>{
 const svc=services([...permissions]);if(permission==='read'){const original=svc.rpc.bind(svc);svc.rpc=(name,args)=>name==='app_library'?Promise.resolve({books:[],total:0,offset:0}):original(name,args);}
 assert.equal((await handleApi(req(path),env,undefined,svc)).status,permission==='read'?200:501);
 for(const [otherPermission,otherPath] of [['read','/books'],['download','/download'],['manage','/manage'],['admin','/admin/missing']] as const)if(!hasPermission({id,name:'',permissions:[...permissions]},otherPermission))assert.equal((await handleApi(req(otherPath),env,undefined,svc)).status,403);
});
test('direct admin calls by reader/download/manage denied',async()=>{
 for(const p of ['read','download','manage'] as const){const svc=services([p]);assert.equal((await handleApi(req('/admin/users'),env,undefined,svc)).status,403);assert.equal((await handleApi(req('/admin/users/'+other,'PUT',{permissions:['admin'],status:'active'}),env,undefined,svc)).status,403);assert(!svc.calls.some(c=>c.name==='app_admin_update'));}
});
test('admin update is validated and binds actor to verified token',async()=>{
 const svc=services(['admin']);assert.equal((await handleApi(req('/admin/users/'+other,'PUT',{permissions:['read','manage'],status:'active'}),env,undefined,svc)).status,200);
 assert.deepEqual(svc.calls.at(-1),{name:'app_admin_update',actor:id,target:other,permissions:['read','manage'],account_status:'active'});
 assert.equal((await handleApi(req('/admin/users/'+other,'PUT',{actor:other,permissions:['admin'],status:'active'}),env,undefined,svc)).status,400);
});
test('mutation requires exact allowlisted origin',async()=>{
 for(const from of ['https://app.test.evil.test','null','https://evil.test'])assert.equal((await handleApi(req('/me/preferences','PUT',{},'valid',from),env,undefined,services())).status,403);
});
test('preferences accept own DTO only, never user id or unapproved fonts',async()=>{
 const value={font:'Literata',fontSize:20,theme:'day',blueFilter:0,mode:'chapter'},svc=services();
 assert.equal((await handleApi(req('/me/preferences','PUT',value),env,undefined,svc)).status,200);assert.equal(svc.calls.at(-1)?.actor,id);
 for(const patch of [{userId:other},{font:'<script>'},{fontSize:99}])assert.equal((await handleApi(req('/me/preferences','PUT',{...value,...patch}),env,undefined,services())).status,400);
});
test('progress requires revision, validated UUID, ratio and own actor',async()=>{
 const value={chapterId:other,ratio:0.3,scrollPosition:120,expectedRevision:0},svc=services();
 assert.equal((await handleApi(req('/me/progress/'+other,'PUT',value),env,undefined,svc)).status,200);assert.equal(svc.calls.at(-1)?.actor,id);
 for(const patch of [{userId:other},{expectedRevision:-1},{ratio:2}])assert.equal((await handleApi(req('/me/progress/'+other,'PUT',{...value,...patch}),env,undefined,services())).status,400);
});
test('permissions revoked between requests are not cached',async()=>{
 const svc=services(['admin']);assert.equal((await handleApi(req('/admin/users'),env,undefined,svc)).status,200);
 svc.rpc=async()=>({id,name:'Reader',permissions:['read']});assert.equal((await handleApi(req('/admin/users'),env,undefined,svc)).status,403);
});
test('unknown/absent config does not fake auth success',async()=>assert.equal((await handleApi(req('/me'),{},undefined)).status,503));

test('legacy-mapped download/import/settings endpoints guarded before implementation',async()=>{
 for(const [path,method] of [['/analysis/jobs','POST'],['/books/from-web','POST'],['/imports/file','POST'],['/chapters/'+other,'PATCH'],['/settings','PATCH'],['/drive/root','PUT']])assert.equal((await handleApi(req(path,method,{}),env,undefined,services(['read']))).status,403);
});

import {test,expect,type Page,type Route} from '@playwright/test';
const id='00000000-0000-4000-8000-000000000001';
// Phase 4 reader now loads the library; auth fixtures never call real APIs with synthetic JWTs.
test.beforeEach(async({page})=>{await page.route('**/api/books?**',route=>route.fulfill({json:{books:[],total:0,offset:0}}));});
async function session(page:Page,permissions:string[]=['read']){
 await page.addInitScript(({id})=>{
  const jwt=[btoa(JSON.stringify({alg:'HS256',typ:'JWT'})),btoa(JSON.stringify({sub:id,exp:Math.floor(Date.now()/1000)+3600,aud:'authenticated'})),'synthetic-signature'].join('.');
  localStorage.setItem('book:auth:session',JSON.stringify({access_token:jwt,refresh_token:'fixture-refresh',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user:{id,aud:'authenticated',role:'authenticated',email:'sample@gmail.com',app_metadata:{provider:'google'},user_metadata:{},created_at:'2026-10-08'}}));
  localStorage.setItem('book:user:'+id+':draft','PRIVATE-DRAFT');
 },{id});
 await page.route('**/api/me',route=>route.fulfill({json:{id,name:'Synthetic Reader',permissions}}));
 await page.route('https://auth-fixture.test/**',route=>route.fulfill({status:200,json:{}}));
}
test('signed-in reader lands on read with no Drive setup and privileged menu',async({page})=>{
 await session(page);await page.goto('/');await expect(page).toHaveURL(/\/read$/);await expect(page.getByRole('heading',{name:'Đọc truyện'})).toBeVisible();
 for(const name of ['Tải sách','Quản lý sách','Quản trị'])await expect(page.getByRole('link',{name,exact:true})).toHaveCount(0);
});
test('direct admin/download/manage routes denied to reader',async({page})=>{
 await session(page);for(const path of ['/admin','/download','/manage']){await page.goto(path);await expect(page.getByRole('heading',{name:'Không có quyền truy cập'})).toBeVisible();}
});
test('download and manage permissions independent from read',async({page})=>{
 await session(page,['download','manage']);await page.goto('/download');await expect(page.getByRole('heading',{name:'Tải sách'})).toBeVisible();
 await expect(page.getByRole('link',{name:'Đọc truyện',exact:true})).toHaveCount(0);await page.goto('/read');await expect(page.getByRole('heading',{name:'Không có quyền truy cập'})).toBeVisible();
});
test('admin edits real UI permission DTO and status',async({page})=>{
 await session(page,['admin']);let update:any;
 await page.route('**/api/admin/users',route=>route.fulfill({json:[{id,name:'Sample account',email:'sample@gmail.com',status:'active',permissions:['read']}]}));
 await page.route('**/api/admin/users/'+id,async route=>{update=route.request().postDataJSON();await route.fulfill({json:{ok:true}});});
 await page.goto('/admin');await page.getByLabel('Tải sách',{exact:true}).check();await page.getByRole('button',{name:'Lưu quyền'}).click();await expect(page.getByRole('status')).toHaveText('Đã cập nhật tài khoản');expect(update).toEqual({permissions:['read','download'],status:'active'});
});
test('logout aborts private UI and removes own storage',async({page})=>{
 await session(page);await page.goto('/read');await expect(page.getByRole('heading',{name:'Đọc truyện'})).toBeVisible();
 await page.evaluate(id=>localStorage.setItem('book:user:'+id+':cache','PRIVATE-CACHE'),id);
 await page.getByRole('button',{name:'Đăng xuất'}).click();await expect(page.getByRole('heading',{name:'Đăng nhập'})).toBeVisible();
 expect(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('book:user:')||k==='book:auth:session'))).toEqual([]);
 await page.evaluate(id=>{const channel=new BroadcastChannel('book:auth:session');channel.postMessage({event:'TOKEN_REFRESHED',session:{access_token:'stale.payload.signature',user:{id}}});setTimeout(()=>channel.close(),100);},id);await expect(page.getByRole('heading',{name:'Đăng nhập'})).toBeVisible();
});
test('blocked account does not show private menus',async({page})=>{
 await session(page,['admin']);await page.route('**/api/me',route=>route.fulfill({status:403,json:{error:'FORBIDDEN',message:'Tài khoản bị khóa'}}));await page.goto('/admin');await expect(page.getByRole('alert')).toHaveText('Tài khoản bị khóa');await expect(page.getByRole('link',{name:'Quản trị',exact:true})).toHaveCount(0);
});
test('Google redirect ignores malicious next URL and requests login-only scopes',async({page})=>{
 await page.goto('/login?next=https://evil.test');await page.route('https://auth-fixture.test/auth/v1/authorize**',route=>route.fulfill({body:'Synthetic OAuth destination'}));
 const pending=page.waitForRequest(r=>r.url().startsWith('https://auth-fixture.test/auth/v1/authorize'));
 await page.getByRole('button',{name:'Đăng nhập bằng Google'}).click();const request=await pending;const url=new URL(request.url());
 expect(url.searchParams.get('provider')).toBe('google');expect(url.searchParams.get('redirect_to')).toBe('http://127.0.0.1:5173/auth/callback');expect(url.searchParams.get('scopes')).not.toContain('drive');expect(url.searchParams.get('code_challenge')).toBeTruthy();
});
test('callback without PKCE code fails closed and strips query',async({page})=>{
 await page.goto('/auth/callback?error=access_denied&next=https://evil.test');await expect(page.getByRole('alert')).toHaveText('Không hoàn tất được đăng nhập Google');expect(new URL(page.url()).search).toBe('');
});
test('PKCE callback exchanges once under StrictMode and reaches reader',async({page})=>{
 let exchanges=0;
 await page.addInitScript(()=>localStorage.setItem('book:auth:session-code-verifier',JSON.stringify('a'.repeat(64))));
 await page.route('https://auth-fixture.test/auth/v1/token**',async route=>{
  exchanges++;expect(route.request().postDataJSON().auth_code).toBe('fixture-code');
  await route.fulfill({json:{access_token:'fixture.payload.signature',refresh_token:'new-refresh',expires_in:3600,token_type:'bearer',user:{id,aud:'authenticated',role:'authenticated',email:'sample@gmail.com',app_metadata:{provider:'google'},user_metadata:{},created_at:'2026-10-08'}}});
 });
 await page.route('**/api/me',route=>route.fulfill({json:{id,name:'Callback Reader',permissions:['read']}}));
 await page.goto('/auth/callback?code=fixture-code&next=https://evil.test');await expect(page.getByRole('heading',{name:'Đọc truyện'})).toBeVisible();await expect(page).toHaveURL(/\/read$/);expect(exchanges).toBe(1);
});
test('permission refresh removes revoked admin menu and cached state',async({page})=>{
 await session(page,['admin']);await page.route('**/api/admin/users',route=>route.fulfill({json:[]}));await page.goto('/admin');await expect(page.getByRole('heading',{name:'Quản trị'})).toBeVisible();
 await page.evaluate(()=>localStorage.setItem('book:user:fixture:cache','PRIVATE'));
 await page.route('**/api/me',route=>route.fulfill({json:{id,name:'Reader after revoke',permissions:['read']}}));
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.getByRole('heading',{name:'Không có quyền truy cập'})).toBeVisible();await expect(page.getByRole('link',{name:'Quản trị',exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>localStorage.getItem('book:user:fixture:cache'))).toBeNull();
});
test('session switch clears old user state and ignores stale private requests',async({page})=>{
 await session(page,['admin']);await page.route('**/api/admin/users',route=>route.fulfill({json:[]}));await page.goto('/admin');await expect(page.getByRole('heading',{name:'Quản trị'})).toBeVisible();
 const other='00000000-0000-4000-8000-000000000002';
 let stale:Route|undefined,first=true;let started!:()=>void;const requestStarted=new Promise<void>(resolve=>{started=resolve;});
 await page.route('**/api/me',async route=>{if(first){first=false;stale=route;started();}else await route.fulfill({json:{id:other,name:'Second reader',permissions:['read']}});});
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await requestStarted;
 await page.evaluate(({id,other})=>{
  localStorage.setItem('book:user:'+id+':cache','PRIVATE');
  const channel=new BroadcastChannel('book:auth:session');channel.postMessage({event:'SIGNED_IN',session:{access_token:'other.payload.signature',refresh_token:'other-refresh',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:other,email:'other@gmail.com',app_metadata:{provider:'google'},user_metadata:{}}}});setTimeout(()=>channel.close(),100);
 },{id,other});
 await expect(page.getByText('Second reader',{exact:true})).toBeVisible();await stale!.fulfill({json:{id,name:'STALE ADMIN',permissions:['admin']}}).catch(()=>{});await expect(page.getByText('STALE ADMIN',{exact:true})).toHaveCount(0);await expect(page.getByRole('link',{name:'Quản trị',exact:true})).toHaveCount(0);expect(await page.evaluate(id=>localStorage.getItem('book:user:'+id+':cache'),id)).toBeNull();
});
test('token refresh uses the new bearer without mixing private state',async({page})=>{
 await session(page);await page.goto('/read');await expect(page.getByRole('heading',{name:'Đọc truyện'})).toBeVisible();
 await page.evaluate(()=>localStorage.setItem('book:user:fixture:cache','OWN-CACHE'));
 let bearer='';await page.route('**/api/me',route=>{bearer=route.request().headers()['authorization'];return route.fulfill({json:{id,name:'Refreshed reader',permissions:['read']}});});
 await page.evaluate(id=>{const channel=new BroadcastChannel('book:auth:session');channel.postMessage({event:'TOKEN_REFRESHED',session:{access_token:'refreshed.payload.signature',refresh_token:'refresh',expires_at:Math.floor(Date.now()/1000)+3600,user:{id,email:'sample@gmail.com',app_metadata:{provider:'google'},user_metadata:{}}}});setTimeout(()=>channel.close(),100);},id);
 await expect(page.getByText('Refreshed reader',{exact:true})).toBeVisible();expect(bearer).toBe('Bearer refreshed.payload.signature');expect(await page.evaluate(()=>localStorage.getItem('book:user:fixture:cache'))).toBe('OWN-CACHE');
});

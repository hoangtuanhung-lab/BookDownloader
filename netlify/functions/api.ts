import {readStoredChapter,readStoredCover,readerStorage,type ReaderStorage} from '../../packages/infrastructure/src/reader-storage';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {checkDatabase} from '../../packages/infrastructure/src/health';
import {safeLog} from '../../packages/infrastructure/src/logging';
import {createAuthServices,type AuthServices} from '../../packages/infrastructure/src/auth';
import {LibraryBook,LibraryPage,ChapterPage,Account,AccountUpdate,AdminUser,AppError,hasPermission,ProgressUpdate,ReaderPreferences} from '../../packages/contracts/src/index';
export async function handleApi(request:Request,env:NodeJS.ProcessEnv=process.env,check=checkDatabase,injected?:AuthServices,storage?:ReaderStorage):Promise<Response> {
 const correlationId=randomUUID();
 const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Correlation-ID':correlationId,'X-Content-Type-Options':'nosniff'};
 const url=new URL(request.url),pathname=url.pathname.replace(/^\/.netlify\/functions\/api\//,'/api/');
 const json=(body:unknown,status=200)=>Response.json(body,{status,headers});
 if(request.method==='GET' && pathname==='/api/health') {
  try {await check(env);return json({status:'ok',database:'ok',correlationId});}
  catch {safeLog('health_unavailable',correlationId);return json({status:'unavailable',database:'unavailable',correlationId},503);}
 }
 if(request.method==='POST' && pathname==='/api/health')return json({error:'NOT_IMPLEMENTED',correlationId},501);
 let services:AuthServices|undefined;
 try {
  const bearer=request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9._~-]{1,8192})$/);
  if(!bearer)throw new AppError('UNAUTHENTICATED',401,'Cần đăng nhập');
  if(!['GET','HEAD'].includes(request.method)) {
   const origin=request.headers.get('Origin');
   const allowed=(env.APP_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
   if(!origin || !allowed.includes(origin))throw new AppError('INVALID_ORIGIN',403,'Nguồn yêu cầu không hợp lệ');
  }
  services=injected||createAuthServices(env);
  const identity=await services.verify(bearer[1]);
  const account=Account.parse(await services.rpc('app_me',{actor:identity.id}));
  if(account.id!==identity.id)throw new AppError('AUTH_UNAVAILABLE',503,'Tài khoản không hợp lệ');
  const requirePermission=(permission:'read'|'manage'|'download'|'admin')=>{if(!hasPermission(account,permission))throw new AppError('FORBIDDEN',403,'Bạn không có quyền thực hiện thao tác này');};
  async function body() {
   if(!request.headers.get('content-type')?.startsWith('application/json'))throw new AppError('INVALID_INPUT',400,'Cần dữ liệu JSON');
   const text=await request.text();if(Buffer.byteLength(text)>8192)throw new AppError('INPUT_TOO_LARGE',413,'Dữ liệu quá lớn');
   try{return JSON.parse(text);}catch{throw new AppError('INVALID_INPUT',400,'JSON không hợp lệ');}
  }
  if(pathname==='/api/me' && request.method==='GET')return json(account);
  if(pathname==='/api/admin/users' && request.method==='GET') {
   requirePermission('admin');const after=url.searchParams.get('after');if(after)z.uuid().parse(after);
   return json(z.array(AdminUser).parse(await services.rpc('app_admin_users',{actor:identity.id,after_id:after})));
  }
  const target=/^\/api\/admin\/users\/([^/]+)$/.exec(pathname);
  if(target && request.method==='PUT') {
   requirePermission('admin');z.uuid().parse(target[1]);const update=AccountUpdate.parse(await body());
   await services.rpc('app_admin_update',{actor:identity.id,target:target[1],permissions:update.permissions,account_status:update.status});return json({ok:true});
  }
  if(pathname==='/api/me/preferences' && ['GET','PUT'].includes(request.method)) {
   requirePermission('read');const value=request.method==='PUT'?ReaderPreferences.parse(await body()):null;
   return json(await services.rpc('app_preferences',{actor:identity.id,new_value:value}));
  }
  const progress=/^\/api\/me\/progress\/([^/]+)$/.exec(pathname);
  if(progress && ['GET','PUT'].includes(request.method)) {
   requirePermission('read');z.uuid().parse(progress[1]);const value=request.method==='PUT'?ProgressUpdate.parse(await body()):null;
   return json(await services.rpc('app_progress',{actor:identity.id,target_book:progress[1],new_value:value}));
  }
  function offset(name='offset'){return z.coerce.number().int().min(0).max(10000000).parse(url.searchParams.get(name)??0);}
  if(pathname==='/api/books' && request.method==='GET'){
   requirePermission('read');const query=z.string().max(200).parse(url.searchParams.get('q')||'');const sort=z.enum(['name','author','updated','progress']).parse(url.searchParams.get('sort')||'name');
   return json(LibraryPage.parse(await services.rpc('app_library',{actor:identity.id,query,sort_by:sort,page_offset:offset()})));
  }
  const readerBook=/^\/api\/books\/([^/]+)$/.exec(pathname);
  if(readerBook && request.method==='GET'){requirePermission('read');z.uuid().parse(readerBook[1]);return json(LibraryBook.parse(await services.rpc('app_reader_book',{actor:identity.id,target_book:readerBook[1]})));}
  const chapterPage=/^\/api\/books\/([^/]+)\/chapters$/.exec(pathname);
  if(chapterPage && request.method==='GET'){
   requirePermission('read');z.uuid().parse(chapterPage[1]);const limit=z.coerce.number().int().min(1).max(200).parse(url.searchParams.get('limit')??200);
   return json(ChapterPage.parse(await services.rpc('app_reader_chapters',{actor:identity.id,target_book:chapterPage[1],page_offset:offset(),page_limit:limit})));
  }
  const cluster=/^\/api\/books\/([^/]+)\/cluster$/.exec(pathname);
  if(cluster && request.method==='GET'){
   requirePermission('read');z.uuid().parse(cluster[1]);const start=offset('start');if(start%5)throw new AppError('INVALID_INPUT',400,'Cụm chương cần bắt đầu ở bội số 5');
   const args={actor:identity.id,target_book:cluster[1]};const page=ChapterPage.parse(await services.rpc('app_reader_chapters',{...args,page_offset:start,page_limit:5}));
   let source=storage;const drive:ReaderStorage={readText:(id)=>(source??=readerStorage(env)).readText(id),readBytes:(id)=>(source??=readerStorage(env)).readBytes(id)};
   const items=[];let bytes=0;
   for(const chapter of page.chapters){try{const content=await readStoredChapter(services,drive,identity.id,cluster[1],chapter.id);const size=Buffer.byteLength(JSON.stringify(content));if(bytes+size>2000000)throw new AppError('CONTENT_TOO_LARGE',413,'Nội dung cụm chương quá lớn');bytes+=size;items.push({id:chapter.id,cacheTag:chapter.cacheTag,...content});}
    catch(error){if(!(error instanceof AppError)||['FORBIDDEN','UNAUTHENTICATED'].includes(error.code))throw error;items.push({id:chapter.id,cacheTag:chapter.cacheTag,error:error.message});}}
   await services.rpc('app_reader_book',args);return json({start,items});
  }
  const chapterContent=/^\/api\/books\/([^/]+)\/chapters\/([^/]+)\/content$/.exec(pathname);
  if(chapterContent && request.method==='GET') {
   requirePermission('read');z.uuid().parse(chapterContent[1]);z.uuid().parse(chapterContent[2]);
   // Resolve storage lazily so a cache hit does not require a fresh Google token.
   const lazy:ReaderStorage=storage||{readText:(id)=>readerStorage(env).readText(id),readBytes:(id)=>readerStorage(env).readBytes(id)};
   return json(await readStoredChapter(services,lazy,identity.id,chapterContent[1],chapterContent[2]));
  }
  const cover=/^\/api\/books\/([^/]+)\/cover$/.exec(pathname);
  if(cover && request.method==='GET') {
   requirePermission('read');z.uuid().parse(cover[1]);const result=await readStoredCover(services,storage||readerStorage(env),identity.id,cover[1]);
   return new Response(Buffer.from(result.bytes),{headers:{...headers,'Content-Type':result.mimeType,'Content-Security-Policy':"default-src 'none'; sandbox"}});
  }
  // Permission guard remains active even before business implementations land.
  if(pathname.startsWith('/api/download')||pathname.startsWith('/api/jobs')||pathname.startsWith('/api/analysis')||pathname==='/api/books/from-web'||pathname.endsWith('/download-actions'))requirePermission('download');
  else if(pathname.startsWith('/api/manage')||pathname.startsWith('/api/imports')||pathname==='/api/genres'||(['POST','PUT','DELETE','PATCH'].includes(request.method)&&(pathname.startsWith('/api/books')||pathname.startsWith('/api/chapters'))))requirePermission('manage');
  else if(pathname.startsWith('/api/admin')||pathname.startsWith('/api/drive')||pathname.startsWith('/api/settings'))requirePermission('admin');
  else if(pathname.startsWith('/api/books')||pathname.startsWith('/api/chapters')||pathname.startsWith('/api/reader'))requirePermission('read');
  return json({error:'NOT_IMPLEMENTED',correlationId},501);
 } catch(error) {
  if(error instanceof AppError)return json({error:error.code,message:error.message,correlationId},error.status);
  if(error instanceof z.ZodError)return json({error:'INVALID_INPUT',message:'Dữ liệu không hợp lệ',correlationId},400);
  return json({error:'INTERNAL_ERROR',message:'Không xử lý được yêu cầu',correlationId},500);
 } finally {await services?.close?.();}
}
export default (request:Request)=>handleApi(request);
export const config={path:'/api/*'};

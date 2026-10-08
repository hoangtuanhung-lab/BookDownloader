import {z} from 'zod';
import {AppError} from '../../contracts/src/index';
import type {DriveStorage} from '../../domain/src/ports';
export const DriveFile=z.object({id:z.string().min(1),name:z.string(),mimeType:z.string(),parents:z.array(z.string()).default([]),trashed:z.boolean().default(false),size:z.string().optional(),appProperties:z.record(z.string(),z.string()).default({}),capabilities:z.object({canAddChildren:z.boolean().optional()}).optional()});
export type DriveFile=z.infer<typeof DriveFile>;
const folderType='application/vnd.google-apps.folder';
const fields='id,name,mimeType,parents,trashed,size,appProperties,capabilities';
const id=(value:string)=>{if(!/^[\w-]{1,200}$/.test(value))throw new AppError('INVALID_INPUT',400,'ID Drive không hợp lệ');return value;};
const quote=(value:string)=>"'"+value.replace(/\\/g,'\\\\').replace(/'/g,"\\'")+"'";
export interface DriveOptions {rootId:string;token:()=>Promise<string>;fetch?:typeof fetch;maxRequests?:number;maxBytes?:number;timeoutMs?:number;pause?:(ms:number)=>Promise<void>;}
/** API v3. All access is bounded to one explicitly configured library root. */
export class GoogleDriveStorage implements DriveStorage {
 readonly metrics={requests:0,retries:0,bytesRead:0,bytesWritten:0};
 private readonly fetcher:typeof fetch;
 constructor(private options:DriveOptions){id(options.rootId);this.fetcher=options.fetch||fetch;}
 private async call(path:string,init:RequestInit={},retry=true):Promise<Response>{
  for(let attempt=0;;attempt++){
   if(++this.metrics.requests>(this.options.maxRequests??100))throw new AppError('DRIVE_BUDGET',503,'Vượt giới hạn yêu cầu Drive');
   const bearer=await this.options.token();
   let response:Response;
   try{response=await this.fetcher('https://www.googleapis.com'+path,{...init,headers:{...init.headers,Authorization:'Bearer '+bearer},signal:AbortSignal.timeout(this.options.timeoutMs??5000),redirect:'error'});}
   catch{if(!retry||attempt>=2)throw new AppError('DRIVE_UNAVAILABLE',503,'Không kết nối được Drive');await this.delay(attempt);continue;}
   if(response.ok)return response;
   if(response.status===404)throw new AppError('DRIVE_NOT_FOUND',404,'File Drive không còn tồn tại');
   if(response.status===401)throw new AppError('DRIVE_AUTH',503,'Cần kết nối lại Drive của chủ thư viện');
   // 403 also represents quota; retry only recognized rate-limit errors, never permission denial.
   let rate=false;if(response.status===403){try{const body=await response.json();rate=body?.error?.errors?.some((e:{reason:string})=>['rateLimitExceeded','userRateLimitExceeded'].includes(e.reason))===true;}catch{}}
   if(retry&&attempt<2&&(rate||response.status===429||response.status>=500)){await this.delay(attempt);continue;}
   if(response.status===403)throw new AppError('DRIVE_FORBIDDEN',403,'Không có quyền truy cập Drive');
   throw new AppError('DRIVE_UNAVAILABLE',503,'Drive chưa sẵn sàng');
  }
 }
 private async delay(attempt:number){this.metrics.retries++;await (this.options.pause||((ms)=>new Promise(r=>setTimeout(r,ms))))(100*2**attempt);}
 async metadata(fileId:string):Promise<DriveFile>{const response=await this.call('/drive/v3/files/'+id(fileId)+'?fields='+fields);const file=DriveFile.parse(await response.json());if(file.trashed)throw new AppError('DRIVE_NOT_FOUND',404,'File đang trong thùng rác');return file;}
 async assertUnderRoot(fileId:string):Promise<DriveFile>{
  const first=await this.metadata(fileId);let file=first;const visited=new Set<string>();
  for(let depth=0;depth<32;depth++){
   if(file.id===this.options.rootId){if(file.mimeType!==folderType)break;return first;}
   if(visited.has(file.id)||file.parents.length!==1)break;visited.add(file.id);file=await this.metadata(file.parents[0]);
  }
  throw new AppError('DRIVE_OUTSIDE_ROOT',403,'File nằm ngoài thư viện đã đăng ký');
 }
 async checkRoot(write=false){const root=await this.assertUnderRoot(this.options.rootId);if(write&&root.capabilities?.canAddChildren!==true)throw new AppError('DRIVE_FORBIDDEN',403,'Thư mục gốc cần quyền chỉnh sửa');return root;}
 async list(parentId:string,name?:string):Promise<DriveFile[]>{
  const parent=await this.assertUnderRoot(parentId);if(parent.mimeType!==folderType)throw new AppError('INVALID_INPUT',400,'Cần thư mục Drive');
  const files:DriveFile[]=[];let page:string|undefined;const seen=new Set<string>();
  do{
   const query=new URLSearchParams({q:quote(id(parentId))+' in parents and trashed = false'+(name===undefined?'':' and name = '+quote(name)),fields:'nextPageToken,files('+fields+')',pageSize:'1000'});if(page)query.set('pageToken',page);
   const response=await this.call('/drive/v3/files?'+query);const result=z.object({files:z.array(DriveFile),nextPageToken:z.string().optional()}).parse(await response.json());
   for(const file of result.files){if(file.trashed||!file.parents.includes(parentId))throw new AppError('DRIVE_INVALID',503,'Danh sách Drive không hợp lệ');files.push(file);}
   page=result.nextPageToken;if(page){if(seen.has(page))throw new AppError('DRIVE_INVALID',503,'Phân trang Drive bị lặp');seen.add(page);}
  }while(page);
  return files;
 }
 async folder(parentId:string,name:string):Promise<string>{
  const matches=(await this.list(parentId,name)).filter(f=>f.mimeType===folderType);
  if(matches.length>1)throw new AppError('DRIVE_CONFLICT',409,'Có nhiều thư mục trùng tên');if(matches.length)return matches[0].id;
  const response=await this.call('/drive/v3/files?fields='+fields,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,mimeType:folderType,parents:[parentId]})},false);
  return DriveFile.parse(await response.json()).id;
 }
 async readBytes(fileId:string):Promise<{bytes:Uint8Array;mimeType:string}>{
  const file=await this.assertUnderRoot(fileId);const max=this.options.maxBytes??2_000_000;
  if(file.mimeType===folderType||Number(file.size)>max)throw new AppError('DRIVE_TOO_LARGE',413,'File quá lớn hoặc không phải file nội dung');
  const response=await this.call('/drive/v3/files/'+id(fileId)+'?alt=media');
  const reader=response.body?.getReader();if(!reader)throw new AppError('DRIVE_INVALID',503,'Drive thiếu nội dung');
  const parts:Uint8Array[]=[];let size=0;
  try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>max)throw new AppError('DRIVE_TOO_LARGE',413,'File quá lớn');parts.push(chunk.value);}}finally{await reader.cancel();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}this.metrics.bytesRead+=size;return {bytes,mimeType:file.mimeType};
 }
 async readText(fileId:string){const {bytes}=await this.readBytes(fileId);return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
 /** Callers serialize writes per folder/name with a database lock/outbox lease. No ambiguous create retries. */
 async putText(folderId:string,name:string,content:string,version:number):Promise<string>{
  if(!Number.isSafeInteger(version)||version<1||!name||name.includes('/')||Buffer.byteLength(content)>(this.options.maxBytes??2_000_000))throw new AppError('INVALID_INPUT',400,'File không hợp lệ');
  const files=(await this.list(folderId,name)).filter(f=>f.mimeType!==folderType);
  if(files.length>1)throw new AppError('DRIVE_CONFLICT',409,'Có nhiều file trùng tên');
  const existing=files[0];const previous=Number(existing?.appProperties.metadataVersion||0);
  if(previous>version)throw new AppError('DRIVE_CONFLICT',409,'Phiên bản file mới hơn yêu cầu');
  if(existing){const current=await this.readText(existing.id);if(current===content&&previous===version)return existing.id;if(previous===version&&current!==content)throw new AppError('DRIVE_CONFLICT',409,'Nội dung cùng phiên bản không khớp');}
  const boundary='book-drive-'+crypto.randomUUID();const metadata={name,mimeType:'text/plain',appProperties:{metadataVersion:String(version)},...(existing?{}:{parents:[folderId]})};
  const body='--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(metadata)+'\r\n--'+boundary+'\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n'+content+'\r\n--'+boundary+'--';
  const response=await this.call('/upload/drive/v3/files'+(existing?'/'+id(existing.id):'')+'?uploadType=multipart&fields='+fields,{method:existing?'PATCH':'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body},false);
  const result=DriveFile.parse(await response.json());this.metrics.bytesWritten+=Buffer.byteLength(content);return result.id;
 }
 async moveFolder(folderId:string,parentId:string,name:string){
  const file=await this.assertUnderRoot(folderId);await this.assertUnderRoot(parentId);if(file.id===this.options.rootId||file.mimeType!==folderType)throw new AppError('DRIVE_FORBIDDEN',403,'Không di chuyển thư mục gốc');
  const query=new URLSearchParams({fields});if(!file.parents.includes(parentId)){query.set('addParents',parentId);query.set('removeParents',file.parents.join(','));}
  await this.call('/drive/v3/files/'+id(folderId)+'?'+query,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
 }
 async trashOwned(fileId:string){const file=await this.assertUnderRoot(fileId);if(file.id===this.options.rootId)throw new AppError('DRIVE_FORBIDDEN',403,'Không xóa thư mục gốc');await this.call('/drive/v3/files/'+id(fileId)+'?fields='+fields,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({trashed:true})});}
 async putCover(folderId:string,name:string,bytes:Uint8Array,version:number){
  const files=(await this.list(folderId,name)).filter(f=>f.mimeType==='image/webp');if(files.length>1)throw new AppError('DRIVE_CONFLICT',409,'Ảnh bìa trùng tên');const old=files[0];
  if(old){if(old.appProperties.metadataVersion!==String(version))throw new AppError('DRIVE_CONFLICT',409,'Phiên bản bìa không khớp');const current=await this.readBytes(old.id);if(!Buffer.from(current.bytes).equals(Buffer.from(bytes)))throw new AppError('DRIVE_CONFLICT',409,'Nội dung bìa không khớp');return old.id;}
  const boundary='book-cover-'+crypto.randomUUID(),metadata={name,mimeType:'image/webp',parents:[folderId],appProperties:{metadataVersion:String(version)}};
  const body=Buffer.concat([Buffer.from('--'+boundary+'\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify(metadata)+'\r\n--'+boundary+'\r\nContent-Type: image/webp\r\n\r\n'),Buffer.from(bytes),Buffer.from('\r\n--'+boundary+'--')]);
  const response=await this.call('/upload/drive/v3/files?uploadType=multipart&fields='+fields,{method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body},false);this.metrics.bytesWritten+=bytes.length;return DriveFile.parse(await response.json()).id;
 }
}
export function createDrive(env:NodeJS.ProcessEnv,fetcher:typeof fetch=fetch,budget:Pick<DriveOptions,'maxRequests'|'maxBytes'>={}):GoogleDriveStorage{
 const {DRIVE_ROOT_ID,DRIVE_CLIENT_ID,DRIVE_CLIENT_SECRET,DRIVE_REFRESH_TOKEN}=env;
 if(!DRIVE_ROOT_ID||!DRIVE_CLIENT_ID||!DRIVE_CLIENT_SECRET||!DRIVE_REFRESH_TOKEN)throw new AppError('DRIVE_UNCONFIGURED',503,'Drive chưa được cấu hình');
 let access:string|undefined,expires=0;
 const token=async()=>{
  if(access&&expires>Date.now()+60_000)return access;
  let response:Response;try{response=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:DRIVE_CLIENT_ID,client_secret:DRIVE_CLIENT_SECRET,refresh_token:DRIVE_REFRESH_TOKEN}),signal:AbortSignal.timeout(5000),redirect:'error'});}catch{throw new AppError('DRIVE_AUTH',503,'Không refresh được quyền Drive');}
  const parsed=z.object({access_token:z.string().min(1),expires_in:z.number().positive()}).safeParse(await response.json());if(!response.ok||!parsed.success)throw new AppError('DRIVE_AUTH',503,'Cần kết nối lại Drive của chủ thư viện');
  access=parsed.data.access_token;expires=Date.now()+parsed.data.expires_in*1000;return access;
 };
 return new GoogleDriveStorage({rootId:DRIVE_ROOT_ID,token,fetch:fetcher,...budget});
}

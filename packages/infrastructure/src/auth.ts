import {z} from 'zod';
import {AppError} from '../../contracts/src/index';
const Identity=z.object({id:z.uuid(),email:z.email(),email_confirmed_at:z.string().min(1),app_metadata:z.object({provider:z.string().optional(),providers:z.array(z.string()).optional()})});
export type Identity = z.infer<typeof Identity>;
export interface AuthServices {verify(token:string):Promise<Identity>;rpc(name:string,args:Record<string,unknown>):Promise<unknown>;close?():Promise<void>;}
export function createAuthServices(env:NodeJS.ProcessEnv):AuthServices {
 if(!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)throw new AppError('AUTH_UNCONFIGURED',503,'Đăng nhập chưa được cấu hình');
 const base=new URL(env.SUPABASE_URL);
 if(base.protocol!=='https:')throw new AppError('AUTH_UNCONFIGURED',503,'Cấu hình đăng nhập không hợp lệ');
 const key=env.SUPABASE_SERVICE_ROLE_KEY;
 async function call(path:string,init:RequestInit) {
  try {return await fetch(new URL(path,base),{...init,signal:AbortSignal.timeout(5000)});}
  catch {throw new AppError('AUTH_UNAVAILABLE',503,'Dịch vụ đăng nhập chưa sẵn sàng');}
 }
 return {
  async verify(token) {
   const response=await call('/auth/v1/user',{headers:{apikey:key,Authorization:'Bearer '+token}});
   if(response.status===401 || response.status===403)throw new AppError('UNAUTHENTICATED',401,'Phiên đăng nhập đã hết hạn');
   if(!response.ok)throw new AppError('AUTH_UNAVAILABLE',503,'Dịch vụ đăng nhập chưa sẵn sàng');
   const parsed=Identity.safeParse(await response.json());
   if(!parsed.success || !(parsed.data.app_metadata.provider==='google'||parsed.data.app_metadata.providers?.includes('google')))throw new AppError('GOOGLE_REQUIRED',403,'Cần đăng nhập bằng Google');
   // Decode only AFTER Auth has verified the signed token. Never authorize decoded claims alone.
   let claims;
   try {claims=z.object({sub:z.uuid(),session_id:z.uuid(),exp:z.number(),iss:z.string(),role:z.literal('authenticated'),aud:z.union([z.string(),z.array(z.string())])}).parse(JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8')));}catch{throw new AppError('UNAUTHENTICATED',401,'Phiên đăng nhập không hợp lệ');}
   if(claims.sub!==parsed.data.id||claims.exp<=Date.now()/1000||claims.iss!==new URL('/auth/v1',base).href||!(Array.isArray(claims.aud)?claims.aud:[claims.aud]).includes('authenticated'))throw new AppError('UNAUTHENTICATED',401,'Phiên đăng nhập đã hết hạn');
   if(await this.rpc('app_session_active',{actor:parsed.data.id,target_session:claims.session_id})!==true)throw new AppError('UNAUTHENTICATED',401,'Phiên đăng nhập đã bị thu hồi');
   return parsed.data;
  },
  async rpc(name,args) {
   const response=await call('/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(args)});
   const body=await response.json();
   if(!response.ok) {
    const code=body?.code;
    if(code==='42501')throw new AppError('FORBIDDEN',403,'Tài khoản bị khóa hoặc không có quyền');
    if(code==='P0002')throw new AppError('NOT_FOUND',404,'Không tìm thấy dữ liệu');
    if(code==='55000')throw new AppError('CONFLICT',409,'Thao tác bị chặn; kiểm tra bảo trì hoặc đối soát dữ liệu cũ');
    if(code==='23514'||code==='23505'||code==='40001')throw new AppError('CONFLICT',409,'Dữ liệu đã thay đổi hoặc cần giữ quản trị viên cuối cùng');
    if(code==='22023')throw new AppError('INVALID_INPUT',400,'Dữ liệu không hợp lệ');
    throw new AppError('DATABASE_UNAVAILABLE',503,'Không xử lý được yêu cầu');
   }
   return body;
  }
 };
}

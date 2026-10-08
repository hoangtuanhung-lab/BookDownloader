import {createClient,type Session} from '@supabase/supabase-js';
const url=import.meta.env.VITE_SUPABASE_URL,key=import.meta.env.VITE_SUPABASE_ANON_KEY;
export const authClient=url&&key?createClient(url,key,{auth:{flowType:'pkce',persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,storageKey:'book:auth:session'}}):null;
let exchange:Promise<void>|undefined;
export function initialSession():Promise<Session|null> {
 return (async()=>{
  if(!authClient)return null;
  const params=new URLSearchParams(window.location.search);
  if(window.location.pathname==='/auth/callback') {
   const code=params.get('code');window.history.replaceState({},'','/auth/callback');
   if(params.has('error')||(!code&&!exchange))throw new Error('Không hoàn tất được đăng nhập Google');
   await (exchange??=(async()=>{const {error}=await authClient!.auth.exchangeCodeForSession(code!);if(error)throw new Error('Liên kết đăng nhập đã hết hạn. Hãy thử lại.');})());
  }
  const {data,error}=await authClient.auth.getSession();if(error)throw new Error('Không đọc được phiên đăng nhập');return data.session;
 })();
}
export async function googleLogin() {
 if(!authClient)throw new Error('Đăng nhập Google chưa được cấu hình');
 const {error}=await authClient.auth.signInWithOAuth({provider:'google',options:{redirectTo:window.location.origin+'/auth/callback',scopes:'openid email profile',queryParams:{prompt:'select_account'}}});
 if(error)throw new Error('Không bắt đầu được đăng nhập Google');
}
export function clearUserState() {
 for(const store of [localStorage,sessionStorage])for(const key of Object.keys(store))if(key.startsWith('book:user:'))store.removeItem(key);
}

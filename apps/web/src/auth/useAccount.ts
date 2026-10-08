import {useCallback,useEffect,useRef,useState} from 'react';
import type {Session} from '@supabase/supabase-js';
import {Account,AppError} from '../../../../packages/contracts/src/index';
import {authClient,clearUserState,initialSession} from './client';
export function useAccount() {
 const [account,setAccount]=useState<Account|null>(null),[pending,setPending]=useState(true),[error,setError]=useState('');
 const latestAccount=useRef<Account|null>(null),loadVersion=useRef(0),loggedOut=useRef(false);
 const session=useRef<Session|null>(null),generation=useRef(0),requests=useRef(new Set<AbortController>());
 const reset=useCallback(()=>{generation.current++;for(const c of requests.current)c.abort();requests.current.clear();clearUserState();latestAccount.current=null;setAccount(null);},[]);
 const call=useCallback(async(path:string,init:RequestInit={})=>{
  if(!session.current)throw new AppError('UNAUTHENTICATED',401,'Cần đăng nhập');
  const version=generation.current,controller=new AbortController();requests.current.add(controller);
  try {
   const res=await fetch('/api'+path,{...init,signal:controller.signal,headers:{...init.headers,'Authorization':'Bearer '+session.current.access_token,'Content-Type':'application/json'}});
   const body=await res.json();
   if(version!==generation.current)throw new Error('Phiên đăng nhập đã thay đổi');
   if(!res.ok){if(res.status===401||res.status===403){reset();}throw new AppError(body.error||'REQUEST_FAILED',res.status,body.message||'Không xử lý được yêu cầu');}
   return body;
  }finally{requests.current.delete(controller);}
 },[reset]);
 useEffect(()=>{
  let active=true;let refreshing=false;
  async function load(next:Session|null) {
   if(!active||loggedOut.current)return;
   const attempt=++loadVersion.current;
   const initial=session.current?.user.id!==next?.user.id;
   if(initial){reset();}
   session.current=next;
   if(!next){setPending(false);return;}
   if(initial)setPending(true);
   try {const result=Account.parse(await call('/me'));if(active&&attempt===loadVersion.current){if(result.id!==next.user.id)throw new Error('Tài khoản không hợp lệ');if(latestAccount.current?.permissions.some(p=>!result.permissions.includes(p)))reset();latestAccount.current=result;setAccount(result);setError('');}}
   catch(e){if(active&&attempt===loadVersion.current)setError(e instanceof Error?e.message:'Không kiểm tra được tài khoản');}
   finally{if(active&&attempt===loadVersion.current)setPending(false);}
  }
  void initialSession().then(load).catch(e=>{if(active){setError(e.message);setPending(false);}});
  const subscription=authClient?.auth.onAuthStateChange((event,next)=>{
   // Supabase forbids awaiting auth methods inside its callback; defer to next task.
   if(!loggedOut.current&&event!=='INITIAL_SESSION')setTimeout(()=>void load(next),0);
  });
  async function refresh(){if(!active||refreshing||!session.current)return;refreshing=true;try{await load(session.current);}finally{refreshing=false;}}
  const timer=setInterval(()=>void refresh(),30000);
  const focus=()=>void refresh();window.addEventListener('focus',focus);
  return()=>{active=false;subscription?.data.subscription.unsubscribe();clearInterval(timer);window.removeEventListener('focus',focus);reset();};
 },[call,reset]);
 async function logout(){loggedOut.current=true;loadVersion.current++;reset();session.current=null;setPending(false);setError('');try{await authClient?.auth.stopAutoRefresh();await authClient?.auth.signOut({scope:'local'});}finally{localStorage.removeItem('book:auth:session');localStorage.removeItem('book:auth:session-code-verifier');}}
 return {account,pending,error,call,logout};
}

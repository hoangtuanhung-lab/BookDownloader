import type {Page} from '@playwright/test';
export const user='95000000-0000-4000-8000-000000000001',other='95000000-0000-4000-8000-000000000002',book='96000000-0000-4000-8000-000000000001',book2='96000000-0000-4000-8000-000000000002';
export const chapterId=(n:number)=>`97000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const chapters=Array.from({length:12},(_,index)=>({id:chapterId(index+1),index,order:index?index:-.5,displayNumber:index===0?'*':index===1?'1-2':String(index),title:index===0?'Lời tựa':'Chương '+index+': Khởi đầu '+index,part:index<5?'Phần một':'',volume:index<5?'Quyển một':'',cacheTag:'tag-'+index}));
export async function fixture(page:Page){
 const progress=new Map<string,any>(),prefs=new Map<string,any>(),requests:{path:string;method:string;body:any}[]=[];let offline=false;
 await page.addInitScript(({user})=>{const jwt=[btoa(JSON.stringify({alg:'HS256',typ:'JWT'})),btoa(JSON.stringify({sub:user,exp:Math.floor(Date.now()/1000)+3600,aud:'authenticated'})),'synthetic-signature'].join('.');localStorage.setItem('book:auth:session',JSON.stringify({access_token:jwt,refresh_token:'fixture-refresh',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user:{id:user,aud:'authenticated',role:'authenticated',email:'sample@gmail.com',app_metadata:{provider:'google'},user_metadata:{},created_at:'2026-10-08'}}));},{user});
 await page.route('https://auth-fixture.test/**',route=>route.fulfill({json:{}}));
 const books=()=>[{id:book,name:'Đường về cổ tích',author:'Tác giả mẫu',genres:['Phiêu lưu'],label:'Hồi',chapterCount:12,hasCover:false,progress:null,progressIndex:null,version:1},{id:book2,name:'Truyện thứ hai',author:'Tác giả khác',genres:[],label:'Chương',chapterCount:0,hasCover:false,progress:null,progressIndex:null,version:1}];
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname.slice(4),method=request.method(),body=request.postData()?request.postDataJSON():null;requests.push({path:url.pathname,method,body});const owner=request.headers()['authorization']?.includes('other.')?other:user;
  if(path==='/health')return route.fulfill({json:{status:'ok',database:'ok',correlationId:user}});
  if(path==='/me')return route.fulfill({json:{id:owner,name:owner===user?'Synthetic reader':'Second reader',permissions:['read']}});
  if(path==='/me/preferences'){if(method==='PUT')prefs.set(owner,body);return route.fulfill({json:prefs.get(owner)||null});}
  if(path.startsWith('/me/progress/')){
   if(method==='PUT'){if(offline)return route.fulfill({status:503,json:{error:'OFFLINE',message:'Mạng chưa sẵn sàng'}});const old=progress.get(owner);if(body.expectedRevision!==(old?.revision||0))return route.fulfill({status:409,json:{error:'CONFLICT',message:'Tiến độ đã thay đổi'}});const {expectedRevision,...position}=body;progress.set(owner,{...position,revision:(old?.revision||0)+1,updatedAt:'2026-10-08T04:00:00Z'});}
   return route.fulfill({json:progress.get(owner)||null});
  }
  const list=books().map(b=>b.id===book?{...b,progress:progress.get(owner)||null,progressIndex:progress.get(owner)?chapters.findIndex(ch=>ch.id===progress.get(owner).chapterId):null}:b);
  if(path==='/books'){const q=(url.searchParams.get('q')||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').toLowerCase();const filtered=list.filter(b=>(b.name+' '+b.author+' '+b.genres.join(' ')).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').toLowerCase().includes(q));const offset=Number(url.searchParams.get('offset')||0);return route.fulfill({json:{books:filtered.slice(offset,offset+24),total:filtered.length,offset}});}
  const match=/^\/books\/([^/]+)(.*)$/.exec(path);if(!match)return route.fulfill({status:404,json:{message:'Missing'}});const b=list.find(b=>b.id===match[1]);if(!b)return route.fulfill({status:404,json:{error:'NOT_FOUND',message:'Truyện không còn tồn tại'}});
  if(!match[2])return route.fulfill({json:b});
  if(match[2]==='/chapters'){const offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||200);return route.fulfill({json:{book:b,chapters:b.id===book?chapters.slice(offset,offset+limit):[],total:b.chapterCount,offset}});}
  if(match[2]==='/cluster'){const start=Number(url.searchParams.get('start')||0);return route.fulfill({json:{start,items:chapters.slice(start,start+5).map(ch=>({id:ch.id,cacheTag:ch.cacheTag,title:ch.title,text:'Nội dung chương '+ch.index+' được viết cho kiểm thử.\n\n'+Array.from({length:75},(_,i)=>'Đoạn '+i+': Một câu chuyện tưởng tượng về chuyến đi, bạn bè và những điều mới mẻ. '+ 'Văn bản mẫu an toàn. '.repeat(5)).join('\n\n')+'\n\n<script>alert("XSS")</script>'}))}});}
  return route.fulfill({status:404,json:{message:'Missing'}});
 });
 return {progress,prefs,requests,setOffline:(value:boolean)=>offline=value};
}

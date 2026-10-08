import {GoogleDriveStorage,type DriveFile} from '../../packages/infrastructure/src/drive';
export function fixture(){
 const folder='application/vnd.google-apps.folder';
 const files=new Map<string,DriveFile>([['root',{id:'root',name:'Local staging',mimeType:folder,parents:[],trashed:false,appProperties:{},capabilities:{canAddChildren:true}}],['book',{id:'book',name:'Truyện mẫu',mimeType:folder,parents:['root'],trashed:false,appProperties:{}}],['outside',{id:'outside',name:'Private',mimeType:'text/plain',parents:[],trashed:false,appProperties:{}}]]);
 const bodies=new Map<string,string>();let serial=0;let pageSize=1000;
 const calls:{method:string;path:string}[]=[];const faults:{status?:number;reason?:string;timeout?:boolean}[]=[];
 const fetcher:typeof fetch=async(input,init)=>{
  const url=new URL(String(input)),method=init?.method||'GET';calls.push({method,path:url.pathname});const fault=faults.shift();if(fault){if(fault.timeout)throw new DOMException('timeout','TimeoutError');return Response.json({error:{errors:[{reason:fault.reason||'insufficientPermissions'}]}},{status:fault.status||503});}
  if(url.pathname==='/drive/v3/files'&&method==='GET'){
   const query=url.searchParams.get('q')||'';const parent=/^'([^']+)' in parents/.exec(query)?.[1];const escapedName=/ and name = '(.*)'$/.exec(query)?.[1];const name=escapedName?.replace(/\\'/g,"'").replace(/\\\\/g,'\\');
   const all=[...files.values()].filter(f=>f.parents.includes(parent||'')&&!f.trashed&&(name===undefined||f.name===name));const offset=Number(url.searchParams.get('pageToken')||0);const next=offset+pageSize;
   return Response.json({files:all.slice(offset,next),...(next<all.length?{nextPageToken:String(next)}:{})});
  }
  if(url.pathname==='/drive/v3/files'&&method==='POST'){const meta=JSON.parse(String(init?.body));const file={...meta,id:'created-'+ ++serial,trashed:false,appProperties:{}};files.set(file.id,file);return Response.json(file);}
  if(url.pathname.startsWith('/upload/drive/v3/files')){
   const body=String(init?.body);const meta=JSON.parse(body.split('\r\n\r\n')[1].split('\r\n--')[0]);const content=body.split('Content-Type: text/plain; charset=UTF-8\r\n\r\n')[1].split('\r\n--')[0];
   const target=url.pathname.split('/')[5]||'created-'+ ++serial;const file={...files.get(target),...meta,id:target,trashed:false};files.set(target,file);bodies.set(target,content);return Response.json(file);
  }
  const target=url.pathname.split('/')[4];const file=files.get(target);if(!file)return Response.json({error:'missing'},{status:404});
  if(url.searchParams.get('alt')==='media')return new Response(bodies.get(target)||'',{headers:{'Content-Type':file.mimeType}});
  return Response.json(file);
 };
 const drive=new GoogleDriveStorage({rootId:'root',token:async()=>'synthetic-access',fetch:fetcher,pause:async()=>{}});
 return {drive,files,bodies,calls,faults,fetcher,setPageSize:(n:number)=>pageSize=n};
}

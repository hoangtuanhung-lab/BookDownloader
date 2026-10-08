import {ChapterCluster,ReadingProgress,type ReaderChapter,type ClusterItem} from '../../../../packages/contracts/src/index';
export const normalizeSearch=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').toLowerCase();
export function chapterLabel(chapter:ReaderChapter,label:string,title=chapter.title){
 const clean=title.replace(/^(?:(?:quyển|quyen|tập|tap)\s*\d+\s*[-–:.]?\s*)?(?:chương|chuong|chapter|chap|hồi|hoi)\s*\d+(?:-\d+)?\s*[:.\-–]?\s*/i,'').trim();
 if(chapter.displayNumber==='*')return clean||'Lời nói đầu';
 const n=chapter.displayNumber||String(chapter.order);return label+' '+n+(clean?': '+clean:'');
}
export const fonts={'Literata':{css:'Literata, Georgia, serif',factor:1},'Merriweather':{css:'Merriweather, Georgia, serif',factor:.96},'Roboto':{css:"Roboto, system-ui, sans-serif",factor:.98},'EB Garamond':{css:"'EB Garamond', Garamond, Georgia, serif",factor:1.14},'Tinos':{css:"'Times New Roman', Tinos, Times, serif",factor:1.06}};
export class ClusterCache {
 private entries=new Map<number,{items:ClusterItem[];bytes:number}>();
 constructor(readonly scope:string,private maxBytes=4_000_000){}
 get(start:number,id:string,tag:string){const item=this.entries.get(start)?.items.find(i=>i.id===id&&i.cacheTag===tag);return tag?item:undefined;}
 put(input:unknown,keep:number){const value=ChapterCluster.parse(input),bytes=new TextEncoder().encode(JSON.stringify(value)).length;if(bytes>this.maxBytes)return;this.entries.delete(value.start);this.entries.set(value.start,{items:value.items,bytes});
 while(this.entries.size>2||this.bytes>this.maxBytes){const victim=[...this.entries.keys()].find(k=>k!==keep);if(victim===undefined)break;this.entries.delete(victim);}}
 clear(){this.entries.clear();}get bytes(){return [...this.entries.values()].reduce((n,e)=>n+e.bytes,0);}get size(){return this.entries.size;}
}
export const userKey=(user:string,suffix:string)=>'book:user:'+user+':'+suffix;
export function stored<T>(key:string,fallback:T):T {try{return JSON.parse(localStorage.getItem(key)||'null')??fallback;}catch{return fallback;}}
export function persist(key:string,value:unknown){try{localStorage.setItem(key,JSON.stringify(value));}catch{/* Storage may be unavailable; server sync remains usable. */}}
export type PendingPosition={chapterId:string;ratio:number;scrollPosition:number;expectedRevision:number;dirty:boolean};
export type Call=(path:string,init?:RequestInit)=>Promise<any>;
export class ProgressSync {
 revision=0;pending:PendingPosition|null=null;private sending:Promise<void>|null=null;private stopped=false;private blocked=false;
 constructor(private key:string,private path:string,private call:Call,private conflict:(server:unknown)=>void){}
 start(server:unknown){const value=server===null?null:ReadingProgress.parse(server);this.revision=value?.revision||0;const local=stored<PendingPosition|null>(this.key,null);
 if(local?.dirty&&Number.isSafeInteger(local.expectedRevision)&&typeof local.chapterId==='string'&&Number.isFinite(local.ratio)&&local.ratio>=0&&local.ratio<=1&&Number.isFinite(local.scrollPosition)&&local.scrollPosition>=0){this.pending=local;if(local.expectedRevision!==this.revision){this.blocked=true;this.conflict(value);return {server:value,local,conflict:true};}return {server:value,local,conflict:false};}
 return {server:value,local:null,conflict:false};}
 record(value:Omit<PendingPosition,'expectedRevision'|'dirty'>){if(this.stopped||this.blocked)return;this.pending={...value,expectedRevision:this.revision,dirty:true};persist(this.key,this.pending);}
 rebase(){this.blocked=false;if(this.pending){this.pending.expectedRevision=this.revision;persist(this.key,this.pending);}}
 discard(){this.blocked=false;this.pending=null;persist(this.key,null);}
 async flush(keepalive=false){if(this.stopped||this.blocked||!this.pending)return;if(this.sending){await this.sending;return;}
 const value=this.pending;this.sending=(async()=>{try{const {dirty,...dto}=value;const response=ReadingProgress.parse(await this.call(this.path,{method:'PUT',body:JSON.stringify(dto),keepalive}));if(this.stopped)return;this.revision=response.revision;
 if(this.pending===value){this.pending=null;persist(this.key,{...dto,expectedRevision:this.revision,dirty:false});}else if(this.pending){this.pending.expectedRevision=this.revision;persist(this.key,this.pending);}}
 catch(error:any){if(!this.stopped&&error.status===409){const server=await this.call(this.path).catch(()=>null);this.revision=server?ReadingProgress.parse(server).revision:0;this.blocked=true;this.conflict(server);}}finally{this.sending=null;}})();await this.sending;
 }
 stop(){this.stopped=true;this.pending=null;}
}

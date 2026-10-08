import {createHash} from 'node:crypto';
import {z} from 'zod';
import {normName_,normUrl_} from './legacy.mjs';
const Cell=z.union([z.string(),z.number(),z.boolean(),z.null()]);
export const LegacyExport=z.object({schemaVersion:z.literal(1),BOOKS:z.array(z.array(Cell)),CHAPTERS:z.array(z.array(Cell)),CONFIG:z.array(z.array(Cell)).default([]),LOG:z.array(z.array(Cell)).optional(),properties:z.record(z.string(),z.string()).default({}),files:z.array(z.object({id:z.string(),name:z.string().optional(),parents:z.array(z.string()).default([]),trashed:z.boolean().default(false),sizeBytes:z.number().nonnegative().optional()})).default([]),inventoryComplete:z.boolean().default(false)});
export function migrationId(kind:string,legacy:string){const bytes=createHash('sha256').update('bookdownloader:migration:v1:'+kind+':'+legacy).digest().subarray(0,16);bytes[6]=(bytes[6]&15)|128;bytes[8]=(bytes[8]&63)|128;const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
const statusMap:Record<string,string>={ANALYZED:'ANALYZED',IDLE:'QUEUED',READY:'QUEUED',DOWNLOADING:'DOWNLOADING',PAUSED:'PAUSED',COMPLETED:'DONE',ERROR:'ERROR'};
export function dryRunMigration(input:unknown){
 const data=LegacyExport.parse(input);const issues:{severity:'error'|'warning';code:string;entity:string;row:number}[]=[];
 const issue=(code:string,entity:string,row:number,severity:'error'|'warning'='error')=>issues.push({severity,code,entity,row});
 const seen={id:new Set<string>(),name:new Set<string>(),url:new Set<string>(),folder:new Set<string>(),chapter:new Set<string>(),file:new Set<string>()};
 const files=new Map(data.files.map(f=>[f.id,f]));if(files.size!==data.files.length)issue('DUPLICATE_INVENTORY_ID','inventory',0);
 const books=data.BOOKS.map((r,index)=>{
  const [legacy,name,url,site,folder,,,,status]=r.map(v=>String(v??''));const row=index+2;
  if(r.length!==13)issue('BOOK_COLUMN_COUNT',legacy,row);if(!legacy||seen.id.has(legacy))issue('DUPLICATE_OR_EMPTY_BOOK_ID',legacy,row);seen.id.add(legacy);
  const normalized=normName_(name);if(!normalized||name.length>120||seen.name.has(normalized))issue('DUPLICATE_OR_INVALID_NAME',legacy,row);seen.name.add(normalized);
  if(url){const normalizedUrl=normUrl_(url);if(seen.url.has(normalizedUrl))issue('DUPLICATE_URL',legacy,row);seen.url.add(normalizedUrl);try{if(!['http:','https:'].includes(new URL(url).protocol))throw Error();}catch{issue('INVALID_URL',legacy,row);}}
  if(folder){if(seen.folder.has(folder))issue('DUPLICATE_FOLDER',legacy,row);seen.folder.add(folder);if(data.inventoryComplete&&(!files.has(folder)||files.get(folder)?.trashed))issue('MISSING_BOOK_FOLDER',legacy,row);}else issue('MISSING_BOOK_FOLDER',legacy,row);
  if(String(r[10]??'').length>100||String(r[11]??'').split(/[,;\/]/).map(s=>s.trim()).filter(Boolean).length>6)issue('INVALID_BOOK_METADATA',legacy,row);
  if([r[5],r[6],r[7]].some(v=>!Number.isSafeInteger(Number(v))||Number(v)<0))issue('INVALID_BOOK_COUNTS',legacy,row);
  if(!statusMap[status])issue('UNKNOWN_BOOK_STATUS',legacy,row);
  const sourceType=site==='FILE'||site==='FOLDER'?site:'WEB';if(sourceType==='WEB'&&!url)issue('MISSING_SOURCE_URL',legacy,row);
  return {legacyId:legacy,id:migrationId('book',legacy),total:Number(r[5]||0),done:Number(r[6]||0),errorCount:Number(r[7]||0),created:String(r[9]??''),name,author:String(r[10]??''),genres:String(r[11]??'').split(/[,;\/]/).map(s=>s.trim()).filter(Boolean),label:String(r[12]||'Chương'),sourceUrl:url,sourceType,legacySite:site,legacyStatus:status,folderId:folder,status:statusMap[status]||null,visibility:'hidden',version:1};
 });
 const bookMap=new Map(books.map(b=>[b.legacyId,b]));const groups=new Map<string,{id:string;bookId:string;parentId:string|null;kind:string;name:string;orderKey:number}>();
 const chapters=data.CHAPTERS.map((r,index)=>{
  const legacy=String(r[0]??''),order=Number(r[1]),row=index+2,key=legacy+':'+String(r[1]);const book=bookMap.get(legacy);
  if(r.length!==12)issue('CHAPTER_COLUMN_COUNT',key,row);if(!book)issue('ORPHAN_CHAPTER',key,row);
  if(r[1]===''||r[1]===null||!Number.isFinite(order)||seen.chapter.has(key))issue('DUPLICATE_OR_INVALID_ORDER',key,row);seen.chapter.add(key);
  if(!Number.isSafeInteger(Number(r[6]||0))||Number(r[6]||0)<0)issue('INVALID_RETRY_COUNT',key,row);
  const status=String(r[4]),file=String(r[5]??'');if(!['PENDING','DONE','ERROR'].includes(status))issue('UNKNOWN_CHAPTER_STATUS',key,row);
  if(file){if(seen.file.has(file))issue('DUPLICATE_FILE',key,row);seen.file.add(file);if(data.inventoryComplete&&(!files.has(file)||files.get(file)?.trashed))issue('MISSING_CHAPTER_FILE',key,row);}else if(status==='DONE')issue('MISSING_CHAPTER_FILE',key,row);
  // Confirm ancestry in a complete inventory; never authorize imports by file ID alone.
  if(file&&book&&data.inventoryComplete&&files.has(file)&&files.has(book.folderId)){
   let current=file;const visited=new Set<string>();let belongs=false;
   for(let depth=0;depth<32;depth++){if(current===book.folderId){belongs=true;break;}if(visited.has(current))break;visited.add(current);const parents=files.get(current)?.parents;if(parents?.length!==1)break;current=parents[0];}
   if(!belongs)issue('FILE_OUTSIDE_BOOK',key,row);
  }
  let parentId:string|null=null;for(const [kind,value] of [['PART',r[9]],['VOLUME',r[10]]] as const){const name=String(value??'');if(!name)continue;const groupKey=legacy+':'+kind+':'+(parentId||'')+':'+name;const groupId=migrationId('group',groupKey);if(!groups.has(groupKey))groups.set(groupKey,{id:groupId,bookId:book?.id||migrationId('book',legacy),parentId,kind,name,orderKey:groups.size});parentId=groupId;}
  return {legacyId:key,id:migrationId('chapter',key),bookId:book?.id||null,legacyOrder:order,orderKey:order,displayNumber:String(r[11]??''),title:String(r[2]??''),sourceUrl:String(r[3]??''),status,fileId:file||null,groupId:parentId,retryCount:Number(r[6]||0),error:String(r[7]??''),updated:String(r[8]??'')};
 });
 const counts=new Map<string,{total:number;done:number;error:number}>();
 for(const chapter of chapters){if(!chapter.bookId)continue;const count=counts.get(chapter.bookId)||{total:0,done:0,error:0};count.total++;if(chapter.status==='DONE')count.done++;if(chapter.status==='ERROR')count.error++;counts.set(chapter.bookId,count);}
 for(const [index,book] of books.entries()){const count=counts.get(book.id)||{total:0,done:0,error:0};if(count.total!==book.total||count.done!==book.done||count.error!==book.errorCount)issue('COUNT_MISMATCH',book.legacyId,index+2,'warning');}
 if(!data.inventoryComplete)issue('INVENTORY_NOT_COMPLETE','inventory',0,'warning');
 const safeConfig=Object.fromEntries(data.CONFIG.filter(r=>['ROOT_FOLDER','ROOT_FOLDER_ID','BATCH_SIZE','DELAY_MS','MAX_RETRY','MAX_CONCURRENT','FILE_TYPE','ENCODING','AUTO_RESUME','JUNK_WORDS','SITE_RULES','GENRES'].includes(String(r[0]))).map(r=>[String(r[0]),r[1]]));
 const safeProperties=Object.fromEntries(Object.entries(data.properties).filter(([key])=>['ROOT_FOLDER_ID','ROOT_FOLDER'].includes(key)||/^(FLD_|DEL_)/.test(key)));
 return {schemaVersion:1,dryRun:true,remoteWrites:0,ready:data.inventoryComplete&&!issues.some(i=>i.severity==='error'),totals:{books:books.length,chapters:chapters.length,groups:groups.size,files:files.size,errors:issues.filter(i=>i.severity==='error').length,warnings:issues.filter(i=>i.severity==='warning').length},issues,idMap:{books:books.map(b=>({legacyId:b.legacyId,id:b.id})),chapters:chapters.map(c=>({legacyId:c.legacyId,id:c.id}))},books,chapters,groups:[...groups.values()],config:safeConfig,legacyLogRows:data.LOG?.length??null,properties:safeProperties};
}

import {z} from 'zod';
import {AppError} from '../../contracts/src/index';
import {stripFileHead_,tidyChapter_} from '../../domain/src/legacy.mjs';
import {createDrive,type GoogleDriveStorage} from './drive';
import type {AuthServices} from './auth';
export interface ReaderStorage {readText(fileId:string):Promise<string>;readBytes(fileId:string):Promise<{bytes:Uint8Array;mimeType:string}>;}
const Content=z.object({text:z.string(),title:z.string()});
const Resource=z.object({fileId:z.string(),bookName:z.string(),sourceType:z.enum(['WEB','FILE','FOLDER']),cacheKey:z.string(),cached:Content.nullable(),junkWords:z.string().default('')});
export async function readStoredChapter(services:AuthServices,storage:ReaderStorage,actor:string,book:string,chapter:string){
 const args={actor,target_book:book,target_chapter:chapter};
 const resource=Resource.parse(await services.rpc('app_reader_resource',args));
 if(resource.cached)return resource.cached;
 const source=await storage.readText(resource.fileId);
 const head=stripFileHead_(source.replace(/\r/g,''),resource.sourceType==='FOLDER',resource.bookName);
 const cleaned=tidyChapter_(head.body,resource.junkWords);
 const content=Content.parse({text:cleaned.body,title:cleaned.title||head.headTitle});
 // Recheck mapping, visibility and permissions after remote IO, before response/cache write.
 await services.rpc('app_reader_cache',{...args,expected_key:resource.cacheKey,new_value:content});
 return content;
}
export async function readStoredCover(services:AuthServices,storage:ReaderStorage,actor:string,book:string){
 const args={actor,target_book:book,target_chapter:null};const resource=Resource.parse(await services.rpc('app_reader_resource',args));
 const {bytes,mimeType}=await storage.readBytes(resource.fileId);
 const type=bytes.length>=8&&Buffer.from(bytes.slice(0,8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':bytes.length>=12&&Buffer.from(bytes.slice(0,4)).toString()==='RIFF'&&Buffer.from(bytes.slice(8,12)).toString()==='WEBP'?'image/webp':'';
 if(!type||type!==mimeType||bytes.length>2_000_000)throw new AppError('INVALID_COVER',415,'Ảnh bìa cần PNG, JPEG hoặc WebP');
 const latest=Resource.parse(await services.rpc('app_reader_resource',args));if(latest.cacheKey!==resource.cacheKey)throw new AppError('CONFLICT',409,'Ảnh bìa đã thay đổi');
 return {bytes,mimeType:type};
}
export function readerStorage(env:NodeJS.ProcessEnv):GoogleDriveStorage{return createDrive(env);}

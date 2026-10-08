import {formatBookInfo} from './index';
import {cleanName_,genreFolderName_,docChapterFile_,importFileName_,logCell_} from './legacy.mjs';
import type {BookMetadata} from '../../contracts/src/index';
import type {DriveStorage,Clock} from './ports';
export interface LibraryStorage extends DriveStorage {folder(parent:string,name:string):Promise<string>;}
export async function ensureBookFolder(storage:LibraryStorage,root:string,book:BookMetadata){
 const genre=await storage.folder(root,genreFolderName_(book.genres.join(', ')));
 const folder=await storage.folder(genre,cleanName_(book.name));
 const infoId=await storage.putText(folder,'info.txt',formatBookInfo({...book,sourceUrl:book.sourceType==='WEB'?book.sourceUrl:''}),book.version);
 return {folderId:folder,infoId};
}
export async function writeChapter(storage:LibraryStorage,folder:string,bookName:string,label:string,ch:Parameters<typeof docChapterFile_>[2],version:number){
 let target=folder;for(const name of [ch.part,ch.vol])if(cleanName_(name))target=await storage.folder(target,cleanName_(name));
 return storage.putText(target,importFileName_(label,ch),docChapterFile_(bookName,label,ch),version);
}
export const importDataName='_import.json';
export function removedLine(item:{num:number;dnum?:string;part?:string;vol?:string;title?:string;url?:string;reason:string},clock:Clock){
 const time=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Ho_Chi_Minh',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(clock.now()).replace(',','');
 return [time,'Chương '+logCell_(item.dnum&&item.dnum!=='*'?item.dnum:item.num),logCell_([item.part,item.vol].filter(Boolean).join(' › '))||'(không có)',logCell_(item.title)||'(chưa rõ)',logCell_(item.url)||'(không có)',logCell_(item.reason)].join(' | ');
}
export async function saveImportData(storage:DriveStorage,folder:string,chapters:unknown[],version:number){return storage.putText(folder,importDataName,JSON.stringify(chapters),version);}
export async function loadImportData(storage:DriveStorage,fileId:string):Promise<Record<string,unknown>>{
 const chapters:unknown=JSON.parse(await storage.readText(fileId));if(!Array.isArray(chapters))throw new Error('Invalid import data');
 const map:Record<string,unknown>=Object.create(null);for(const chapter of chapters){if(!chapter||typeof chapter!=='object'||!('num' in chapter)||typeof chapter.num!=='number'||!Number.isFinite(chapter.num))throw new Error('Invalid import chapter');map[String(chapter.num)]=chapter;}return map;
}
export const removedLogName='_Chương lỗi đã xóa.txt';
export async function appendRemovedLog(storage:DriveStorage,folder:string,bookName:string,existingId:string|null,items:Parameters<typeof removedLine>[0][],version:number,clock:Clock){
 if(!items.length)return existingId;
 const head=existingId?await storage.readText(existingId):'Các chương lỗi đã bị xóa khỏi truyện "'+bookName+'".\nMỗi dòng: thời điểm | chương | phần › quyển | tiêu đề | link | lý do.\nMuốn thêm lại: mở truyện ở Quản lý sách, bấm ✏️, mục Thêm chương, chọn đúng Phần, Quyển, thứ tự chương rồi dán link.\n\n';
 return storage.putText(folder,removedLogName,head+items.map(item=>removedLine(item,clock)).join('\n')+'\n',version);
}

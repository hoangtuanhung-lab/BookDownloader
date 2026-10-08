import type { BookMetadata, JobKind } from '../../contracts/src/index';
export interface BookRepository { get(id:string):Promise<BookMetadata|null>; save(book:BookMetadata, expectedVersion:number):Promise<void>; }
export interface DriveStorage { readText(fileId:string):Promise<string>; putText(folderId:string,name:string,content:string,version:number):Promise<string>; }
export interface HttpFetcher { get(url:string,signal:AbortSignal):Promise<{body:string;finalUrl:string}>; }
export interface JobRepository { claim(workerId:string,kind:JobKind,leaseSeconds:number):Promise<{id:string;checkpoint:unknown}|null>; checkpoint(id:string,workerId:string,value:unknown):Promise<void>; }
export interface Clock { now():Date; }

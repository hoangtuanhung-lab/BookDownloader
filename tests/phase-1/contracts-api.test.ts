import test from 'node:test';
import assert from 'node:assert/strict';
import {BookMetadata,ReaderBook,HealthResponse} from '../../packages/contracts/src/index';
import {handleApi} from '../../netlify/functions/api';
const book={id:'10000000-0000-4000-8000-000000000001',name:'Truyện mẫu',author:'Tác giả mẫu',genres:['Kỳ ảo'],sourceUrl:'',sourceType:'FILE',visibility:'hidden',version:1};
test('valid file metadata; invalid WEB URL, version, unknown field rejected',()=>{
 assert(BookMetadata.safeParse(book).success);
 for(const mutation of [{sourceType:'WEB'},{sourceUrl:'javascript:alert(1)'},{version:0},{serviceKey:'secret'}])assert(!BookMetadata.safeParse({...book,...mutation}).success);
});
test('reader DTO excludes source/Drive/operational data',()=>{
 const dto={id:book.id,name:book.name,author:book.author,genres:book.genres};assert(ReaderBook.safeParse(dto).success);
 for(const field of ['sourceUrl','fileId','workerError','serviceKey'])assert(!ReaderBook.safeParse({...dto,[field]:'sensitive'}).success);
});
test('health checks DB and returns correlated no-store response',async()=>{
 let calls=0;const res=await handleApi(new Request('https://app.test/api/health'),{},async()=>{calls++;});
 assert.equal(calls,1);assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');
 const json=HealthResponse.parse(await res.json());assert.equal(json.correlationId,res.headers.get('x-correlation-id'));
});
test('unavailable DB fails health and never exposes credentials/errors',async()=>{
 const res=await handleApi(new Request('https://app.test/api/health'),{},async()=>{throw new Error('token=DO_NOT_LOG database password');});
 assert.equal(res.status,503);const body=await res.text();assert(!body.includes('DO_NOT_LOG'));assert(!body.includes('password'));
});
test('missing DB configuration cannot report ready',async()=>{
 const res=await handleApi(new Request('https://app.test/api/health'),{});assert.equal(res.status,503);
});
test('unimplemented/mutation endpoints do not report success',async()=>{
 for(const [path,method] of [['/api/books','GET'],['/api/health','POST']])assert.equal((await handleApi(new Request('https://app.test'+path,{method}),{})).status,501);
});

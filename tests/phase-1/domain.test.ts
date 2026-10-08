import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as domain from '../../packages/domain/src/legacy.mjs';
import {formatBookInfo,matchesDomain} from '../../packages/domain/src/index';
const cases=JSON.parse(readFileSync('tests/baseline/cases.json','utf8'));
const golden=JSON.parse(readFileSync('tests/baseline/golden.json','utf8')).cases;
function resolve(value:any):any {
 if(Array.isArray(value))return value.map(resolve);
 if(value&&typeof value==='object')return Object.keys(value).length===1&&value.fixture ? readFileSync('tests/baseline/fixtures/'+value.fixture,'utf8'):Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolve(v)]));
 return value;
}
const excluded=['legacy-domain-substring','legacy-cookie-substring'];
const selected=cases.filter((c:any)=>!excluded.includes(c.id)&&(c.call==='getChapter_'||c.call in domain||['metadata','gap','url-template','paired-import'].includes(c.driver)));
for(const spec of selected) test('ported golden: '+spec.id,()=>{
 const args=resolve(spec.args||[]);let output;
 try {
  let value;
  if(spec.call==='getChapter_')value=domain.parseChapterHtml_(readFileSync('tests/baseline/fixtures/'+spec.pages[args[0]],'utf8'),...args);
  else if(spec.driver==='metadata')value={name:domain.bookName_(args[0],'fiction.test'),author:domain.authorName_(args[0]),genre:domain.genreNames_(args[0])};
  else if(spec.driver==='gap'){const notes:any[]=[];value={chapters:domain.fillSequentialGap_(args[0],notes),notes};}
  else if(spec.driver==='url-template'){const tpl=domain.chapterUrlTemplate_(args[0]);value=tpl?args[1].map(tpl):null;}
  else if(spec.driver==='paired-import') {
   const toc=domain.parseMarkedFile_(args[0],'mục lục'),story=domain.parseMarkedFile_(args[1],'truyện');
   domain.fillMissingNums_(toc.items);domain.fillMissingNums_(story.items);const merged=domain.mergeTocStory_(toc.items,story.items);
   value={levels:Math.max(toc.levels,story.levels),label:toc.label,missing:merged.missing,extra:merged.extra,chapters:domain.numberMarkedList_(merged.list)};
  } else value=(domain as any)[spec.call](...args);
  output={value:JSON.parse(JSON.stringify(value))};
 } catch(e:any){output={error:{type:e.type||'Error',message:e.message}};}
 assert.deepEqual(output,golden[spec.id]);
});
test('port coverage stays explicit',()=>assert.equal(selected.length,62));
for(const id of ['info-full','info-file-source-blank'])test('info formatter golden: '+id,()=>{
 const book=cases.find((c:any)=>c.id===id).args[0];
 assert.equal(formatBookInfo({name:book.name,author:book.author||'',genres:book.genre?book.genre.split(', '):[],sourceUrl:book.url||''}),golden[id].value[0].content);
});
test('domain boundary intentionally rejects legacy substring match',()=>{
 assert.equal(matchesDomain('notfiction.test','fiction.test'),false);assert.equal(matchesDomain('fiction.test.evil.test','fiction.test'),false);
 assert.equal(matchesDomain('sub.fiction.test','fiction.test'),true);
 assert.deepEqual(domain.siteRule_('https://notfiction.test/',{SITE_RULES:'fiction.test:content=secret'}),{content:[],title:[],link:''});
});

test('cookie config follows DNS boundary',()=>{
 assert.equal(domain.siteCookie_('https://notfiction.test/',{SITE_COOKIES:'fiction.test=private-cookie'}),'');
 assert.equal(domain.siteCookie_('https://sub.fiction.test/',{SITE_COOKIES:'fiction.test=private-cookie'}),'private-cookie');
});

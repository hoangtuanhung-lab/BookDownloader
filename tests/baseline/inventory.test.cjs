const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {root,parseCsv,createRuntime}=require('../../tools/baseline/legacy-runtime.cjs');
const inventory=require('../../docs/phase-0/inventory.json');
test('all actual API signatures and 42 feature groups have phase and acceptance coverage',()=>{
  const source=fs.readFileSync(path.join(root,'Code.gs'),'utf8');
  const actual=[...source.matchAll(/^function (api_\w+)\(([^)]*)\)/gm)].map(m=>({name:m[1],parameters:m[2].split(',').map(v=>v.trim()).filter(Boolean)}));
  assert.equal(actual.length,34); assert.deepEqual(inventory.apis.map(({name,parameters})=>({name,parameters})),actual);
  assert.deepEqual(inventory.features.map(f=>f.id),[...Array.from({length:38},(_,i)=>'F'+String(i+1).padStart(2,'0')),...Array.from({length:4},(_,i)=>'N'+String(i+1).padStart(2,'0'))]);
  for(const f of inventory.features){assert(f.phases);assert(f.acceptanceCases.length);assert.equal(f.implementationEvidence,'planned; not executed against the new app');}
  for(const api of inventory.apis){assert(api.target);assert(api.permission);assert(api.acceptanceCases.length>=3);}
});
test('template includes exist and server/browser sources parse',()=>{
  const vm=require('node:vm');createRuntime();let browserScripts=0,includes=0;
  for(const name of fs.readdirSync(root).filter(n=>n.endsWith('.html'))) {
    const source=fs.readFileSync(path.join(root,name),'utf8');
    for(const m of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)){new vm.Script(m[1],{filename:name});browserScripts++;}
    for(const m of source.matchAll(/include\(['"]([^'"]+)['"]\)/g)){assert(fs.existsSync(path.join(root,m[1]+'.html')));includes++;}
  }
  assert.equal(browserScripts,3);assert.equal(includes,10);
});
test('CSV stand-in handles commas, quotes, multiline fields and CRLF independently',()=>{
  assert.deepEqual(parseCsv('a,b\r\n1,"x, y"\r\n2,"line1\nline2 ""quoted"""'),[['a','b'],['1','x, y'],['2','line1\nline2 "quoted"']]);
  assert.throws(()=>parseCsv('"unterminated'),/Unclosed/);
});
test('fixture fetcher refuses any unregistered network URL',()=>{
  const {ctx}=createRuntime();assert.throws(()=>ctx.fetch_('https://live.example.com/'),/Fixture URL not registered/);
});

const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {root,baselineCommit,runCase,source}=require('../../tools/baseline/legacy-runtime.cjs');
const cases=require('./cases.json'),golden=require('./golden.json'),inventory=require('../../docs/phase-0/inventory.json');
test('baseline source hashes and existing info suite remain exactly pinned',()=>{
  assert.equal(inventory.baselineCommit,baselineCommit); assert.equal(golden.baselineCommit,baselineCommit);
  assert.equal(inventory.version,'1.59.2'); assert.equal(inventory.files.length,29);
  for(const f of [...inventory.files,inventory.legacyInfoTest]) {
    const bytes=fs.readFileSync(path.join(root,f.path));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),f.sha256,f.path);
    assert.equal(Buffer.compare(bytes,Buffer.from(source(f.path,true))),0,f.path);
  }
});
test('every golden case has one reviewed snapshot and all expected errors are typed',()=>{
  assert.equal(new Set(cases.map(c=>c.id)).size,cases.length);
  assert.deepEqual(Object.keys(golden.cases).sort(),cases.map(c=>c.id).sort());
  const expectedErrors=['invalid-book-url','formula-input-rejected','chapter-too-short','chapter-no-content','discover-broken-pagination','discover-missing-chapters','import-no-headings','marked-malformed','duplicate-group-display-number','flat-chapter-inside-volume','invalid-chapter-order'];
  assert.deepEqual(Object.entries(golden.cases).filter(([,v])=>v.error).map(([k])=>k).sort(),expectedErrors.sort());
  for(const output of Object.values(golden.cases)) if(output.error)assert.notEqual(output.error.type,'Error');
});
for(const spec of cases) test(`legacy golden: ${spec.id}`,()=>assert.deepEqual(runCase(spec),golden.cases[spec.id]));
test('independent review anchors metadata, CSV semantics and chapter insertion',()=>{
  assert.deepEqual(golden.cases['metadata-jsonld'].value,{name:'Hành trình mẫu',author:'Nguyễn Văn An',genre:'Phiêu lưu, Kỳ ảo'});
  assert.equal(golden.cases['import-chapters.csv'].value.chapters[1].title,'Tên, có dấu phẩy');
  assert.equal(golden.cases['import-chapters.csv'].value.chapters[1].body,'Dòng một\nDòng hai có "ngoặc kép".');
  assert.deepEqual(golden.cases['insert-between-group-chapters'].value,{num:2,dnum:2});
  assert.equal(golden.cases['info-update-no-duplicate'].value.length,1);
  assert.equal(golden.cases['info-update-no-duplicate'].value[0].writes,1);
  assert.deepEqual(golden.cases['empty-runs-63'].value,[1]);
  assert.deepEqual(golden.cases['empty-runs-64'].value,[]);
  assert.deepEqual(golden.cases['empty-runs-65'].value,[]);
});
test('goldens detect an in-memory ordinal algorithm mutation without changing source',()=>{
  const spec=cases.find(c=>c.call==='vnOrdinalToNum_' && c.args[0]==='hai mươi mốt');
  const mutant=runCase(spec,{transformSource:(name,text)=>name==='Cleaner.gs'?text.replace('return any ? total + chunk : null','return any ? total + chunk + 1 : null'):text});
  assert.equal(mutant.value,22); assert.notDeepEqual(mutant,golden.cases[spec.id]);
});
test('goldens detect an in-memory chapter threshold mutation',()=>{
  const spec=cases.find(c=>c.id==='chapter-explicit-selector');
  const mutant=runCase(spec,{transformSource:(name,text)=>name==='Parser.gs'?text.replace('if (text.length < 50)','if (text.length < 500)'):text});
  assert.equal(mutant.error.type,'TOO_SHORT'); assert.notDeepEqual(mutant,golden.cases[spec.id]);
});

const test=require('node:test'),assert=require('node:assert/strict');
const {profileLibrary}=require('../../tools/baseline/profile-library.cjs');
const {syntheticLibrary}=require('../../tools/baseline/synthetic-library.cjs');
test('profiles a representative synthetic library without printing identifying data',()=>{
  const result=profileLibrary(syntheticLibrary({books:14,chaptersPerBook:9}));
  assert.equal(result.books,14);assert.equal(result.chapters,126);assert.equal(result.maxChaptersPerBook,9);
  assert.deepEqual(result.sourceTypes,{WEB:5,FILE:5,FOLDER:4});assert.equal(result.files.missingReferencedFiles,0);
  assert.equal(result.twoLevelDisplayNumbers,14);assert.equal(result.fractionalOrderChapters,14);assert.equal(result.doneWithoutFile,14);
  assert.deepEqual(result.issues,{});
  const out=JSON.stringify(result);assert(!out.includes('Truyện mẫu'));assert(!out.includes('fiction.test'));
});
test('missing referenced file is reported without live Drive access',()=>{
  const data=syntheticLibrary({books:1,chaptersPerBook:9});data.files.pop();
  assert.equal(profileLibrary(data).files.missingReferencedFiles,1);
});
test('duplicates and orphan chapters are diagnosed',()=>{
  const data=syntheticLibrary({books:1,chaptersPerBook:9});data.books.push(data.books[0].slice());data.chapters[0][0]='other-book';
  assert.deepEqual(profileLibrary(data).issues,{duplicate_book_id:1,duplicate_folder_id:1,orphan_chapter:1});
});
test('malformed rows and invalid size fail instead of manufacturing statistics',()=>{
  assert.throws(()=>profileLibrary({books:[],chapters:[]}),/schemaVersion/);
  const data=syntheticLibrary({books:1,chaptersPerBook:1});data.chapters[0].pop();assert.throws(()=>profileLibrary(data),/CHAPTERS/);
  const other=syntheticLibrary({books:1,chaptersPerBook:9});other.files[0].sizeBytes=-1;assert.throws(()=>profileLibrary(other),/sizeBytes/);
});
test('actual owner library remains explicitly unknown in the saved report',()=>{
  const report=require('../../docs/phase-0/library-profile.json');assert.equal(report.realLibrary.status,'not_supplied');assert.equal(report.realLibrary.books,null);
  assert.equal(report.synthetic[1].chapters,20000);assert.equal(report.synthetic[2].maxChaptersPerBook,20000);
});

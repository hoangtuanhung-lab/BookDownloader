// Offline, read-only aggregate profiler. Never downloads Drive content or prints book names/URLs.
const fs = require('node:fs');
function profileLibrary(data) {
  if (data.schemaVersion !== 1 || !Array.isArray(data.books) || !Array.isArray(data.chapters)) throw new Error('Expected schemaVersion=1 with BOOKS/CHAPTERS row arrays.');
  const ids = new Set(), folders = new Set(), byBook = new Map(), statuses = {}, sourceTypes = {}, issues = [];
  for (const row of data.books) {
    if (!Array.isArray(row) || row.length !== 13 || !row[0]) throw new Error('Invalid BOOKS row; expected 13 columns and nonempty ID.');
    if (ids.has(row[0])) issues.push('duplicate_book_id');
    if (folders.has(row[4])) issues.push('duplicate_folder_id');
    ids.add(row[0]); folders.add(row[4]); byBook.set(row[0],0);
    statuses[row[8]] = (statuses[row[8]] || 0) + 1;
    const source = ['FILE','FOLDER'].includes(row[3]) ? row[3] : 'WEB'; sourceTypes[source] = (sourceTypes[source] || 0) + 1;
  }
  const chapterStatuses = {}; let grouped=0, fractional=0, twoLevel=0, skipped=0;
  const chapterFileIds=new Set();
  for (const row of data.chapters) {
    if (!Array.isArray(row) || row.length !== 12) throw new Error('Invalid CHAPTERS row; expected 12 columns.');
    if (!ids.has(row[0])) issues.push('orphan_chapter');
    else byBook.set(row[0],byBook.get(row[0])+1);
    chapterStatuses[row[4]]=(chapterStatuses[row[4]] || 0)+1;
    if (row[9] || row[10]) grouped++;
    if (Number.isFinite(Number(row[1])) && !Number.isInteger(Number(row[1]))) fractional++;
    if (typeof row[11]==='string' && /^\d+-\d+$/.test(row[11])) twoLevel++;
    if (row[4]==='DONE' && !row[5]) skipped++;
    if (row[5]) chapterFileIds.add(row[5]);
  }
  const files=data.files || [];
  const fileIds=new Set(), sizes=[];
  for (const f of files) {
    if (!f.id || !Number.isSafeInteger(f.sizeBytes) || f.sizeBytes<0) throw new Error('File metadata requires id and nonnegative integer sizeBytes.');
    if(fileIds.has(f.id)) issues.push('duplicate_file_id');
    fileIds.add(f.id); sizes.push(f.sizeBytes);
  }
  const missing=files.length ? [...chapterFileIds].filter(id=>!fileIds.has(id)).length : null;
  const percentile=p=>sizes.length ? sizes[Math.max(0,Math.ceil(sizes.length*p)-1)] : null;
  sizes.sort((a,b)=>a-b);
  return { provenance:data.provenance || 'unspecified', books:data.books.length,chapters:data.chapters.length,
    maxChaptersPerBook:Math.max(0,...byBook.values()),sourceTypes,bookStatuses:statuses,chapterStatuses,
    groupedChapters:grouped,fractionalOrderChapters:fractional,twoLevelDisplayNumbers:twoLevel,doneWithoutFile:skipped,
    files:{count:sizes.length,totalBytes:sizes.reduce((a,b)=>a+b,0),p50Bytes:percentile(.5),p95Bytes:percentile(.95),maxBytes: sizes.at(-1) ?? null,missingReferencedFiles:missing},
    issues:Object.fromEntries([...new Set(issues)].map(i=>[i,issues.filter(x=>x===i).length])),
    note:'Counts and sizes only; does not verify live Drive existence, access, content, quota or runtime performance.' };
}
if (require.main === module) {
  if (!process.argv[2]) throw new Error('Usage: node tools/baseline/profile-library.cjs <private-export.json>');
  console.log(JSON.stringify(profileLibrary(JSON.parse(fs.readFileSync(process.argv[2],'utf8'))),null,2));
}
module.exports={profileLibrary};

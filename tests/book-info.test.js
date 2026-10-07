const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const metadata = { name: 'Truyện Việt', author: 'Nguyễn Văn A', genre: 'Tiên hiệp, Huyền huyễn', url: 'https://example.com/truyen/?a=1&b=2' };
function iterator(items) { let i = 0; return { hasNext: () => i < items.length, next: () => items[i++] }; }
function folderMock() {
  const files = [];
  return {
    files, getId: () => 'folder123456', getName: () => 'Truyện Việt', isTrashed: () => false,
    getFiles: () => iterator(files), getFilesByName: name => iterator(files.filter(f => f.getName() === name)),
    createFile(blob) {
      const f = { content: blob.text, writes: 0, trashed: false, getId: () => 'file' + files.indexOf(f),
        getName: () => blob.name, isTrashed: () => f.trashed,
        getBlob: () => ({ getDataAsString: () => f.content }),
        setContent: content => { f.content = content; f.writes++; return f; },
        setTrashed: value => { f.trashed = value; } };
      files.push(f); return f;
    }
  };
}
function harness() {
  const folder = folderMock(), writes = [], props = new Map();
  const sheet = { getLastRow: () => 1, getRange: (...range) => ({
    setValues: values => writes.push({ range, values }), setValue: value => writes.push({ range, value })
  }) };
  const ctx = vm.createContext({
    Utilities: { newBlob: (data, type, name) => { const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8'); return { text, type, name, getDataAsString: () => text }; },
      base64Decode: b64 => Buffer.from(b64, 'base64'), formatDate: () => '08/10/2026' },
    Session: { getScriptTimeZone: () => 'Asia/Ho_Chi_Minh' },
    DriveApp: { getFolderById: () => folder }, SpreadsheetApp: { flush() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props.get(key), setProperty: (key, value) => props.set(key, value), deleteProperty: key => props.delete(key) }) }
  });
  for (const file of fs.readdirSync(root).filter(f => f.endsWith('.gs'))) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx, { filename: file });
  Object.assign(ctx, { getConfig_: () => ({ AUTO_RESUME: false, JUNK_WORDS: '', BATCH_SIZE: 5, DELAY_MS: 0 }), readBooks_: () => [],
    db_: () => ({ getSheetByName: () => sheet }), getState_: () => ({}), bookFolder_: () => folder,
    withLock_: fn => fn(), pipelineBusy_: () => false, writeLogs_: () => {},
    bookRows_: () => ({ rows: [], first: -1 }), writeBlock_: () => {} });
  return { ctx, folder, writes };
}
function info(folder) { return folder.files.find(f => f.getName() === 'info.txt' && !f.isTrashed()); }
function verify(file, data) {
  assert.equal(file.content, `##Tên truyện\n${data.name || ''}\n\n##Tác giả\n${data.author || ''}\n\n##Thể loại\n${data.genre || ''}\n\n##link gốc\n${data.url || ''}\n`);
}
test('creates UTF-8 metadata with all four headings and original URL', () => {
  const {ctx, folder} = harness(); ctx.writeBookInfo_(folder, metadata); verify(info(folder), metadata);
});
test('updates the same file, avoids duplicates and unchanged writes', () => {
  const {ctx, folder} = harness(); const f = ctx.writeBookInfo_(folder, metadata);
  ctx.writeBookInfo_(folder, metadata); assert.equal(f.writes, 0);
  const changed = {...metadata, author: 'Tác giả mới'}; ctx.writeBookInfo_(folder, changed);
  assert.equal(folder.files.length, 1); assert.equal(info(folder), f); verify(f, changed); assert.equal(f.writes, 1);
});
test('missing fields stay blank and trashed metadata is replaced', () => {
  const {ctx, folder} = harness(); ctx.writeBookInfo_(folder, metadata).setTrashed(true);
  ctx.writeBookInfo_(folder, {name: 'Truyện mới'}); verify(info(folder), {name: 'Truyện mới'});
});
test('website creation writes metadata even when held for analysis', () => {
  const {ctx, folder} = harness(); ctx.createBook_({...metadata, site: 'example.com', chapters: [[1, 'Mở đầu', metadata.url + 'chuong-1/']]}, true); verify(info(folder), metadata);
});
test('single text file import creates metadata with blank source', () => {
  const {ctx, folder} = harness();
  ctx.createBookFromFile_('truyen.txt', Buffer.from('Chương 1: Mở đầu\nĐây là nội dung chương truyện đủ dài để nhập thử.').toString('base64'), metadata);
  verify(info(folder), {...metadata, url: ''}); assert(folder.files.some(f => f.getName() === '_import.json'));
});
test('paired table-of-contents and story import creates metadata', () => {
  const {ctx, folder} = harness(); const b64 = s => Buffer.from(s).toString('base64');
  ctx.createBookFromFiles_('muc-luc.txt', b64('#@ Chương 1\n@Mở đầu'), 'truyen.txt', b64('#@ Chương 1\n@Mở đầu\nĐây là nội dung chương truyện đủ dài để nhập thử.'), metadata);
  verify(info(folder), {...metadata, url: ''});
});
test('folder import ignores metadata and preserves existing chapters', () => {
  const {ctx, folder} = harness(); const chapter = folder.createFile({ name: 'Chương 001 - Mở đầu.txt', text: 'Nội dung truyện' });
  ctx.writeBookInfo_(folder, metadata);
  const out = ctx.createBookFromFolder_('folder123456', metadata);
  assert.equal(out.found, 1); assert.equal(out.skipped, 0); assert.equal(chapter.content, 'Nội dung truyện');
  verify(info(folder), {...metadata, url: ''}); assert.equal(folder.files.length, 2);
});
test('download batch backfills metadata for an existing book without duplicates', () => {
  const {ctx, folder} = harness(); const book = {...metadata, id: 'BOOK001', row: 2, folderId: folder.getId(), site: 'example.com'};
  ctx.readBooks_ = () => [book];
  ctx.runBatch_(book, ctx.getConfig_(), Date.now() + 1000); ctx.runBatch_(book, ctx.getConfig_(), Date.now() + 1000);
  verify(info(folder), metadata); assert.equal(folder.files.length, 1);
});
test('editing author refreshes metadata and keeps source URL', () => {
  const {ctx, folder} = harness(); ctx.readBooks_ = () => [{...metadata, id: 'BOOK001', row: 2, folderId: folder.getId()}];
  ctx.writeBookInfo_(folder, metadata); ctx.updateBookInfo_('BOOK001', {...metadata, author: 'Người viết mới'});
  verify(info(folder), {...metadata, author: 'Người viết mới'}); assert.equal(folder.files.length, 1);
});
test('Drive write failure prevents insertion of a newly created book', () => {
  const {ctx, folder, writes} = harness(); folder.createFile = () => { throw new Error('Drive access denied'); };
  assert.throws(() => ctx.createBook_({...metadata, site: 'example.com', chapters: [[1, '', 'https://example.com/1']]}), /Drive access denied/);
  assert.equal(writes.length, 0);
});

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const baselineCommit = 'aae3c570286edac1db5ca355cbce40f5108d0a10';
const fixedTime = Date.parse('2026-10-08T02:00:00Z');
// CSV stand-in for Utilities.parseCsv, not a replacement shipped to production.
function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && c === ',') { row.push(cell); cell = ''; }
    else if (!quoted && (c === '\n' || c === '\r')) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (quoted) throw new Error('Unclosed CSV quote in fixture');
  if (row.length || cell) { row.push(cell); rows.push(row); }
  return rows;
}
function iterator(items) { let i = 0; return { hasNext: () => i < items.length, next: () => items[i++] }; }
function folderMock() {
  const files = [];
  return { files, getId: () => 'synthetic-folder-001', getName: () => 'Thư viện mẫu', isTrashed: () => false,
    getFiles: () => iterator(files), getFilesByName: name => iterator(files.filter(f => f.getName() === name)),
    createFile(blob) {
      const file = { content: blob.text, writes: 0, trashed: false,
        getId: () => 'synthetic-file-' + files.indexOf(file), getName: () => blob.name,
        isTrashed: () => file.trashed, setTrashed: v => { file.trashed = v; },
        getBlob: () => ({ getDataAsString: () => file.content }),
        setContent: s => { file.content = s; file.writes++; return file; } };
      files.push(file); return file;
    }
  };
}
function source(name, pinned = false) {
  return pinned ? execFileSync('git', ['show', `${baselineCommit}:${name}`], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, name), 'utf8');
}
function createRuntime({ pinned = false, pages = {}, transformSource = (_name, text) => text } = {}) {
  const properties = new Map(), cache = new Map(), folder = folderMock(), requests = [];
  const propStore = { getProperty: k => properties.has(k) ? properties.get(k) : null,
    setProperty: (k, v) => properties.set(k, String(v)), deleteProperty: k => properties.delete(k) };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [fixedTime])); } static now() { return fixedTime; } }
  const ctx = vm.createContext({ Date: FixedDate,
    Utilities: { parseCsv, sleep() {}, formatDate: () => '08/10/2026 09:00:00',
      newBlob: (data, type, name) => { const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8'); return { text, type, name, getDataAsString: () => text }; }, base64Decode: s => Buffer.from(s, 'base64') },
    Session: { getScriptTimeZone: () => 'Asia/Ho_Chi_Minh' },
    PropertiesService: { getScriptProperties: () => propStore, getUserProperties: () => propStore },
    CacheService: { getScriptCache: () => ({ get: k => cache.has(k) ? cache.get(k) : null,
      put: (k, v) => cache.set(k, v), remove: k => cache.delete(k),
      getAll: keys => Object.fromEntries(keys.filter(k => cache.has(k)).map(k => [k, cache.get(k)])),
      putAll: obj => Object.entries(obj).forEach(([k,v]) => cache.set(k,v)) }) },
    DriveApp: { getFolderById: () => folder, getFileById: id => { const f = folder.files.find(f => f.getId() === id); if (!f) throw new Error('Missing synthetic file'); return f; } }
  });
  const names = fs.readdirSync(root).filter(n => n.endsWith('.gs')).sort();
  for (const name of names) new vm.Script(transformSource(name, source(name, pinned)), { filename: name }).runInContext(ctx);
  ctx.fetch_ = url => { requests.push(url); if (!(url in pages)) throw new Error('Fixture URL not registered: ' + url); return pages[url]; };
  return { ctx, folder, properties, cache, requests };
}
function jsonValue(value) { return value === undefined ? { undefined: true } : JSON.parse(JSON.stringify(value)); }
function runCase(spec, { pinned = false, transformSource } = {}) {
  const fixture = name => fs.readFileSync(path.join(root, 'tests/baseline/fixtures', name), 'utf8');
  const resolve = value => {
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === 'object') {
      if (Object.keys(value).length === 1 && value.fixture) return fixture(value.fixture);
      return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, resolve(v)]));
    }
    return value;
  };
  const pages = Object.fromEntries(Object.entries(spec.pages || {}).map(([u,f]) => [u,fixture(f)]));
  const {ctx,folder,requests,cache} = createRuntime({pinned,pages,transformSource});
  const args = resolve(spec.args || []);
  try {
    let out;
    if (spec.driver === 'metadata') {
      const html = args[0]; out = { name: ctx.bookName_(html,'fiction.test'), author: ctx.authorName_(html), genre: ctx.genreNames_(html) };
    } else if (spec.driver === 'discover') {
      const chs = ctx.discover_(...args); out = { chapters: chs, notes: chs.notes, fetched: requests };
    } else if (spec.driver === 'paired-import') {
      const toc = ctx.parseMarkedFile_(args[0],'mục lục'), story = ctx.parseMarkedFile_(args[1],'truyện');
      ctx.fillMissingNums_(toc.items); ctx.fillMissingNums_(story.items);
      const merged = ctx.mergeTocStory_(toc.items,story.items);
      out = { levels: Math.max(toc.levels,story.levels), label: toc.label, missing: merged.missing, extra: merged.extra, chapters: ctx.numberMarkedList_(merged.list) };
    } else if (spec.driver === 'gap') {
      const notes=[]; out={chapters:ctx.fillSequentialGap_(args[0],notes),notes};
    } else if (spec.driver === 'url-template') {
      const tpl=ctx.chapterUrlTemplate_(args[0]); out=tpl ? args[1].map(tpl) : null;
    } else if (spec.driver === 'info') {
      for (const b of args) ctx.writeBookInfo_(folder,b);
      out=folder.files.map(f=>({name:f.getName(),content:f.content,writes:f.writes}));
    } else if (spec.driver === 'group-selection') {
      ctx.bookRows_=()=>({rows:args[0]}); out=ctx.pickGroup_(args[0],args[1]);
    } else if (spec.driver === 'reader-cache-before-permission') {
      ctx.junkWords_=()=>'';
      ctx.fileRegistered_=()=>false;
      cache.set('ch1592_private-file_' + ctx.sig_(''),JSON.stringify({text:'Nội dung mẫu riêng',title:'Riêng'}));
      out=ctx.readChapterFile_('other-book','private-file');
    } else out=ctx[spec.call](...args);
    return { value: jsonValue(out) };
  } catch (e) { return { error: {type:e.type || 'Error',message:e.message} }; }
}
module.exports={root,baselineCommit,fixedTime,parseCsv,source,createRuntime,runCase};

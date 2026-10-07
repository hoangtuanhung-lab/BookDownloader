var IMPORT_EXT_ = { txt: 1, md: 1, markdown: 1, csv: 1 };
var IMPORT_DATA_NAME_ = '_import.json';

function splitChapters_(text) {
  var lines = String(text).replace(/\r/g, '').split('\n'), heads = [], m, i;
  for (i = 0; i < lines.length; i++) { m = CH_HEAD_.exec(lines[i].trim()); if (m) heads.push({ i: i, num: parseInt(m[2], 10), title: (m[3] || '').trim() }); }
  if (!heads.length) throw mk_('PARSER_ERROR', 'Không nhận diện được chương nào trong file. Mỗi chương cần 1 dòng riêng dạng "Chương 1: Tên chương" (cũng nhận "Chapter"/"Chap", có hoặc không có tên).');
  var map = {};
  heads.forEach(function (h, idx) {
    if (!isFinite(h.num)) return;
    var end = idx + 1 < heads.length ? heads[idx + 1].i : lines.length;
    map[h.num] = { num: h.num, title: h.title, body: lines.slice(h.i + 1, end).join('\n').trim() };
  });
  return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return a.num - b.num; });
}

function parseCsvChapters_(text) {
  var rows = Utilities.parseCsv(text) || [], start = 0, map = {};
  if (rows.length && !/^\d+$/.test(String(rows[0][0] || '').trim())) start = 1;
  for (var i = start; i < rows.length; i++) {
    var r = rows[i], num = parseInt(r[0], 10);
    if (!isFinite(num)) continue;
    map[num] = { num: num, title: String(r[1] || '').trim(), body: String(r[2] || '').trim() };
  }
  var out = Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return a.num - b.num; });
  if (!out.length) throw mk_('PARSER_ERROR', 'File CSV không có hàng nào hợp lệ. Mỗi hàng cần đủ 3 cột: Chương (số) | Tiêu đề | Nội dung (có hoặc không có hàng tiêu đề cột ở đầu).');
  return out;
}

function splitHoiChapters_(text) {
  var lines = String(text).replace(/\r/g, '').split('\n'), heads = [], i, m;
  for (i = 0; i < lines.length; i++) {
    var ln = lines[i].trim();
    if (!ln) continue;
    var hh = parseHoiHead_(ln);
    if (hh) {
      heads.push({ i: i, num: hh.num, ordinal: hh.ordinal, preamble: false, inline: hh.inline });
    } else if (!heads.length && PREAMBLE_HEAD_.test(ln)) {
      heads.push({ i: i, num: 0, ordinal: ln, preamble: true, inline: '' });
    }
  }
  if (!heads.length) throw mk_('PARSER_ERROR', 'Không nhận diện được hồi nào trong file. Mỗi hồi cần 1 dòng riêng dạng "Hồi thứ nhất" (nhận cả chữ lẫn số, có "thứ" hay không); chương mở đầu (nếu có) cần 1 dòng riêng "Lời tựa" hoặc "Lời nói đầu".');
  var map = {};
  heads.forEach(function (h, idx) {
    var end = idx + 1 < heads.length ? heads[idx + 1].i : lines.length, bodyLines = lines.slice(h.i + 1, end);
    var title = '';
    if (!h.preamble) {
      var couplet = [];
      if (h.inline) couplet.push(h.inline);
      for (var k = 0; k < bodyLines.length && couplet.length < 2; k++) {
        var t = bodyLines[k].trim();
        if (!t) { if (couplet.length) break; else continue; }
        couplet.push(t);
      }
      title = couplet.join(' / ');
    }
    map[h.num] = { num: h.num, title: title, ordinal: h.ordinal, preamble: h.preamble, body: bodyLines.join('\n').trim() };
  });
  return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return a.num - b.num; });
}

function detectImportFormat_(text) {
  var lines = String(text).replace(/\r/g, '').split('\n');
  for (var i = 0; i < lines.length; i++) if (HOI_HEAD_.test(lines[i].trim())) return 'HOI';
  return 'CHUONG';
}

function parseImportFile_(ext, text) {
  if (ext === 'csv') return { label: 'Chương', chapters: parseCsvChapters_(text) };
  var fmt = detectImportFormat_(text);
  return fmt === 'HOI' ? { label: 'Hồi', chapters: splitHoiChapters_(text) } : { label: 'Chương', chapters: splitChapters_(text) };
}

function cleanChapterList_(chapters, cfg) {
  var out = [];
  chapters.forEach(function (ch) {
    var title = stripJunkInline_(ch.title, cfg.JUNK_WORDS), body = stripJunk_(ch.body, cfg.JUNK_WORDS).replace(/\n{4,}/g, '\n\n\n').trim();
    if (body.length < 20) return;
    out.push({ num: ch.num, title: title, ordinal: ch.ordinal || '', preamble: !!ch.preamble, body: body, part: ch.part || '', vol: ch.vol || '', dnum: ch.dnum == null ? '' : ch.dnum, marked: !!ch.marked });
  });
  return out;
}

function importDataFile_(folder) {
  var props = PropertiesService.getScriptProperties(), key = 'IMP_' + folder.getId(), id = props.getProperty(key), f = null;
  if (id) {
    try { f = DriveApp.getFileById(id); if (f.isTrashed()) f = null; } catch (e) { f = null; }
  }
  if (!f) {
    var it = folder.getFiles();
    while (it.hasNext()) { var c = it.next(); if (c.getName() === IMPORT_DATA_NAME_ && !c.isTrashed()) { f = c; break; } }
    if (f) props.setProperty(key, f.getId());
  }
  return f;
}

function saveImportData_(folder, chapters) {
  deleteImportData_(folder);
  var f = folder.createFile(Utilities.newBlob(JSON.stringify(chapters), 'application/json', IMPORT_DATA_NAME_));
  PropertiesService.getScriptProperties().setProperty('IMP_' + folder.getId(), f.getId());
}

function loadImportData_(folder) {
  var file = importDataFile_(folder);
  if (!file) throw mk_('DRIVE_ERROR', 'Không tìm thấy dữ liệu chương tạm ("' + IMPORT_DATA_NAME_ + '") trong thư mục truyện — có thể đã bị xoá thủ công khỏi Drive giữa lúc đang tải.');
  var arr = JSON.parse(file.getBlob().getDataAsString('UTF-8')), map = {};
  arr.forEach(function (c) { map[c.num] = c; });
  return map;
}

function deleteImportData_(folder) {
  var f = importDataFile_(folder);
  if (f) f.setTrashed(true);
  PropertiesService.getScriptProperties().deleteProperty('IMP_' + folder.getId());
}

function docChapterFile_(bookName, label, ch) {
  var head;
  if (ch.preamble) head = ch.ordinal || ch.title || 'Lời tựa';
  else if (ch.marked) head = (label === 'Hồi' ? 'Hồi ' : 'Chương ') + ch.dnum + (ch.title ? ': ' + ch.title : '');
  else if (label === 'Hồi') head = 'HỒI THỨ ' + String(ch.ordinal || pad_(ch.num)).toUpperCase();
  else head = 'Chương ' + pad_(ch.num) + (ch.title ? ': ' + ch.title : '');
  return bookName + '\n\n' + head + '\n\n' + ch.body;
}

function importFileName_(label, ch) {
  return ch.preamble
    ? cleanName_(pad_(0) + ' - ' + (ch.ordinal || 'Lời tựa')).replace(/[\\\/]/g, ' ').replace(/[:*?"<>|]/g, '').trim().slice(0, 120) + '.txt'
    : fname_(ch.marked ? ch.dnum : ch.num, ch.title, label);
}
function findImportFile_(folder, label, ch) {
  var it = chapterFolder_(folder, ch.part, ch.vol).searchFiles(driveQuery_('title', '=', importFileName_(label, ch)));
  return it.hasNext() ? it.next() : null;
}
function writeImportChapterFile_(folder, bookName, label, ch) {
  var name = importFileName_(label, ch);
  var content = docChapterFile_(bookName, label, ch);
  return chapterFolder_(folder, ch.part, ch.vol).createFile(Utilities.newBlob(content, 'text/plain', name)).getId();
}

function insertPendingFileBook_(name, author, genre, label, folder, chapters) {
  assertUniqueName_(name, '');
  var books = readBooks_(), max = books.reduce(function (m, b) { return Math.max(m, +String(b.id).replace(/\D/g, '') || 0); }, 0), id = 'BOOK' + pad_(max + 1);
  var sb = db_().getSheetByName('BOOKS'), sc = db_().getSheetByName('CHAPTERS');
  var created = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy');
  var cfg = getConfig_(), status = pipelineBusy_(id, true) ? 'IDLE' : 'DOWNLOADING';
  sb.getRange(sb.getLastRow() + 1, 1, 1, 13).setValues([[id, name, '', 'FILE', folder.getId(), chapters.length, 0, 0, status, created, author, genre, label]]);
  var rows = chapters.map(function (c) { return [id, c.num, c.title || '', '', 'PENDING', '', 0, '', '', c.part || '', c.vol || '', c.dnum == null ? '' : c.dnum]; });
  sc.getRange(sc.getLastRow() + 1, 1, rows.length, 12).setValues(rows);
  if (cfg.AUTO_RESUME) ensureTrigger_();
  writeLogs_([[stamp_(), id, '', 'IMPORT', 'SUCCESS', 'Đã thêm vào hàng chờ từ file: ' + chapters.length + ' ' + (label === 'Hồi' ? 'hồi' : 'chương') + ' (đang tạo file lần lượt)']]);
  return { created: name, found: chapters.length, state: getState_() };
}

function createBookFromFile_(filename, base64, meta) {
  var cfg = getConfig_(), name = cleanName_(meta && meta.name);
  if (!name) throw mk_('INVALID_URL', 'Tên truyện không được để trống.');
  assertUniqueName_(name, '');
  var ext = (String(filename || '').match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  if (!IMPORT_EXT_[ext]) throw mk_('INVALID_FILE', 'Chỉ hỗ trợ file .txt, .csv, .md khi thêm truyện mới từ file.');
  var text = Utilities.newBlob(Utilities.base64Decode(base64), 'text/plain', filename).getDataAsString('UTF-8');
  var parsed = parseImportFile_(ext, text), label = parsed.label;
  var chapters = cleanChapterList_(parsed.chapters, cfg);
  if (!chapters.length) throw mk_('PARSER_ERROR', 'Không lưu được chương nào — nội dung các chương nhận diện được quá ngắn.');
  var author = cleanName_(meta && meta.author || ''), genre = cleanName_(meta && meta.genre || '');
  return withLock_(function () {
    var folder = bookFolder_(name, genre, cfg);
    saveImportData_(folder, chapters);
    return insertPendingFileBook_(name, author, genre, label, folder, chapters);
  });
}

var MK_HEAD_ = /^(#{1,3})@\s*(.*)$/;
var MK_TITLE_ = /^@\s*(.*)$/;
var MK_PRE_ = /^00\s+(\S.*)$/;

function parseMarkedChapterHead_(text) {
  var t = String(text || '').trim(), label = '', rest = t, m = /^(chương|chuong|chapter|chap|hồi|hoi)\s*(?:thứ\s+)?(.*)$/i.exec(t);
  if (m) { label = /^h(ồi|oi)$/i.test(m[1]) ? 'Hồi' : 'Chương'; rest = m[2]; }
  var cut = /\s*(?:[:–—]|\s-\s)\s*/.exec(rest), numText = cut ? rest.slice(0, cut.index) : rest, title = cut ? rest.slice(cut.index + cut[0].length) : '';
  numText = numText.replace(/[.:]+$/, '').trim();
  var num = null;
  if (/^\d+$/.test(numText)) num = parseInt(numText, 10);
  else if (m && numText) num = vnOrdinalToNum_(numText);
  if (num === null && !m) { var d = /^(\d+)\s*[.\-–:]?\s*(.*)$/.exec(t); if (d) { num = parseInt(d[1], 10); title = d[2]; numText = d[1]; } else { title = t; numText = ''; } }
  else if (num === null) { title = rest; numText = ''; }
  return { label: label, num: num, ordinal: numText, title: String(title || '').trim() };
}

function parseMarkedFile_(text, what) {
  var lines = String(text).replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n'), items = [], cur = null, part = '', vol = '', chSeen = false, hoi = 0, chg = 0;
  lines.forEach(function (raw) {
    var ln = raw.replace(/\s+$/, ''), tr = ln.trim(), m;
    if ((m = MK_HEAD_.exec(tr))) {
      var lv = m[1].length, tx = m[2].trim();
      if (lv === 3) { part = tx; vol = ''; cur = null; }
      else if (lv === 2) { vol = tx; cur = null; }
      else {
        var h = parseMarkedChapterHead_(tx);
        if (h.label === 'Hồi') hoi++; else chg++;
        chSeen = true;
        cur = { part: part, vol: vol, num: h.num, ordinal: h.ordinal, title: h.title, preamble: false, lines: [], body: false };
        items.push(cur);
      }
      return;
    }
    if (!chSeen && !cur && (m = MK_PRE_.exec(tr))) {
      cur = { part: part, vol: vol, num: 0, ordinal: m[1].trim(), title: m[1].trim(), preamble: true, lines: [], body: false };
      items.push(cur); return;
    }
    if (!cur) return;
    if ((m = MK_TITLE_.exec(tr))) {
      var tt = m[1].trim();
      if (!cur.body && !cur.title && !cur.preamble) { cur.title = tt; return; }
      if (!tt) return;
      ln = tt;
    }
    if (tr) cur.body = true;
    cur.lines.push(ln);
  });
  if (!items.length) throw mk_('PARSER_ERROR', 'Không nhận diện được chương nào trong ' + (what || 'file') + '. Mỗi chương cần 1 dòng "#@ Chương 1" (hoặc "#@ Hồi thứ nhất") và dòng "@Tên chương" ngay sau; Quyển: "##@ Quyển ...", Phần: "###@ Phần ..."; chương mở đầu: "00 Lời nói đầu".');
  var hasPart = items.some(function (c) { return c.part; }), hasVol = items.some(function (c) { return c.vol; });
  items.forEach(function (c) { c.body = c.lines.join('\n').trim(); delete c.lines; });
  return { levels: 1 + (hasPart ? 1 : 0) + (hasVol ? 1 : 0), label: hoi > chg ? 'Hồi' : 'Chương', items: items };
}

function fillMissingNums_(items) {
  var prev = null;
  items.forEach(function (c) {
    if (c.preamble) return;
    if (prev && (prev.part !== c.part || prev.vol !== c.vol)) prev = null;
    if (c.num === null || c.num === undefined) c.num = prev && prev.num != null ? prev.num + 1 : 1;
    prev = c;
  });
}

function markKey_(c) { return normKey_(c.part) + '|' + normKey_(c.vol) + '|' + (c.preamble ? 'P' : c.num); }

function mergeTocStory_(toc, story) {
  var byKey = {}, used = {}, list = [], missing = 0, extra = 0;
  story.forEach(function (c, i) { var k = markKey_(c); if (!(k in byKey)) byKey[k] = i; });
  var exact = toc.filter(function (t) { return markKey_(t) in byKey; }).length, byIndex = exact < toc.length && toc.length === story.length;
  toc.forEach(function (t, ti) {
    var si = byIndex ? ti : byKey[markKey_(t)];
    if (si === undefined || used[si]) { missing++; return; }
    used[si] = true;
    var c = story[si];
    list.push({ part: t.part, vol: t.vol, num: t.num, ordinal: t.ordinal, title: t.title || c.title, preamble: t.preamble, body: c.body });
  });
  story.forEach(function (c, si) { if (!used[si]) { extra++; list.push({ part: c.part, vol: c.vol, num: c.num, ordinal: c.ordinal, title: c.title, preamble: c.preamble, body: c.body }); } });
  return { list: list, missing: missing, extra: extra };
}

function numberMarkedList_(list) {
  var seq = 0;
  return list.map(function (c) {
    var pre = c.preamble, n = pre ? 0 : ++seq;
    return { num: n, title: c.title, ordinal: pre ? c.title : c.ordinal, preamble: pre, body: c.body, part: c.part, vol: c.vol, dnum: pre ? '*' : (c.num == null ? n : c.num), marked: true };
  });
}

function decodeTextFile_(filename, base64) {
  var ext = (String(filename || '').match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  if (ext !== 'txt' && ext !== 'md' && ext !== 'markdown') throw mk_('INVALID_FILE', 'Chỉ hỗ trợ file .txt hoặc .md (file "' + filename + '").');
  return Utilities.newBlob(Utilities.base64Decode(base64), 'text/plain', filename).getDataAsString('UTF-8');
}

function createBookFromFiles_(tocName, tocB64, fileName, fileB64, meta) {
  var cfg = getConfig_(), name = cleanName_(meta && meta.name);
  if (!name) throw mk_('INVALID_URL', 'Tên truyện không được để trống.');
  assertUniqueName_(name, '');
  var toc = parseMarkedFile_(decodeTextFile_(tocName, tocB64), 'file mục lục'), story = parseMarkedFile_(decodeTextFile_(fileName, fileB64), 'file truyện');
  fillMissingNums_(toc.items); fillMissingNums_(story.items);
  var mg = mergeTocStory_(toc.items, story.items), all = numberMarkedList_(mg.list), label = toc.label;
  var chapters = cleanChapterList_(all, cfg);
  if (!chapters.length) throw mk_('PARSER_ERROR', 'Không lưu được chương nào — nội dung các chương ghép được quá ngắn hoặc mục lục không khớp file truyện.');
  var skipped = mg.missing + (all.length - chapters.length), levels = Math.max(toc.levels, story.levels);
  var author = cleanName_(meta && meta.author || ''), genre = cleanName_(meta && meta.genre || '');
  var res = withLock_(function () {
    var folder = bookFolder_(name, genre, cfg);
    saveImportData_(folder, chapters);
    return insertPendingFileBook_(name, author, genre, label, folder, chapters);
  });
  if (res && !res.busy) { res.skipped = skipped; res.extra = mg.extra; res.levels = levels; }
  return res;
}

var FOLDER_CH_HEAD_ = /^(chương|chuong|chapter|chap|hồi|hoi)\s*(\d+(?:[.\-]\d+)?)\s*(?:[-–:.]\s*(.*))?$/i;
var FOLDER_NUM_HEAD_ = /^(\d+(?:[.\-]\d+)?)\s*(?:[-–:.]\s*(.*))?$/;

function parseFolderFileName_(name) {
  var base = String(name || '').replace(/\.[a-z0-9]{1,10}$/i, '').trim();
  var m = FOLDER_CH_HEAD_.exec(base);
  if (m) return { num: parseInt(m[2], 10), title: (m[3] || '').trim(), label: /^h(ồi|oi)$/i.test(m[1]) ? 'Hồi' : 'Chương' };
  m = FOLDER_NUM_HEAD_.exec(base);
  if (m) return { num: parseInt(m[1], 10), title: (m[2] || '').trim(), label: 'Chương' };
  return null;
}

function scanFolderChapters_(folder) {
  var found = [], byNum = {}, skipped = 0, it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (f.isTrashed() || f.getName() === IMPORT_DATA_NAME_) continue;
    var p = parseFolderFileName_(f.getName());
    if (!p || byNum[p.num]) { skipped++; continue; }
    byNum[p.num] = 1;
    found.push({ num: p.num, title: p.title, label: p.label, fileId: f.getId() });
  }
  found.sort(function (a, b) { return a.num - b.num; });
  return { found: found, skipped: skipped };
}

function createBookFromFolder_(folderInput, meta) {
  var fid = folderIdFrom_(folderInput), folder;
  try { folder = DriveApp.getFolderById(fid); } catch (e) { throw mk_('DRIVE_ERROR', 'Không truy cập được thư mục này. Kiểm tra ID/link và quyền chia sẻ.'); }
  if (folder.isTrashed()) throw mk_('DRIVE_ERROR', 'Thư mục này đang nằm trong thùng rác.');
  if (readBooks_().some(function (b) { return b.folderId === fid; }))
    throw mk_('DUPLICATE_NAME', 'Thư mục này đã được đăng ký cho 1 truyện khác trong Quản lý sách — mỗi thư mục chỉ dùng cho đúng 1 truyện.');
  var name = cleanName_(meta && meta.name) || cleanName_(folder.getName());
  if (!name) throw mk_('INVALID_URL', 'Tên truyện không được để trống.');
  assertUniqueName_(name, '');

  var scan = scanFolderChapters_(folder), found = scan.found;
  if (!found.length) throw mk_('PARSER_ERROR', 'Không tìm thấy file chương nào trong thư mục — mỗi file cần đặt tên bắt đầu bằng số chương, vd "Chương 12 - Tên.txt", "12 - Tên.txt" hoặc chỉ "12.txt".');
  var chCount = 0, hoiCount = 0;
  found.forEach(function (c) { if (c.label === 'Hồi') hoiCount++; else chCount++; });
  var label = hoiCount > chCount ? 'Hồi' : 'Chương';
  var author = cleanName_(meta && meta.author || ''), genre = cleanName_(meta && meta.genre || '');

  return withLock_(function () {
    var books = readBooks_();
    if (books.some(function (b) { return b.folderId === fid; }))
      throw mk_('DUPLICATE_NAME', 'Thư mục này đã được đăng ký cho 1 truyện khác trong Quản lý sách — mỗi thư mục chỉ dùng cho đúng 1 truyện.');
    assertUniqueName_(name, '');
    var max = books.reduce(function (m, b) { return Math.max(m, +String(b.id).replace(/\D/g, '') || 0); }, 0), bookId = 'BOOK' + pad_(max + 1);
    var sb = db_().getSheetByName('BOOKS'), sc = db_().getSheetByName('CHAPTERS');
    var created = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy'), now = stamp_();
    sb.getRange(sb.getLastRow() + 1, 1, 1, 13).setValues([[bookId, name, '', 'FOLDER', fid, found.length, found.length, 0, 'COMPLETED', created, author, genre, label]]);
    var rows = found.map(function (c) { return [bookId, c.num, c.title, '', 'DONE', c.fileId, 0, '', now]; });
    sc.getRange(sc.getLastRow() + 1, 1, rows.length, 9).setValues(rows);
    writeLogs_([[stamp_(), bookId, '', 'IMPORT_FOLDER', 'SUCCESS', 'Đã thêm từ thư mục có sẵn: ' + found.length + ' ' + (label === 'Hồi' ? 'hồi' : 'chương')
      + (scan.skipped ? ', bỏ qua ' + scan.skipped + ' file không nhận diện được' : '')]]);
    return { created: name, found: found.length, skipped: scan.skipped, state: getState_() };
  });
}

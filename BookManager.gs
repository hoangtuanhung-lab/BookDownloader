function findBook_(id) {
  var b = readBooks_().filter(function (x) { return x.id === id; })[0];
  if (!b) throw mk_('UNKNOWN_ERROR', 'Không tìm thấy truyện.');
  return b;
}

function pipelineBusy_(excludeId, isFile) {
  var cap = Math.max(1, +getConfig_().MAX_CONCURRENT || 1);
  var books = readBooks_().filter(function (x) { return x.id !== excludeId && (x.site === 'FILE') === !!isFile; });
  var active = books.filter(function (x) { return x.status === 'DOWNLOADING' || x.status === 'READY'; }).length;
  var waiting = books.some(function (x) { return x.status === 'IDLE'; });
  return active >= cap || waiting;
}

function assertUniqueName_(name, excludeId) {
  var key = normName_(name), dup = readBooks_().filter(function (b) { return b.id !== excludeId && normName_(b.name) === key; })[0];
  if (dup) throw mk_('DUPLICATE_NAME', 'Đã có truyện tên "' + dup.name + '" trong Quản lý sách — đổi tên khác hoặc sửa/xóa truyện cũ trước khi thêm lại.');
}

function analyzeBook_(url) {
  var cfg = getConfig_(), bookUrl = normUrl_(url);
  var ex = readBooks_().filter(function (b) { return b.url === bookUrl; })[0];
  if (ex) {
    var exHtml = fetch_(bookUrl, cfg), chs = discover_(bookUrl, exHtml, cfg);
    withLock_(function () { return renumMixed_(ex.id, chs); });
    var known = knownChapterSet_(ex.id);
    var add = chs.filter(function (c) { return !known.url[c.url] && !known.num[numKey_(c.vol, c.n)]; });
    return { existing: ex.id, state: getState_(), newChapters: add.map(function (c) { return [c.n, c.title, c.url, c.vol, c.dnum]; }) };
  }
  var html = fetch_(bookUrl, cfg), host = hostOf_(bookUrl);
  var name = bookName_(html, host), author = authorName_(html), genre = genreNames_(html), chsNew = discover_(bookUrl, html, cfg);
  return { warn: (chsNew.notes || []).join(' '), info: { name: name, author: author, genre: genre, site: host, url: bookUrl, root: cfg.ROOT_FOLDER, chapters: chsNew.map(function (c) { return [c.n, c.title, c.url, c.vol, c.dnum]; }) } };
}

function renumMixed_(id, chs) {
  if (!chs.some(function (c) { return c.vol; }) || !chs.some(function (c) { return !c.vol; })) return 0;
  var byUrl = {};
  chs.forEach(function (c) { byUrl[c.url] = c.n; });
  var br = bookRows_(id);
  if (br.first < 0) return 0;
  var changed = 0, rows = br.rows.map(function (r, i) {
    var n = byUrl[r[3]];
    if (n === undefined || r[1] === n) return { r: r, i: i };
    var c = r.slice();
    c[1] = n;
    changed++;
    return { r: c, i: i };
  });
  if (!changed) return 0;
  rows.sort(function (a, b) { return a.r[1] - b.r[1] || a.i - b.i; });
  br.s.getRange(br.first + 2, 1, rows.length, 12).setValues(rows.map(function (x) { return x.r.slice(0, 12); }));
  SpreadsheetApp.flush();
  writeLogs_([[stamp_(), id, '', 'ANALYZE', 'SUCCESS', 'Đã chuẩn hóa ' + changed + ' chương của truyện trộn hai kiểu link (số chương và thứ tự Quyển).']]);
  return changed;
}

function numKey_(vol, n) { return (vol ? 'V' : 'F') + n; }

function knownChapterSet_(id) {
  var url = {}, num = {};
  bookRows_(id).rows.forEach(function (r) { url[r[3]] = 1; num[numKey_(r[10], r[1])] = 1; });
  return { url: url, num: num };
}

function mergeByNum_(oldRows, newRows) {
  var merged = oldRows.slice();
  newRows.slice().sort(function (a, b) { return a[1] - b[1]; }).forEach(function (r) {
    var p = merged.length;
    for (var i = 0; i < merged.length; i++) if (merged[i][1] > r[1]) { p = i; break; }
    merged.splice(p, 0, r);
  });
  return merged;
}

function statusAfterAdd_(b) {
  if (b.status === 'PAUSED') return 'PAUSED';
  if (b.status === 'DOWNLOADING' || b.status === 'READY' || b.status === 'IDLE' || b.status === 'ANALYZED') return b.status;
  return pipelineBusy_(b.id, false) ? 'IDLE' : 'DOWNLOADING';
}

function insertChapterRows_(br, rows) {
  var sc = db_().getSheetByName('CHAPTERS');
  var lastRow = br.first < 0 ? sc.getLastRow() : br.first + 2 + br.rows.length - 1;
  sc.insertRowsAfter(lastRow, rows.length);
  if (br.first < 0) sc.getRange(lastRow + 1, 1, rows.length, 12).setValues(rows);
  else {
    var merged = mergeByNum_(br.rows, rows);
    sc.getRange(br.first + 2, 1, merged.length, 12).setValues(merged.map(function (r) { return r.slice(0, 12); }));
  }
}

function addMissingChapters_(id, newChapters) {
  var b = findBook_(id);
  if (!newChapters || !newChapters.length) return { state: getState_(), added: 0 };
  var known = knownChapterSet_(id);
  var add = newChapters.filter(function (c) { return !known.url[c[2]] && !known.num[numKey_(c[3], c[0])]; });
  if (!add.length) return { state: getState_(), added: 0 };
  var cfg = getConfig_(), br = bookRows_(id);
  var taken = {};
  br.rows.forEach(function (r) { taken[r[1]] = 1; });
  var rows = add.map(function (c) {
    var n = c[0];
    while (taken[n]) n += 0.5;
    taken[n] = 1;
    return [id, n, c[1], c[2], 'PENDING', '', 0, '', '', '', c[3] || '', c[4] === undefined ? '' : c[4]];
  });
  insertChapterRows_(br, rows);
  var sb = db_().getSheetByName('BOOKS');
  sb.getRange(b.row, 6).setValue(b.total + add.length);
  sb.getRange(b.row, 9).setValue(statusAfterAdd_(b));
  if (cfg.AUTO_RESUME) ensureTrigger_();
  return { state: getState_(), added: add.length };
}

function manualAnalyze_(sampleUrl, total) {
  var n = +total;
  if (!n || n < 1 || n > 20000) throw mk_('INVALID_URL', 'Tổng số chương không hợp lệ (1–20000).');
  var raw = String(sampleUrl || '').trim().split('#')[0].split('?')[0];
  if (!/^https?:\/\//i.test(raw)) throw mk_('INVALID_URL', 'URL mẫu phải bắt đầu bằng http:// hoặc https://');
  var sampleN = chNum_({ url: raw, title: '' });
  if (sampleN === null) throw mk_('INVALID_URL', 'Không tìm thấy số chương trong URL mẫu (cần dạng .../chuong-N, .../chapter-N hoặc .../chap-N).');
  var tpl = chapterUrlTemplate_([{ url: raw, n: sampleN }]);
  if (!tpl) throw mk_('INVALID_URL', 'Không suy ra được mẫu URL từ link đã nhập.');
  var chs = []; for (var i = 1; i <= n; i++) chs.push([i, '', tpl(i), '', '']);
  var bookUrl = normUrl_(raw), ex = readBooks_().filter(function (b) { return b.url === bookUrl; })[0];
  if (ex) return { existing: ex.id, state: getState_(), newChapters: chs };
  var cfg = getConfig_();
  return { info: { name: '', author: '', genre: '', site: hostOf_(bookUrl), url: bookUrl, root: cfg.ROOT_FOLDER, chapters: chs } };
}

function createBook_(info, hold) {
  var cfg = getConfig_(), books = readBooks_(), name = cleanName_(info.name);
  if (!name) throw mk_('INVALID_URL', 'Tên truyện trống.');
  if (books.some(function (b) { return b.url === info.url; })) return { state: getState_() };
  assertUniqueName_(name, '');
  var max = books.reduce(function (m, b) { return Math.max(m, +String(b.id).replace(/\D/g, '') || 0); }, 0), id = 'BOOK' + pad_(max + 1);
  var folder = bookFolder_(name, info.genre, cfg), sb = db_().getSheetByName('BOOKS'), sc = db_().getSheetByName('CHAPTERS');
  var created = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy');
  var status = hold ? 'ANALYZED' : (pipelineBusy_(id, false) ? 'IDLE' : 'DOWNLOADING');
  sb.getRange(sb.getLastRow() + 1, 1, 1, 13).setValues([[id, name, info.url, info.site, folder.getId(), info.chapters.length, 0, 0, status, created, cleanName_(info.author || ''), cleanName_(info.genre || ''), 'Chương']]);
  var rows = info.chapters.map(function (c) { return [id, c[0], c[1], c[2], 'PENDING', '', 0, '', '', '', c[3] || '', c[4] === undefined ? '' : c[4]]; });
  sc.getRange(sc.getLastRow() + 1, 1, rows.length, 12).setValues(rows);
  if (cfg.AUTO_RESUME && !hold) ensureTrigger_();
  return { state: getState_(), id: id };
}

function setBookStatus_(id, action) {
  var cfg = getConfig_(), b = findBook_(id), s = db_().getSheetByName('BOOKS');
  if (action === 'pause') {
    s.getRange(b.row, 9).setValue('PAUSED');
  } else if (action === 'start') {
    s.getRange(b.row, 9).setValue(pipelineBusy_(id, b.site === 'FILE') ? 'IDLE' : 'DOWNLOADING');
    if (cfg.AUTO_RESUME) ensureTrigger_();
  } else if (action === 'retry') {
    var br = bookRows_(id);
    resetErrorRows_(br.rows); writeBlock_(br);
    s.getRange(b.row, 7, 1, 3).setValues([[count_(br.rows).done, 0, pipelineBusy_(id, b.site === 'FILE') ? 'IDLE' : 'DOWNLOADING']]);
    if (cfg.AUTO_RESUME) ensureTrigger_();
  } else if (action === 'verify') {
    var ids = allFileIds_(DriveApp.getFolderById(b.folderId));
    var v = bookRows_(id);
    markMissing_(v.rows, ids); writeBlock_(v);
    var k = count_(v.rows);
    s.getRange(b.row, 7, 1, 3).setValues([[k.done, k.err, k.pend && b.status === 'COMPLETED' && b.site !== 'FOLDER' ? 'READY' : b.status]]);
  }
}

function chapterRow_(id, num) {
  var br = bookRows_(id), row = br.rows.filter(function (r) { return r[1] === num; })[0];
  if (!row) throw mk_('UNKNOWN_ERROR', 'Không tìm thấy chương.');
  return { br: br, row: row };
}
function retryChapterRow_(id, num) {
  var b = findBook_(id), cfg = getConfig_(), x = chapterRow_(id, num);
  x.row[4] = 'PENDING'; x.row[6] = 0; x.row[7] = '';
  writeBlock_(x.br);
  var k = count_(x.br.rows);
  db_().getSheetByName('BOOKS').getRange(b.row, 7, 1, 3).setValues([[k.done, k.err, 'DOWNLOADING']]);
  if (cfg.AUTO_RESUME) ensureTrigger_();
}
function editChapterRow_(id, num, url, title) {
  var b = findBook_(id);
  var raw = String(url || '').trim();
  if (!/^https?:\/\//i.test(raw)) throw mk_('INVALID_URL', 'URL chương phải bắt đầu bằng http:// hoặc https://');
  var cfg = getConfig_(), x = chapterRow_(id, num), wasErr = x.row[4] === 'ERROR', newTitle = title === undefined ? undefined : cleanName_(title);
  if (newTitle !== undefined && newTitle !== x.row[2]) assertNoFormula_(newTitle, 'Tiêu đề chương');
  x.row[3] = raw;
  if (newTitle !== undefined) x.row[2] = newTitle;
  if (wasErr) { x.row[4] = 'PENDING'; x.row[6] = 0; x.row[7] = ''; }
  writeBlock_(x.br);
  if (wasErr) {
    var k = count_(x.br.rows);
    db_().getSheetByName('BOOKS').getRange(b.row, 7, 1, 3).setValues([[k.done, k.err, 'DOWNLOADING']]);
    if (cfg.AUTO_RESUME) ensureTrigger_();
  }
  writeLogs_([[stamp_(), id, num, 'EDIT_CHAPTER', 'SUCCESS', 'Sửa link chương ' + num + ': ' + raw]]);
}
function cancelChapterRow_(id, num) {
  var b = findBook_(id), x = chapterRow_(id, num);
  x.row[4] = 'DONE'; x.row[5] = ''; x.row[6] = 0; x.row[7] = ''; x.row[8] = stamp_();
  writeBlock_(x.br);
  var k = count_(x.br.rows), st = k.pend === 0 ? (k.err ? 'ERROR' : 'COMPLETED') : b.status;
  db_().getSheetByName('BOOKS').getRange(b.row, 7, 1, 3).setValues([[k.done, k.err, st]]);
}

function pauseChapterRow_(id, num) {
  var b = findBook_(id), x = chapterRow_(id, num);
  x.row[4] = 'ERROR'; x.row[7] = 'Tạm dừng thủ công'; x.row[8] = stamp_();
  writeBlock_(x.br);
  var k = count_(x.br.rows), st = k.pend === 0 ? (k.err ? 'ERROR' : 'COMPLETED') : b.status;
  db_().getSheetByName('BOOKS').getRange(b.row, 7, 1, 3).setValues([[k.done, k.err, st]]);
}
function deleteChapterRow_(id, num) {
  var b = findBook_(id), br = bookRows_(id), idx = -1;
  br.rows.forEach(function (r, i) { if (r[1] === num) idx = i; });
  if (idx < 0) throw mk_('UNKNOWN_ERROR', 'Không tìm thấy chương.');
  var row = br.rows[idx];
  if (row[4] === 'DONE' && row[5]) { try { DriveApp.getFileById(row[5]).setTrashed(true); } catch (e) { } }
  br.s.deleteRows(br.first + 2 + idx, 1);
  var br2 = bookRows_(id), k = count_(br2.rows), st = k.pend === 0 ? (k.err ? 'ERROR' : 'COMPLETED') : b.status;
  db_().getSheetByName('BOOKS').getRange(b.row, 6, 1, 4).setValues([[br2.rows.length, k.done, k.err, st]]);
  writeLogs_([[stamp_(), id, num, 'DELETE_CHAPTER', 'SUCCESS', 'Xóa chương ' + num + ' khỏi danh sách']]);
  if (row[4] === 'ERROR') removedLogAppend_(b, [removedItem_(row, 'Xóa thủ công; lỗi: ' + row[7])]);
}

function reorderQueue_(id, dir) {
  var queue = readBooks_().filter(function (b) { return b.status === 'IDLE'; });
  var idx = queue.reduce(function (f, b, i) { return b.id === id ? i : f; }, -1);
  if (idx < 0) return;
  var j = dir === 'up' ? idx - 1 : idx + 1;
  if (j < 0 || j >= queue.length) return;
  var a = queue[idx], b = queue[j], s = db_().getSheetByName('BOOKS');
  var ra = s.getRange(a.row, 1, 1, 13).getValues()[0], rb = s.getRange(b.row, 1, 1, 13).getValues()[0];
  s.getRange(a.row, 1, 1, 13).setValues([rb]);
  s.getRange(b.row, 1, 1, 13).setValues([ra]);
}

function promoteIdle_(id) {
  var b = findBook_(id), s = db_().getSheetByName('BOOKS');
  if (b.status !== 'IDLE') return { book: b };
  s.getRange(b.row, 9).setValue('READY');
  return { book: findBook_(id) };
}
function startReady_(id) {
  var b = findBook_(id), s = db_().getSheetByName('BOOKS');
  if (b.status !== 'READY') return { book: b };
  s.getRange(b.row, 9).setValue('DOWNLOADING');
  return { book: findBook_(id) };
}

function setGenreMany_(ids, genre) {
  if (!Array.isArray(ids) || !ids.length) throw mk_('UNKNOWN_ERROR', 'Chưa có truyện nào để áp dụng thể loại.');
  if (ids.length > 200) throw mk_('UNKNOWN_ERROR', 'Mỗi lần áp dụng thể loại tối đa 200 truyện.');
  var ge = cleanName_(genre || '');
  if (!ge) throw mk_('UNKNOWN_ERROR', 'Chọn ít nhất một thể loại để áp dụng.');
  assertNoFormula_(ge, 'Thể loại');
  var byId = {}, errors = {}, ok = 0;
  readBooks_().forEach(function (b) { byId[b.id] = b; });
  ids.forEach(function (id) {
    var b = byId[String(id)];
    if (!b) { errors[id] = 'Không tìm thấy truyện.'; return; }
    if (b.status !== 'ANALYZED') { errors[id] = 'Chỉ áp dụng cho truyện đã phân tích.'; return; }
    try { updateBookInfo_(b.id, { name: b.name, author: b.author, genre: ge }); ok++; }
    catch (e) { errors[id] = e.message; }
  });
  return { ok: ok, errors: errors, state: getState_() };
}

function updateBookInfo_(id, f) {
  var b = findBook_(id), nm = cleanName_(f.name), ge = cleanName_(f.genre || '');
  if (!nm) throw mk_('UNKNOWN_ERROR', 'Tên truyện không được để trống.');
  var au = cleanName_(f.author || '');
  if (nm !== b.name) assertNoFormula_(nm, 'Tên truyện');
  if (au !== b.author) assertNoFormula_(au, 'Tác giả');
  if (ge !== b.genre) assertNoFormula_(ge, 'Thể loại');
  assertUniqueName_(nm, id);
  var renameDrive = nm !== b.name, moveDrive = genreFolderName_(ge) !== genreFolderName_(b.genre), renamed = false, folder = null;
  if (renameDrive || moveDrive) {
    try {
      folder = DriveApp.getFolderById(b.folderId);
      if (renameDrive) { folder.setName(nm); renamed = true; }
      if (moveDrive) moveToGenre_(folder, b.genre, ge);
    } catch (e) {
      if (renamed) { try { folder.setName(b.name); } catch (e2) { } }
      throw mk_('DRIVE_ERROR', 'Không cập nhật được thư mục truyện trên Drive nên thông tin truyện chưa được thay đổi. Kiểm tra quyền hoặc thử lại.');
    }
  }
  FLD_MEMO_ = {};
  var s = db_().getSheetByName('BOOKS');
  s.getRange(b.row, 2).setValue(nm);
  s.getRange(b.row, 11, 1, 2).setValues([[au, ge]]);
}

function deleteBook_(id, trashFolder) {
  var b = findBook_(id), br = bookRows_(id);
  if (br.first >= 0) br.s.deleteRows(br.first + 2, br.rows.length);
  db_().getSheetByName('BOOKS').deleteRow(b.row);
  if (trashFolder) { try { DriveApp.getFolderById(b.folderId).setTrashed(true); } catch (e) { } }
  PropertiesService.getScriptProperties().deleteProperty('IMP_' + b.folderId);
  PropertiesService.getScriptProperties().deleteProperty('DEL_' + b.folderId);
  anaDrop_([id]);
  dropReadingProgress_(id);
  writeLogs_([[stamp_(), id, '', 'DELETE', 'SUCCESS', b.name + (trashFolder ? ' (+thư mục Drive)' : '')]]);
}

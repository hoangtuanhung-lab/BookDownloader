var RD_TTL_ = 21600;

function readerList_(id) {
  var b = findBook_(id);
  var rows = bookRows_(id).rows
    .filter(function (r) { return r[4] === 'DONE' && r[5]; })
    .map(function (r) { return [r[1], r[2], r[5], String(r[9] || ''), String(r[10] || ''), String(r[11] === undefined ? '' : r[11])]; });
  regPut_(id, rows.map(function (r) { return r[2]; }));
  return { name: b.name, author: b.author, rows: rows };
}

function bookOrNull_(id) { try { return id ? findBook_(id) : null; } catch (e) { return null; } }

function headLike_(s) { return CH_HEAD_.test(s) || /^(?:hồi|hoi)\s*\d+/i.test(s) || PREAMBLE_HEAD_.test(s); }

function stripFileHead_(t, strict, bookName) {
  var parts = t.split('\n\n');
  if (parts.length <= 2) return { headTitle: '', body: t };
  var a = parts[0].trim(), b = parts[1].trim();
  if (a.indexOf('\n') >= 0 || b.indexOf('\n') >= 0 || a.length > 200 || b.length > 300) return { headTitle: '', body: t };
  if (strict && !(normName_(a) === normName_(bookName) && headLike_(b))) return { headTitle: '', body: t };
  return { headTitle: titleOnly_(b), body: parts.slice(2).join('\n\n') };
}

function readChapterFile_(bookId, fileId, book) {
  var cache = CacheService.getScriptCache(), words = junkWords_(), key = 'ch' + VERSION.replace(/\./g, '') + '_' + fileId + '_' + sig_(words);
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  if (!fileRegistered_(bookId, fileId)) throw mk_('DRIVE_ERROR', 'File này không thuộc truyện nào trong danh sách. Bấm "Kiểm tra file" rồi tải lại.');
  var f, t;
  try { f = DriveApp.getFileById(fileId); t = f.getBlob().getDataAsString('UTF-8'); }
  catch (e) { throw mk_('DRIVE_ERROR', 'File chương không còn trên Drive. Bấm "Kiểm tra file" rồi tải lại.'); }
  var bk = book || bookOrNull_(bookId), sh = stripFileHead_(t, !!bk && bk.site === 'FOLDER', bk ? bk.name : '');
  var tp = tidyChapter_(sh.body, words);
  var out = { text: tp.body, title: tp.title || stripJunkInline_(sh.headTitle, words) };
  var js = JSON.stringify(out);
  if (js.length < 60000) cache.put(key, js, RD_TTL_);
  return out;
}

function readChapterCluster_(bookId, fileIds) {
  fileIds = (fileIds || []).slice(0, 40);
  var book = bookOrNull_(bookId);
  return fileIds.map(function (fid) {
    try { var r = readChapterFile_(bookId, fid, book); return { id: fid, text: r.text, title: r.title }; }
    catch (e) { return { id: fid, error: (e && e.message) || String(e) }; }
  });
}

function regPut_(bookId, ids) {
  var put = {}, n = 0, size = 2500;
  for (var i = 0; i < ids.length; i += size) { put['rdi_' + bookId + '_' + n] = ids.slice(i, i + size).join(','); n++; }
  put['rdn_' + bookId] = String(n);
  try { CacheService.getScriptCache().putAll(put, RD_TTL_); } catch (e) { }
}
function regHas_(bookId, fileId) {
  var c = CacheService.getScriptCache(), n = +c.get('rdn_' + bookId) || 0, keys = [];
  for (var i = 0; i < n; i++) keys.push('rdi_' + bookId + '_' + i);
  if (!keys.length) return false;
  var m = c.getAll(keys);
  return keys.some(function (k) { return m[k] && (',' + m[k] + ',').indexOf(',' + fileId + ',') >= 0; });
}

function fileRegistered_(bookId, fileId) {
  if (bookId && regHas_(bookId, fileId)) return true;
  if (bookId) {
    var ids = bookRows_(bookId).rows.filter(function (r) { return r[4] === 'DONE' && r[5]; }).map(function (r) { return r[5]; });
    regPut_(bookId, ids);
    return ids.indexOf(fileId) >= 0;
  }
  var s = db_().getSheetByName('CHAPTERS'), n = s.getLastRow();
  if (n < 2) return false;
  return s.getRange(2, 6, n - 1, 1).getValues().some(function (r) { return r[0] === fileId; });
}

function rpKey_(bookId) {
  var id = String(bookId || '');
  if (!/^[\w\-]{1,100}$/.test(id)) throw mk_('INVALID_INPUT', 'Mã truyện không hợp lệ.');
  return 'RP_' + id;
}

function saveReadingProgress_(bookId, chapterId, y, ratio, t) {
  var key = rpKey_(bookId), c = Number(chapterId), py = Math.round(Number(y)), p = Number(ratio), now = Date.now(), ts = Number(t);
  if (!isFinite(c) || !isFinite(py) || py < 0) throw mk_('INVALID_INPUT', 'Tiến độ đọc không hợp lệ.');
  if (!isFinite(p) || p < 0) p = 0;
  if (p > 1) p = 1;
  if (!isFinite(ts) || ts > now + 60000 || ts < 1e12) ts = now;
  var props = PropertiesService.getUserProperties(), old = null;
  try { old = JSON.parse(props.getProperty(key) || 'null'); } catch (e) { }
  if (old && old.t > ts) return { ok: true, skipped: true, pos: old };
  var pos = { c: c, y: py, p: Math.round(p * 1000) / 1000, t: ts };
  props.setProperty(key, JSON.stringify(pos));
  return { ok: true, pos: pos };
}

function getReadingProgress_(bookId) {
  var raw = PropertiesService.getUserProperties().getProperty(rpKey_(bookId));
  if (!raw) return { pos: null };
  try { return { pos: JSON.parse(raw) }; } catch (e) { return { pos: null }; }
}

function dropReadingProgress_(bookId) {
  try { PropertiesService.getUserProperties().deleteProperty(rpKey_(bookId)); } catch (e) { }
}

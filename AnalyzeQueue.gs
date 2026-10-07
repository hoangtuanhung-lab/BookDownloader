var ANA_KEY_ = 'ANA_QUEUE';
var ANA_MAX_BYTES_ = 8800;
var ANA_URL_MAX_ = 500;
var ANA_MOVE_MAX_ = 200;
var ANA_ERR_MAX_ = 80;
var ANA_ERR_LIST_MAX_ = 50;

function anaLoad_() {
  var raw = PropertiesService.getScriptProperties().getProperty(ANA_KEY_), q = { w: [], h: [], e: [] };
  if (!raw) return q;
  try {
    var o = JSON.parse(raw);
    if (Array.isArray(o.w)) q.w = o.w.map(String);
    if (Array.isArray(o.h)) q.h = o.h.filter(function (x) { return Array.isArray(x) && x.length === 2; }).map(function (x) { return [String(x[0]), String(x[1])]; });
    if (Array.isArray(o.e)) q.e = o.e.filter(function (x) { return Array.isArray(x) && x.length === 2; }).map(function (x) { return [String(x[0]), String(x[1])]; });
  } catch (e) { }
  return q;
}

function utf8Len_(s) {
  var n = 0, c;
  s = String(s);
  for (var i = 0; i < s.length; i++) {
    c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

function anaSave_(q) {
  var p = PropertiesService.getScriptProperties();
  var e = q.e || [];
  if (!q.w.length && !q.h.length && !e.length) { p.deleteProperty(ANA_KEY_); return true; }
  var o = { w: q.w, h: q.h };
  if (e.length) o.e = e;
  var text = JSON.stringify(o);
  if (utf8Len_(text) > ANA_MAX_BYTES_) return false;
  p.setProperty(ANA_KEY_, text);
  return true;
}

function hangState_(books) {
  var q = anaLoad_();
  return {
    w: q.w,
    h: books.filter(function (b) { return b.status === 'ANALYZED'; }).map(function (b) { return { id: b.id, url: b.url }; }),
    e: q.e.map(function (x) { return { u: x[0], m: x[1] }; })
  };
}

function anaDone_(rawUrl, bookId, bookUrl) {
  var q = anaLoad_(), oldH = q.h.slice();
  q.w = q.w.filter(function (u) { return u !== rawUrl; });
  q.e = q.e.filter(function (x) { return x[0] !== rawUrl; });
  if (bookId && !q.h.some(function (x) { return x[0] === bookId; })) q.h.push([bookId, String(bookUrl || '')]);
  if (!anaSave_(q)) { q.h = oldH; anaSave_(q); }
}

function anaFail_(url, msg) {
  var q = anaLoad_(), text = String(msg == null ? '' : msg).replace(/\s+/g, ' ').trim().slice(0, ANA_ERR_MAX_);
  q.w = q.w.filter(function (u) { return u !== url; });
  q.e = q.e.filter(function (x) { return x[0] !== url; }).slice(-(ANA_ERR_LIST_MAX_ - 1));
  var withText = q.e.concat([[url, text]]);
  if (anaSave_({ w: q.w, h: q.h, e: withText })) return;
  var bare = q.e.concat([[url, '']]);
  if (anaSave_({ w: q.w, h: q.h, e: bare })) return;
  anaSave_({ w: q.w, h: q.h, e: q.e });
}

function failPending_(url, msg) {
  for (var i = 0; i < 3; i++) {
    var out = withLock_(function () { anaFail_(url, msg); return 1; });
    if (out === 1) return;
  }
}

function retryAnalyze_(url) {
  var u = String(url == null ? '' : url).trim();
  if (!u || u.length > ANA_URL_MAX_) throw mk_('INVALID_URL', 'URL không hợp lệ.');
  var q = anaLoad_();
  if (!q.e.some(function (x) { return x[0] === u; })) throw mk_('UNKNOWN_ERROR', 'URL này không còn trong danh sách lỗi.');
  q.e = q.e.filter(function (x) { return x[0] !== u; });
  if (q.w.indexOf(u) < 0) q.w.push(u);
  if (!anaSave_(q)) throw mk_('QUEUE_FULL', 'Hàng chờ phân tích đầy, chờ phân tích xong bớt rồi thử lại.');
  return { state: getState_() };
}

function anaDrop_(ids) {
  var set = {};
  ids.forEach(function (id) { set[id] = 1; });
  var q = anaLoad_(), keep = q.h.filter(function (x) { return !set[x[0]]; });
  if (keep.length === q.h.length) return;
  q.h = keep;
  anaSave_(q);
}

function dropPending_(url) {
  for (var i = 0; i < 3; i++) {
    var out = withLock_(function () { anaDone_(url, '', ''); return 1; });
    if (out === 1) return;
  }
}

function queueAnalyze_(urls) {
  if (!Array.isArray(urls) || !urls.length) throw mk_('INVALID_URL', 'Nhập URL truyện trước khi phân tích.');
  if (urls.length > 100) throw mk_('INVALID_URL', 'Mỗi lần chỉ thêm tối đa 100 URL.');
  var q = anaLoad_(), have = {}, fresh = {}, added = 0, dup = 0;
  q.w.forEach(function (u) { have[u] = 1; });
  var next = q.w.slice();
  urls.forEach(function (raw, i) {
    var u = String(raw == null ? '' : raw).trim();
    if (!/^https?:\/\/[^\/\s]+/i.test(u)) throw mk_('INVALID_URL', 'URL thứ ' + (i + 1) + ' phải bắt đầu bằng http:// hoặc https://');
    if (u.length > ANA_URL_MAX_) throw mk_('INVALID_URL', 'URL thứ ' + (i + 1) + ' dài quá ' + ANA_URL_MAX_ + ' ký tự.');
    if (have[u]) { dup++; return; }
    have[u] = 1; fresh[u] = 1; next.push(u); added++;
  });
  var errLeft = q.e.filter(function (x) { return !fresh[x[0]]; });
  if (!anaSave_({ w: next, h: q.h, e: errLeft })) throw mk_('QUEUE_FULL', 'Hàng chờ phân tích đầy, chờ phân tích xong bớt rồi thêm tiếp.');
  return { added: added, dup: dup, state: getState_() };
}

function analyzeAndHold_(url) {
  try {
    return analyzeHoldCore_(url);
  } catch (e) {
    failPending_(url, e && e.message);
    throw e;
  }
}

function analyzeHoldCore_(url) {
  var r = analyzeBook_(url), out;
  if (r.existing) {
    out = withLock_(function () {
      var o = r.newChapters && r.newChapters.length ? addMissingChapters_(r.existing, r.newChapters) : { added: 0 };
      anaDone_(url, '', '');
      return o;
    });
    if (out && out.busy) return { busy: true };
    return { existing: r.existing, added: out.added, state: getState_() };
  }
  out = withLock_(function () {
    var c = createBook_(r.info, true);
    anaDone_(url, c.id || '', r.info.url);
    return c;
  });
  if (out && out.busy) return { busy: true };
  if (r.warn) writeLogs_([[stamp_(), out.id || '', '', 'ANALYZE', 'WARN', r.warn]]);
  return { created: r.info.name, id: out.id || '', warn: r.warn || '', state: getState_() };
}

function moveAnalyzed_(ids) {
  if (!Array.isArray(ids) || !ids.length) throw mk_('UNKNOWN_ERROR', 'Chưa chọn truyện nào để chuyển xuống tải.');
  if (ids.length > ANA_MOVE_MAX_) throw mk_('UNKNOWN_ERROR', 'Mỗi lần chuyển tối đa ' + ANA_MOVE_MAX_ + ' truyện.');
  var want = {};
  ids.forEach(function (id) { want[String(id)] = 1; });
  var cfg = getConfig_(), books = readBooks_(), cap = Math.max(1, +cfg.MAX_CONCURRENT || 1);
  var web = books.filter(function (x) { return x.site !== 'FILE'; });
  var active = web.filter(function (x) { return x.status === 'DOWNLOADING' || x.status === 'READY'; }).length;
  var waiting = web.some(function (x) { return x.status === 'IDLE'; });
  var s = db_().getSheetByName('BOOKS'), col = s.getRange(2, 9, s.getLastRow() - 1, 1).getValues();
  var started = 0, queued = 0, moved = [];
  books.forEach(function (b) {
    if (!want[b.id] || b.status !== 'ANALYZED') return;
    var busy = active >= cap || waiting;
    col[b.row - 2][0] = busy ? 'IDLE' : 'DOWNLOADING';
    if (busy) { queued++; waiting = true; } else { started++; active++; }
    moved.push(b.id);
  });
  if (!moved.length) throw mk_('UNKNOWN_ERROR', 'Các truyện đã chọn không còn trong danh sách đã phân tích.');
  s.getRange(2, 9, col.length, 1).setValues(col);
  SpreadsheetApp.flush();
  anaDrop_(moved);
  if (cfg.AUTO_RESUME) ensureTrigger_();
  return { moved: moved.length, started: started, queued: queued, state: getState_() };
}

var REMOVED_LOG_NAME_ = '_Chương lỗi đã xóa.txt';
var ADD_TEXT_MAX_ = 300000;
var ADD_URL_MAX_ = 2000;
var ADD_KINDS_ = { link: 1, file: 1, paste: 1 };

function logCell_(v) {
  return String(v == null ? '' : v).replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function removedLine_(it) {
  var shown = it.dnum !== '' && it.dnum != null && it.dnum !== '*' ? it.dnum : it.num;
  var group = logCell_([it.part, it.vol].filter(Boolean).join(' › '));
  return [stamp_(), 'Chương ' + logCell_(shown), group || '(không có)', logCell_(it.title) || '(chưa rõ)', logCell_(it.url) || '(không có)', logCell_(it.reason)].join(' | ');
}

function removedItem_(row, reason) {
  return { num: row[1], title: row[2], url: row[3], part: row[9], vol: row[10], dnum: row[11], reason: reason };
}

function removedLogAppend_(b, items) {
  if (!items || !items.length) return;
  var props = PropertiesService.getScriptProperties(), key = 'DEL_' + b.folderId, id = props.getProperty(key);
  var lines = items.map(removedLine_).join('\n') + '\n';
  try {
    if (id && fileOk_(id)) {
      var file = DriveApp.getFileById(id);
      file.setContent(file.getBlob().getDataAsString('UTF-8') + lines);
      return;
    }
    var head = 'Các chương lỗi đã bị xóa khỏi truyện "' + b.name + '".\nMỗi dòng: thời điểm | chương | phần › quyển | tiêu đề | link | lý do.\nMuốn thêm lại: mở truyện ở Quản lý sách, bấm ✏️, mục Thêm chương, chọn đúng Phần, Quyển, thứ tự chương rồi dán link.\n\n';
    var created = DriveApp.getFolderById(b.folderId).createFile(Utilities.newBlob(head + lines, 'text/plain', REMOVED_LOG_NAME_));
    props.setProperty(key, created.getId());
  } catch (e) {
    writeLogs_([[stamp_(), b.id, '', 'REMOVE', 'WARN', 'Không ghi được file chương lỗi đã xóa: ' + e.message]]);
  }
}

function chapterGroups_(id) {
  findBook_(id);
  var map = {}, list = [];
  bookRows_(id).rows.forEach(function (r) {
    var part = String(r[9] || ''), vol = String(r[10] || ''), k = part + '\u0001' + vol;
    if (!map[k]) { map[k] = { part: part, vol: vol, count: 0 }; list.push(map[k]); }
    map[k].count++;
  });
  return { groups: list };
}

function sameName_(a, b) { return normName_(a) === normName_(b); }

function leadInt_(s) { var m = String(s || '').match(/\d+/); return m ? +m[0] : null; }

function cmpName_(a, b) {
  var x = leadInt_(a), y = leadInt_(b);
  if (x !== null && y !== null && x !== y) return x < y ? -1 : 1;
  var p = normName_(a), q = normName_(b);
  return p < q ? -1 : (p > q ? 1 : 0);
}

function cmpGroup_(a, b) { return cmpName_(a.part, b.part) || cmpName_(a.vol, b.vol); }

function dnumValue_(r) {
  var d = r[11];
  if (d === '' || d == null) return +r[1];
  var m = String(d).match(/^(\d+)-(\d+)$/);
  if (m) return +m[1] + (+m[2]) / 100000;
  return isNaN(+d) ? +r[1] : +d;
}

function pickName_(chosen, existing, allowBlank, allowNew, label) {
  if (typeof chosen !== 'string') throw mk_('INVALID_CHAPTER', 'Chọn ' + label + ' cho chương.');
  var name = cleanName_(chosen);
  if (!name) {
    if (!allowBlank) throw mk_('INVALID_CHAPTER', 'Chọn ' + label + ' cho chương.');
    return { name: '', isNew: false };
  }
  var hit = existing.filter(function (x) { return sameName_(x, name); })[0];
  if (hit !== undefined) return { name: hit, isNew: false };
  if (allowNew) assertNoFormula_(name, 'Tên ' + label + ' mới');
  if (!allowNew) throw mk_('INVALID_CHAPTER', label + ' "' + name + '" chưa có trong truyện. Chọn "Tạo mới" nếu muốn tạo.');
  return { name: name, isNew: true };
}

function pickGroup_(rows, f) {
  var hasPart = rows.some(function (r) { return r[9]; }), hasVol = rows.some(function (r) { return r[10]; });
  var part = '', vol = '';
  if (!hasPart && !hasVol) {
    if (cleanName_(f.part) || cleanName_(f.vol)) throw mk_('INVALID_CHAPTER', 'Truyện này không chia Phần, Quyển.');
    return { part: '', vol: '' };
  }
  if (hasPart) {
    var parts = [];
    rows.forEach(function (r) { if (r[9] && parts.indexOf(String(r[9])) < 0) parts.push(String(r[9])); });
    part = pickName_(f.part, parts, rows.some(function (r) { return !r[9]; }), f.newPart === true, 'Phần').name;
  } else if (cleanName_(f.part)) throw mk_('INVALID_CHAPTER', 'Truyện này không chia Phần.');
  if (hasVol) {
    var inPart = rows.filter(function (r) { return String(r[9] || '') === part; }), vols = [];
    inPart.forEach(function (r) { if (r[10] && vols.indexOf(String(r[10])) < 0) vols.push(String(r[10])); });
    vol = pickName_(f.vol, vols, !inPart.length || inPart.some(function (r) { return !r[10]; }), f.newVol === true, 'Quyển').name;
  } else if (cleanName_(f.vol)) throw mk_('INVALID_CHAPTER', 'Truyện này không chia Quyển.');
  return { part: part, vol: vol };
}

function parseOrder_(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (s === '') throw mk_('INVALID_CHAPTER', 'Nhập thứ tự chương.');
  if (!/^\d{1,5}$/.test(s) || +s < 1) throw mk_('INVALID_CHAPTER', 'Thứ tự chương phải là số nguyên từ 1 đến 99999.');
  return +s;
}

function groupLabel_(g) { return [g.part, g.vol].filter(Boolean).join(' › ') || 'nhóm này'; }

function placeChapter_(rows, g, k) {
  var sorted = rows.slice().sort(function (a, b) { return a[1] - b[1]; });
  var inGroup = sorted.filter(function (r) { return String(r[9] || '') === g.part && String(r[10] || '') === g.vol; });
  if (!g.part && !g.vol) {
    if (sorted.some(function (r) { return +r[1] === k; })) throw mk_('DUPLICATE_CHAPTER', 'Thứ tự ' + k + ' đã có trong truyện. Chọn số khác hoặc xóa chương đó trước.');
    var spans = {};
    sorted.forEach(function (r) {
      if (!r[9] && !r[10]) return;
      var key = String(r[9] || '') + '\u0001' + String(r[10] || ''), n = +r[1];
      if (!spans[key]) spans[key] = { part: String(r[9] || ''), vol: String(r[10] || ''), lo: n, hi: n };
      spans[key].lo = Math.min(spans[key].lo, n); spans[key].hi = Math.max(spans[key].hi, n);
    });
    Object.keys(spans).forEach(function (key) {
      var sp = spans[key];
      if (k > sp.lo && k < sp.hi) throw mk_('DUPLICATE_CHAPTER', 'Thứ tự ' + k + ' rơi vào giữa ' + groupLabel_(sp) + '. Chọn số khác.');
    });
    return { num: k, dnum: '' };
  }
  if (inGroup.some(function (r) { return dnumValue_(r) === k; })) throw mk_('DUPLICATE_CHAPTER', groupLabel_(g) + ' đã có chương ' + k + '. Chọn số khác hoặc xóa chương đó trước.');
  function between(i) {
    var a = +sorted[i][1], nx = sorted[i + 1];
    if (!nx) return Math.floor(a) + 1;
    var m = Math.round((a + +nx[1]) / 2 * 1e6) / 1e6;
    if (m <= a || m >= +nx[1]) throw mk_('INVALID_CHAPTER', 'Không còn chỗ trống để chèn chương vào vị trí này.');
    return m;
  }
  function before(i) { return i === 0 ? +sorted[0][1] - 1 : between(i - 1); }
  if (inGroup.length) {
    for (var i = 0; i < inGroup.length; i++) if (dnumValue_(inGroup[i]) > k) return { num: before(sorted.indexOf(inGroup[i])), dnum: k };
    return { num: between(sorted.indexOf(inGroup[inGroup.length - 1])), dnum: k };
  }
  var seen = {}, order = [];
  sorted.forEach(function (r, idx) {
    var key = String(r[9] || '') + '\u0001' + String(r[10] || '');
    if (!seen[key]) { seen[key] = { part: String(r[9] || ''), vol: String(r[10] || ''), first: idx, last: idx }; order.push(seen[key]); }
    seen[key].last = idx;
  });
  var named = order.filter(function (x) { return x.part || x.vol; }), after = null;
  named.forEach(function (x) { if (cmpGroup_(x, g) < 0) after = x; });
  return { num: after ? between(after.last) : before(named.length ? named[0].first : 0), dnum: k };
}

function addChapterManual_(id, kind, f) {
  var b = findBook_(id);
  if (!ADD_KINDS_[kind]) throw mk_('INVALID_CHAPTER', 'Chọn cách thêm chương: từ link, từ file hoặc dán nội dung.');
  f = f || {};
  var title = cleanName_(f.title);
  assertNoFormula_(title, 'Tiêu đề');
  var br = bookRows_(id), g = pickGroup_(br.rows, f), k = parseOrder_(f.num), pos = placeChapter_(br.rows, g, k);
  var at = { num: pos.num, dnum: pos.dnum, part: g.part, vol: g.vol, title: title };
  if (kind === 'link') return addChapterByLink_(b, br, at, f.url);
  return addChapterByText_(b, br, at, f.text, kind === 'file' ? 'file ' + cleanName_(f.fileName) : 'nội dung dán');
}

function addChapterByLink_(b, br, at, rawUrl) {
  var url = String(rawUrl == null ? '' : rawUrl).trim();
  if (b.site === 'FILE') throw mk_('INVALID_CHAPTER', 'Truyện thêm từ file không tải được từ link. Dùng cách từ file hoặc dán nội dung.');
  if (!url) throw mk_('INVALID_URL', 'Nhập link chương.');
  if (url.length > ADD_URL_MAX_) throw mk_('INVALID_URL', 'Link chương dài quá ' + ADD_URL_MAX_ + ' ký tự.');
  if (!/^https?:\/\/[^\/\s]+\S*$/i.test(url)) throw mk_('INVALID_URL', 'Link chương phải bắt đầu bằng http:// hoặc https:// và không có khoảng trắng.');
  var dup = br.rows.filter(function (r) { return r[3] === url; })[0];
  if (dup) throw mk_('DUPLICATE_CHAPTER', 'Link này đã có trong truyện (chương ' + (dup[11] !== '' ? dup[11] : dup[1]) + ').');
  insertChapterRows_(br, [[b.id, at.num, at.title, url, 'PENDING', '', 0, '', '', at.part, at.vol, at.dnum]]);
  var sb = db_().getSheetByName('BOOKS');
  sb.getRange(b.row, 6).setValue(b.total + 1);
  sb.getRange(b.row, 9).setValue(statusAfterAdd_(b));
  if (getConfig_().AUTO_RESUME) ensureTrigger_();
  writeLogs_([[stamp_(), b.id, at.num, 'ADD_CHAPTER', 'SUCCESS', 'Thêm chương ' + (at.dnum !== '' ? at.dnum : at.num) + (at.part || at.vol ? ' (' + [at.part, at.vol].filter(Boolean).join(' › ') + ')' : '') + ' từ link: ' + url]]);
  return { state: getState_(), num: at.dnum !== '' ? at.dnum : at.num };
}

function addChapterByText_(b, br, at, rawText, source) {
  var text = String(rawText == null ? '' : rawText).replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
  if (!text) throw mk_('INVALID_CHAPTER', 'Nhập nội dung chương.');
  if (text.length > ADD_TEXT_MAX_) throw mk_('INVALID_CHAPTER', 'Nội dung chương tối đa ' + ADD_TEXT_MAX_ + ' ký tự.');
  var shown = at.dnum !== '' ? at.dnum : at.num, bookFolder, folder;
  try { bookFolder = DriveApp.getFolderById(b.folderId); folder = chapterFolder_(bookFolder, at.part, at.vol); }
  catch (e) { throw mk_('DRIVE_ERROR', 'Không truy cập được thư mục truyện trên Drive. Kiểm tra quyền rồi thử lại.'); }
  if (findByNum_(folder, shown, b.label)) throw mk_('DUPLICATE_CHAPTER', 'Thư mục Drive đã có file của chương ' + shown + '. Xóa file đó hoặc chọn số khác.');
  var tp = tidyChapter_(text, getConfig_().JUNK_WORDS), body = tp.body && tp.body.trim() ? tp.body : text;
  var derived = cleanName_(tp.title), title = at.title || (startsFormula_(derived) ? '' : derived);
  var fid = writeImportChapterFile_(bookFolder, b.name, b.label, { num: at.num, dnum: at.dnum, marked: at.dnum !== '', part: at.part, vol: at.vol, title: title, body: body });
  insertChapterRows_(br, [[b.id, at.num, title, '', 'DONE', fid, 0, '', stamp_(), at.part, at.vol, at.dnum]]);
  db_().getSheetByName('BOOKS').getRange(b.row, 6, 1, 2).setValues([[b.total + 1, b.done + 1]]);
  writeLogs_([[stamp_(), b.id, at.num, 'ADD_CHAPTER', 'SUCCESS', 'Thêm chương ' + shown + (at.part || at.vol ? ' (' + [at.part, at.vol].filter(Boolean).join(' › ') + ')' : '') + ' từ ' + source]]);
  return { state: getState_(), num: shown };
}

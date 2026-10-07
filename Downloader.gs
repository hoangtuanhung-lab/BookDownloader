function siteCookie_(url, cfg) {
  var host = hostOf_(url), lines = String(cfg.SITE_COOKIES || '').split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim(); if (!line) continue;
    var p = line.indexOf('='); if (p < 0) continue;
    var domain = line.slice(0, p).trim().toLowerCase().replace(/^www\./, '');
    if (domain && host.indexOf(domain) >= 0) return line.slice(p + 1).trim();
  }
  return '';
}

function fetch_(url, cfg) {
  var last = null, ck = siteCookie_(url, cfg);
  var headers = { 'User-Agent': UA, 'Accept-Language': 'vi,en;q=0.8', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Referer': (url.match(/^https?:\/\/[^\/]+/) || [''])[0] + '/' };
  if (ck) headers.Cookie = ck;
  for (var i = 1; i <= cfg.MAX_RETRY; i++) {
    var r = null;
    try { r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: headers }); }
    catch (e) { last = mk_('NETWORK_ERROR', e.message); last.tries = i; Utilities.sleep(cfg.DELAY_MS * i); continue; }
    var c = r.getResponseCode();
    if (c === 200) return r.getContentText('UTF-8');
    if (c === 403 || c === 401) {
      throw mk_('LOGIN_REQUIRED', 'Trang từ chối truy cập (HTTP ' + c + ')' + (ck
        ? ' dù đã gửi cookie cho ' + hostOf_(url) + ' — cookie có thể đã hết hạn, đăng nhập lại bằng trình duyệt rồi cập nhật trong Cài đặt.'
        : ' — trang này có thể chặn tải tự động hoặc yêu cầu đăng nhập. Đăng nhập bằng trình duyệt, sao chép Cookie của trang rồi dán vào mục "Cookie đăng nhập theo trang" trong Cài đặt.'));
    }
    last = mk_('HTTP_ERROR', 'HTTP ' + c); last.tries = i;
    if ([429, 500, 502, 503, 504].indexOf(c) < 0) break;
    Utilities.sleep(cfg.DELAY_MS * i);
  }
  throw last;
}

var EMPTY_RUN_MAX_ = 3;

function isEmptyRow_(r) { return r[4] === 'ERROR' && /^(NO_CONTENT|TOO_SHORT):|^PARSER_ERROR: Nội dung chương quá ngắn/.test(String(r[7])); }

function emptyRuns_(rows) {
  var drop = [], i = 0, n = rows.length;
  while (i < n) {
    if (!isEmptyRow_(rows[i])) { i++; continue; }
    var j = i;
    while (j < n && isEmptyRow_(rows[j])) j++;
    var before = i === 0 || rows[i - 1][4] === 'DONE', after = j < n && rows[j][4] === 'DONE';
    if (j - i <= EMPTY_RUN_MAX_ && before && after) for (var k = i; k < j; k++) drop.push(k);
    i = j;
  }
  return drop;
}

function runBatch_(b, cfg, deadline) {
  var br = bookRows_(b.id), rows = br.rows, folder = DriveApp.getFolderById(b.folderId), logs = [], todo = 0;
  writeBookInfo_(folder, b);
  var isFile = b.site === 'FILE', imp = isFile ? loadImportData_(folder) : null;
  for (var i = 0; i < rows.length && todo < cfg.BATCH_SIZE; i++) {
    var r = rows[i];
    if (r[4] === 'DONE' || r[4] === 'ERROR') continue;
    if (Date.now() > deadline) break;
    todo++;
    var num = r[1];
    r[4] = 'DOWNLOADING'; writeStatusCell_(br, i, 'DOWNLOADING');
    try {
      if (fileOk_(r[5])) { r[4] = 'DONE'; continue; }
      var chd = isFile ? imp[num] : null;
      var vol = !isFile ? r[10] : '', part = !isFile ? r[9] : '', dnum = !isFile && r[11] !== '' && r[11] != null ? r[11] : num;
      var tgtFolder = vol || part ? chapterFolder_(folder, part, vol) : folder;
      var ex = chd && chd.marked ? findImportFile_(folder, b.label, chd) : findByNum_(tgtFolder, dnum);
      if (ex) { r[4] = 'DONE'; r[5] = ex.getId(); r[7] = ''; r[8] = stamp_(); logs.push([stamp_(), b.id, num, 'RECOVER', 'SUCCESS', 'File đã có']); continue; }
      if (isFile) {
        var ch = imp[num];
        if (!ch) throw mk_('PARSER_ERROR', 'Không tìm thấy dữ liệu chương này trong bản lưu tạm — có thể "_import.json" đã bị xoá thủ công khỏi thư mục truyện.');
        var fid = writeImportChapterFile_(folder, b.name, b.label, ch);
        r[2] = ch.title; r[4] = 'DONE'; r[5] = fid; r[7] = ''; r[8] = stamp_();
        logs.push([stamp_(), b.id, num, 'IMPORT', 'SUCCESS', 'File created']);
      } else {
        var c = getChapter_(r[3], cfg, num), name = fname_(dnum, c.title);
        var selfTitled = /^(?:(?:quyển|quyen|tập|tap)\s*\d+\s*[-–:.]?\s*)?(?:chương|chuong|chapter|chap)\s*\d+/i.test(c.title);
        var head = selfTitled ? c.title : 'Chương ' + pad_(dnum) + ': ' + c.title;
        var f = tgtFolder.createFile(Utilities.newBlob(b.name + '\n\n' + head + '\n\n' + c.text, 'text/plain', name));
        r[2] = c.title; r[4] = 'DONE'; r[5] = f.getId(); r[7] = ''; r[8] = stamp_();
        logs.push([stamp_(), b.id, num, 'DOWNLOAD', 'SUCCESS', c.auto ? 'File created (vùng nội dung tự dò)' : 'File created']);
      }
    } catch (e) {
      r[4] = 'ERROR'; r[6] = e.tries || (+r[6] || 0) + 1; r[7] = (e.type || 'UNKNOWN_ERROR') + ': ' + e.message; r[8] = stamp_();
      logs.push([stamp_(), b.id, num, isFile ? 'IMPORT' : 'DOWNLOAD', 'ERROR', r[7]]);
    }
    if (!isFile) Utilities.sleep(cfg.DELAY_MS);
  }
  writeBlock_(br);
  var dropIdx = isFile ? [] : emptyRuns_(rows), dropped = dropIdx.length, removed = [];
  if (dropped) {
    for (var d = dropIdx.length - 1; d >= 0; d--) {
      var dr = rows[dropIdx[d]];
      br.s.deleteRows(br.first + 2 + dropIdx[d], 1);
      var why = /^NO_CONTENT:/.test(String(dr[7])) ? 'Không có nội dung' : 'Nội dung quá ngắn';
      logs.push([stamp_(), b.id, dr[1], 'REMOVE', 'SUCCESS', 'Chương ' + why.toLowerCase() + ', đã xóa khỏi danh sách: ' + dr[3]]);
      removed.unshift(removedItem_(dr, why));
      rows.splice(dropIdx[d], 1);
    }
    SpreadsheetApp.flush();
    removedLogAppend_(b, removed);
  }
  var c2 = count_(rows), st = c2.pend === 0 ? (c2.err ? 'ERROR' : 'COMPLETED') : 'DOWNLOADING';
  var cur = readBooks_().filter(function (x) { return x.id === b.id; })[0];
  if (!cur) { writeLogs_(logs); return { todo: todo, pend: c2.pend, status: st, gone: true }; }
  var s = db_().getSheetByName('BOOKS');
  s.getRange(cur.row, 6, 1, 4).setValues([[rows.length, c2.done, c2.err, st]]);
  SpreadsheetApp.flush();
  if (isFile && st === 'COMPLETED') {
    deleteImportData_(folder);
    logs.push([stamp_(), b.id, '', 'IMPORT', 'SUCCESS', 'Hoàn tất thêm truyện từ file: ' + c2.done + ' ' + (b.label === 'Hồi' ? 'hồi' : 'chương')]);
  }
  writeLogs_(logs);
  return { todo: todo, pend: c2.pend, status: st, dropped: dropped };
}

function drive_(maxMs) {
  if (!tryStartTick_()) return;
  try {
    var cfg = getConfig_(), t0 = Date.now(), deadline = t0 + maxMs;
    for (;;) {
      var books = readBooks_();
      var rFile = runOneKind_(books, true, cfg, deadline, maxMs);
      var rUrl = runOneKind_(books, false, cfg, deadline, maxMs);
      if (!rFile.anyLeft && !rUrl.anyLeft) { removeTriggers_(); return; }
      if (rFile.returnNow || rUrl.returnNow) return;
      if (rFile.sawBusy || rUrl.sawBusy) { Utilities.sleep(500); continue; }
      if (Date.now() > deadline - 20000) return;
      Utilities.sleep(300);
    }
  } finally { endTick_(); }
}

function runOneKind_(books, isFile, cfg, deadline, maxMs) {
  var cap = Math.max(1, +cfg.MAX_CONCURRENT || 1);
  var mine = books.filter(function (x) { return (x.site === 'FILE') === isFile; });
  var downloading = mine.filter(function (x) { return x.status === 'DOWNLOADING'; });
  var ready = mine.filter(function (x) { return x.status === 'READY'; })[0];
  if (ready) {
    var pr = withLock_(function () { return startReady_(ready.id); });
    return { anyLeft: true, returnNow: false, sawBusy: !!(pr && pr.busy) };
  }
  if (downloading.length < cap) {
    var idle = mine.filter(function (x) { return x.status === 'IDLE'; })[0];
    if (idle) {
      var pi = withLock_(function () { return promoteIdle_(idle.id); });
      return { anyLeft: true, returnNow: maxMs < 60000, sawBusy: !!(pi && pi.busy) };
    }
  }
  if (!downloading.length) return { anyLeft: false, returnNow: false, sawBusy: false };
  var sawBusy = false;
  for (var k = 0; k < downloading.length; k++) {
    if (Date.now() > deadline - 5000) break;
    var out = withLock_(function () { return runBatch_(downloading[k], cfg, Math.min(deadline, Date.now() + 20000)); });
    if (out && out.busy) sawBusy = true;
  }
  return { anyLeft: true, returnNow: maxMs < 60000, sawBusy: sawBusy };
}

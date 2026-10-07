var DB_MEMO_ = null;
function db_() {
  if (DB_MEMO_) return DB_MEMO_;
  var p = PropertiesService.getScriptProperties(), id = p.getProperty('DB_ID'), ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create(DB_NAME); p.setProperty('DB_ID', ss.getId());
    var c = ss.getSheets()[0].setName('CONFIG');
    c.getRange(1, 1, 1, 2).setValues([['Key', 'Value']]).setFontWeight('bold');
    var kv = Object.keys(DEFAULTS).map(function (k) { return [k, DEFAULTS[k]]; });
    c.getRange(2, 1, kv.length, 2).setValues(kv);
    [['BOOKS', BOOK_H, 'J:J'], ['CHAPTERS', CH_H, 'I:L'], ['LOG', LOG_H, 'A:A']].forEach(function (s) {
      var sh = ss.insertSheet(s[0]);
      sh.getRange(1, 1, 1, s[1].length).setValues([s[1]]).setFontWeight('bold');
      sh.getRange(s[2]).setNumberFormat('@');
    });
  }
  ensureSchema_(ss);
  DB_MEMO_ = ss;
  return ss;
}
var SCHEMA_OK_ = false;
function ensureSchema_(ss) {
  if (SCHEMA_OK_) return;
  var s = ss.getSheetByName('BOOKS');
  if (s.getMaxColumns() < 13) s.insertColumnsAfter(s.getMaxColumns(), 13 - s.getMaxColumns());
  ensureHeaders_(s, 11, ['Tác giả', 'Thể loại', 'Nhãn chương']);
  var cs = ss.getSheetByName('CHAPTERS');
  if (cs.getMaxColumns() < 12) cs.insertColumnsAfter(cs.getMaxColumns(), 12 - cs.getMaxColumns());
  ensureHeaders_(cs, 10, ['Phần', 'Quyển', 'Số hiệu']);
  ensureTextFormats_(ss);
  SCHEMA_OK_ = true;
}
var TEXT_FORMATS_ = [['BOOKS', 'B:E'], ['CHAPTERS', 'C:D'], ['CHAPTERS', 'H:H'], ['LOG', 'F:F']];
function ensureTextFormats_(ss) {
  var p = PropertiesService.getScriptProperties();
  if (p.getProperty('FMT_TEXT') === '1') return;
  TEXT_FORMATS_.forEach(function (f) { ss.getSheetByName(f[0]).getRange(f[1]).setNumberFormat('@'); });
  p.setProperty('FMT_TEXT', '1');
}
function ensureHeaders_(sheet, firstCol, labels) {
  var have = sheet.getRange(1, firstCol, 1, labels.length).getValues()[0];
  if (labels.every(function (l, i) { return have[i] === l; })) return;
  sheet.getRange(1, firstCol, 1, labels.length).setValues([labels]).setFontWeight('bold');
  sheet.getRange(1, firstCol, sheet.getMaxRows(), labels.length).setNumberFormat('@');
}

function readBooks_() {
  var s = db_().getSheetByName('BOOKS'), n = s.getLastRow();
  if (n < 2) return [];
  return s.getRange(2, 1, n - 1, 13).getValues().map(function (r, i) {
    return { row: i + 2, id: r[0], name: r[1], url: r[2], site: r[3], folderId: r[4], total: +r[5] || 0, done: +r[6] || 0, err: +r[7] || 0, status: r[8], created: String(r[9]), author: String(r[10] || ''), genre: String(r[11] || ''), label: String(r[12] || '') || 'Chương' };
  });
}

function getState_() {
  var cfg = getConfig_(), books = readBooks_(), dl = books.filter(function (b) { return b.status === 'DOWNLOADING'; });
  return { v: VERSION, u: UPDATED, cfg: cfg, books: books, hang: hangState_(books), active: dl.map(function (b) { return { id: b.id, chapters: activeRows_(b.id, cfg.BATCH_SIZE) }; }) };
}

function bookRows_(bookId) {
  var s = db_().getSheetByName('CHAPTERS'), n = s.getLastRow();
  if (n < 2) return { s: s, first: -1, rows: [] };
  var all = s.getRange(2, 1, n - 1, 12).getValues(), first = -1, last = -1;
  for (var i = 0; i < all.length; i++) if (all[i][0] === bookId) { if (first < 0) first = i; last = i; }
  return { s: s, first: first, rows: first < 0 ? [] : all.slice(first, last + 1) };
}

function writeBlock_(b) { if (b.rows.length) { b.s.getRange(b.first + 2, 1, b.rows.length, CH_COLS_).setValues(b.rows.map(function (r) { return r.slice(0, CH_COLS_); })); SpreadsheetApp.flush(); } }

function writeStatusCell_(b, idx, status) {
  if (b.first < 0) return;
  b.s.getRange(b.first + 2 + idx, 5).setValue(status);
  SpreadsheetApp.flush();
}

function count_(rows) {
  var d = 0, e = 0, p = 0;
  rows.forEach(function (r) { if (r[4] === 'DONE') d++; else if (r[4] === 'ERROR') e++; else p++; });
  return { done: d, err: e, pend: p };
}

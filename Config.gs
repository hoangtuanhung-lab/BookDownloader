var DB_NAME = 'TRUYEN_DOWNLOADER_DB';

var DEFAULTS = { ROOT_FOLDER: 'TRUYEN_DOWNLOADER', ROOT_FOLDER_ID: '', BATCH_SIZE: 5, DELAY_MS: 800, MAX_RETRY: 3, MAX_CONCURRENT: 2, FILE_TYPE: 'TXT', ENCODING: 'UTF-8', AUTO_RESUME: 'TRUE', JUNK_WORDS: 'truyen full, truyenfull, truyenfullvn, truyenfulllive, truyenfull vn', SITE_COOKIES: '', SITE_RULES: '', GENRES: '[]' };

var BOOK_H = ['ID', 'Tên truyện', 'URL', 'Website', 'Folder ID', 'Tổng chương', 'Đã tải', 'Lỗi', 'Trạng thái', 'Ngày tạo', 'Tác giả', 'Thể loại', 'Nhãn chương'];

var CH_H = ['Book ID', 'Chương', 'Tiêu đề', 'URL', 'Status', 'File ID', 'Retry', 'Error', 'Updated', 'Phần', 'Quyển', 'Số hiệu'];
var CH_COLS_ = 9;

var LOG_H = ['Time', 'Book ID', 'Chapter', 'Action', 'Result', 'Message'];

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function getConfig_() {
  var v = db_().getSheetByName('CONFIG').getDataRange().getValues(), c = {};
  Object.keys(DEFAULTS).forEach(function (k) { c[k] = DEFAULTS[k]; });
  v.slice(1).forEach(function (r) { if (r[0]) c[r[0]] = r[1]; });
  c.BATCH_SIZE = Math.max(1, +c.BATCH_SIZE || 5); c.DELAY_MS = Math.max(0, +c.DELAY_MS || 0); c.MAX_RETRY = Math.max(1, +c.MAX_RETRY || 3);
  c.MAX_CONCURRENT = Math.max(1, Math.min(10, +c.MAX_CONCURRENT || 2));
  c.ROOT_FOLDER_ID = String(c.ROOT_FOLDER_ID || '').trim();
  c.AUTO_RESUME = String(c.AUTO_RESUME).toUpperCase() === 'TRUE';
  c.JUNK_WORDS = String(c.JUNK_WORDS == null ? DEFAULTS.JUNK_WORDS : c.JUNK_WORDS);
  c.SITE_COOKIES = String(c.SITE_COOKIES == null ? '' : c.SITE_COOKIES);
  c.SITE_RULES = String(c.SITE_RULES == null ? '' : c.SITE_RULES);
  c.GENRES = parseGenres_(c.GENRES);
  return c;
}

function writeConfig_(obj) {
  var s = db_().getSheetByName('CONFIG'), v = s.getDataRange().getValues().map(function (r) { return [r[0], r[1]]; }), pos = {}, add = [];
  v.forEach(function (r, i) { if (i > 0 && r[0]) pos[r[0]] = i; });
  Object.keys(obj).forEach(function (k) { var x = typeof obj[k] === 'string' && startsFormula_(obj[k]) ? ' ' + obj[k] : obj[k]; if (k in pos) v[pos[k]][1] = x; else add.push([k, x]); });
  s.getRange(1, 1, v.length, 2).setValues(v);
  if (add.length) s.getRange(s.getLastRow() + 1, 1, add.length, 2).setValues(add);
}
function saveConfig_(cfg) {
  var o = {};
  if (cfg.SITE_RULES !== undefined) {
    var rules = String(cfg.SITE_RULES);
    if (rules.length > RULES_MAX_) throw mk_('INVALID_CONFIG', 'SITE_RULES tối đa ' + RULES_MAX_ + ' ký tự.');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(rules)) throw mk_('INVALID_CONFIG', 'SITE_RULES có ký tự điều khiển không hợp lệ.');
  }
  ['BATCH_SIZE', 'DELAY_MS', 'MAX_RETRY', 'MAX_CONCURRENT', 'FILE_TYPE', 'ENCODING', 'AUTO_RESUME', 'JUNK_WORDS', 'SITE_COOKIES', 'SITE_RULES'].forEach(function (k) { if (cfg[k] !== undefined) o[k] = cfg[k]; });
  writeConfig_(o);
  CacheService.getScriptCache().remove('rdjunk');
}

var GENRES_MAX_ = 500;
function parseGenres_(v) {
  try { var a = JSON.parse(String(v == null || v === '' ? '[]' : v)); return Array.isArray(a) ? a.map(String) : []; } catch (e) { return []; }
}
function cleanGenreList_(list) {
  var out = [], seen = {};
  (Array.isArray(list) ? list : []).forEach(function (g) {
    g = cleanName_(String(g == null ? '' : g).replace(/[,;\/]/g, ' '));
    var k = normName_(g);
    if (g && !seen[k]) { seen[k] = 1; out.push(g); }
  });
  return out;
}
function saveGenres_(list) {
  var g = cleanGenreList_(list);
  if (g.length > GENRES_MAX_) throw mk_('INVALID_CONFIG', 'Tối đa ' + GENRES_MAX_ + ' thể loại.');
  writeConfig_({ GENRES: JSON.stringify(g) });
}

function junkWords_() {
  var c = CacheService.getScriptCache(), v = c.get('rdjunk');
  if (v === null) { v = String(getConfig_().JUNK_WORDS); c.put('rdjunk', 'J:' + v, 21600); return v; }
  return v.slice(2);
}

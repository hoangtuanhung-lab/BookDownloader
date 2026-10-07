var CH_HEAD_ = /^(?:(?:quyển|quyen|tập|tap)\s*\d+\s*[:.\-–—]?\s*)?(chương|chuong|chapter|chap)\s*(\d+(?:[.\-]\d+)?)\s*(?:[:.\-–—]\s*(.*))?$/i;
var TOOLBAR_ = /^(?:chữto|chữnhỏ|chữlớn|cỡchữ|nềntối|nềnsáng|mặcđịnh|tối|sáng)+$/;

var HOI_HEAD_ = /^hồi\s+(?:thứ\s+)?([0-9]+|[a-zàáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ\s]+?)\s*(?:\[\d+\])?\s*[:.]?$/i;
var HOI_PREFIX_ = /^hồi\s+(?:thứ\s+)?([a-zàáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ\s]+)/i;
var PREAMBLE_HEAD_ = /^(lời\s*tựa|lời\s*nói\s*đầu|lời\s*mở\s*đầu|tựa|dẫn\s*nhập)\s*[:.]?$/i;

var VN_ORD_UNIT_ = { 'không': 0, 'một': 1, 'mốt': 1, 'nhất': 1, 'hai': 2, 'nhị': 2, 'ba': 3, 'tam': 3, 'tư': 4, 'bốn': 4, 'tứ': 4, 'năm': 5, 'lăm': 5, 'nhăm': 5, 'ngũ': 5, 'sáu': 6, 'lục': 6, 'bảy': 7, 'bẩy': 7, 'thất': 7, 'tám': 8, 'bát': 8, 'chín': 9, 'cửu': 9 };
function vnOrdinalToNum_(s) {
  s = String(s || '').toLowerCase().trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  var words = s.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  var total = 0, chunk = 0, last = 0, any = false;
  for (var i = 0; i < words.length; i++) {
    var w = words[i], f;
    if (w === 'mười' || w === 'mươi') { f = last || 1; chunk = chunk - last + f * 10; last = f * 10; any = true; }
    else if (w === 'trăm') { f = last || 1; chunk = chunk - last + f * 100; last = f * 100; any = true; }
    else if (w === 'nghìn' || w === 'ngàn') { f = last || 1; total += chunk - last + f * 1000; chunk = 0; last = 0; any = true; }
    else if (w === 'linh' || w === 'lẻ') { last = 0; }
    else if (VN_ORD_UNIT_.hasOwnProperty(w)) { chunk += VN_ORD_UNIT_[w]; last = VN_ORD_UNIT_[w]; any = true; }
    else return null;
  }
  return any ? total + chunk : null;
}

function parseHoiHead_(ln) {
  var m = HOI_HEAD_.exec(ln);
  if (m) {
    var num = vnOrdinalToNum_(m[1]);
    if (num !== null) return { num: num, ordinal: m[1].trim(), inline: '' };
  }
  var pm = HOI_PREFIX_.exec(ln);
  if (!pm) return null;
  var words = pm[1].trim().split(/\s+/).filter(Boolean);
  for (var k = words.length; k >= 1; k--) {
    var num2 = vnOrdinalToNum_(words.slice(0, k).join(' '));
    if (num2 === null) continue;
    var leftover = words.slice(k).join(' ');
    var rest = ln.slice(pm[0].length).replace(/^[\s,;:.\-–—]+/, '').trim();
    var inline = [leftover, rest].filter(Boolean).join(', ');
    return { num: num2, ordinal: words.slice(0, k).join(' '), inline: inline };
  }
  return null;
}

function normKey_(s) { return String(s).normalize('NFC').toLowerCase().replace(/[\s|·•:\-–—\/\\]+/g, ''); }

function isToolbar_(ln) { var k = normKey_(ln); return k.length > 0 && k.length <= 60 && TOOLBAR_.test(k); }

function toolbarAhead_(lines, j) {
  for (var n = 0; j < lines.length && n < 2; j++) {
    var t = lines[j].trim();
    if (!t) continue;
    n++;
    if (isToolbar_(t)) return true;
  }
  return false;
}

function splitHead_(text) {
  var lines = String(text).replace(/\r/g, '').split('\n'), i = 0, num = null, title = '', name = false, seen = 0, m;
  while (i < lines.length && seen < 6) {
    var ln = lines[i].trim();
    if (!ln) { i++; continue; }
    if (isToolbar_(ln)) { i++; seen++; continue; }
    if (!name && (m = CH_HEAD_.exec(ln))) { name = true; num = m[2]; if (m[3]) title = m[3].trim(); i++; seen++; continue; }
    if (name && !title && ln.length <= 200 && toolbarAhead_(lines, i + 1)) { title = ln; i++; seen++; continue; }
    break;
  }
  return { num: num, title: title, body: lines.slice(i).join('\n').replace(/^\s+/, '') };
}

function junkRe_(words) {
  var arr = String(words || '').split(/[,;\n]+/).map(function (w) { return w.trim(); }).filter(Boolean);
  if (!arr.length) return null;
  arr.sort(function (a, b) { return b.length - a.length; });
  var pats = arr.map(function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'); });
  return new RegExp('(?:' + pats.join('|') + ')(?:\\s*\\.\\s*(?:vn|com|net|live|me|org|info|xyz))?', 'i');
}

function stripJunk_(text, words) {
  var re = junkRe_(words);
  if (!re) return text;
  var g = new RegExp(re.source, 'gi'), out = [];
  String(text).split('\n').forEach(function (ln) {
    if (!re.test(ln)) { out.push(ln); return; }
    if (ln.trim().length <= 100) return;
    out.push(ln.replace(g, '').replace(/[ \t]{2,}/g, ' ').trim());
  });
  return out.join('\n');
}

function stripJunkInline_(s, words) {
  var re = junkRe_(words);
  return re ? String(s || '').replace(new RegExp(re.source, 'gi'), '').replace(/\s{2,}/g, ' ').trim() : String(s || '').trim();
}

function tidyChapter_(text, words) {
  var h = splitHead_(text);
  return {
    num: h.num,
    title: stripJunkInline_(h.title, words),
    body: stripJunk_(h.body, words).replace(/\n{4,}/g, '\n\n\n').trim()
  };
}

function titleOnly_(s) {
  var t = String(s || '').trim(), m = CH_HEAD_.exec(t);
  if (m) return String(m[3] || '').trim();
  m = /^(?:hồi|hoi)\s*\d+\s*(?:[:.\-–—]\s*(.*))?$/i.exec(t);
  return m ? String(m[1] || '').trim() : t;
}

function sig_(s) { var h = 0; s = String(s); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

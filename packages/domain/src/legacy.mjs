// Ported from V1.59.2 baseline aae3c570. Pure algorithms; provenance in docs/phase-1.
import { parse } from 'csv-parse/sync';
import { matchesDomain } from './index.ts';
const EMPTY_RUN_MAX_ = 3;
var MK_HEAD_ = /^(#{1,3})@\s*(.*)$/;
var MK_TITLE_ = /^@\s*(.*)$/;
var MK_PRE_ = /^00\s+(\S.*)$/;
var FOLDER_CH_HEAD_ = /^(chương|chuong|chapter|chap|hồi|hoi)\s*(\d+(?:[.\-]\d+)?)\s*(?:[-–:.]\s*(.*))?$/i;
var FOLDER_NUM_HEAD_ = /^(\d+(?:[.\-]\d+)?)\s*(?:[-–:.]\s*(.*))?$/;

function mk_(type, msg) { var e = Object.assign(new Error(msg), {type}); return e; }


function pad_(n) { return ('000' + n).slice(-Math.max(3, String(n).length)); }


function hostOf_(u) { var m = u.match(/^https?:\/\/([^\/?#]+)/i); return m ? m[1].toLowerCase().replace(/^www\./, '') : ''; }


function abs_(href, base) {
  href = href.replace(/&amp;/g, '&').split('#')[0];
  if (/^https?:/i.test(href)) return href;
  if (href.indexOf('//') === 0) return base.split(':')[0] + ':' + href;
  var o = base.match(/^https?:\/\/[^\/]+/)[0];
  if (href.charAt(0) === '/') return o + href;
  return base.replace(/[?#].*$/, '').replace(/[^\/]*$/, '') + href;
}


function normUrl_(u) {
  u = String(u || '').trim().split('#')[0];
  if (!/^https?:\/\/[^\/\s]+/i.test(u)) throw mk_('INVALID_URL', 'URL phải bắt đầu bằng http:// hoặc https://');
  var m = u.match(/^(https?:\/\/[^\/?]+)([^?]*)/i), path = m[2] || '/';
  path = path.replace(/\/(?:(?:quyen|quyển|tap|tập)[-_\s]*0*\d+[-_\s]*)?(?:chuong|chương|chapter|chap)[-_]?[^\/]*\/?$/i, '/');
  if (path.slice(-1) !== '/' && !/\.\w{2,5}$/.test(path)) path += '/';
  return m[1] + path;
}


function decode_(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(+d); }).replace(/&amp;/g, '&');
}


function txt_(h) { return decode_(h.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }


function normName_(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
}


function startsFormula_(s) { return /^[=+\-@]/.test(String(s == null ? '' : s)); }


function assertNoFormula_(s, label) {
  if (startsFormula_(s)) throw mk_('INVALID_INPUT', label + ' không được bắt đầu bằng ký tự = + - hoặc @.');
}


function cleanName_(n) { return String(n || '').replace(/[\\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120); }

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

var ADAPTERS = {
  generic: { content: ['chapter-c', 'chapter-content', 'chapter-content-detail', 'content'], title: ['chapter-title', 'chapter-name'] }
};

var RULE_NAME_ = /^[A-Za-z0-9_-]{1,60}$/, RULE_LINK_ = /^[A-Za-z0-9_\-\/.]{1,40}$/, RULES_MAX_ = 2000;

function siteRule_(url, cfg) {
  var host = hostOf_(url), out = { content: [], title: [], link: '' };
  String((cfg && cfg.SITE_RULES) || '').slice(0, RULES_MAX_).split(/[|\n]+/).forEach(function (line) {
    var p = line.indexOf(':');
    if (p < 0) return;
    var domain = line.slice(0, p).trim().toLowerCase().replace(/^www\./, '');
    if (!domain || !matchesDomain(host, domain)) return;
    line.slice(p + 1).split(';').forEach(function (kv) {
      var q = kv.indexOf('=');
      if (q < 0) return;
      var k = kv.slice(0, q).trim().toLowerCase(), v = kv.slice(q + 1).trim();
      if (k === 'content' || k === 'title') v.split(',').forEach(function (n) { n = n.trim(); if (RULE_NAME_.test(n) && out[k].indexOf(n) < 0) out[k].push(n); });
      else if (k === 'link' && RULE_LINK_.test(v)) out.link = v;
    });
  });
  return out;
}

function adapter_(url, cfg) {
  var h = hostOf_(url), base = ADAPTERS.generic, r = siteRule_(url, cfg);
  for (var k in ADAPTERS) if (k !== 'generic' && matchesDomain(h, k)) base = ADAPTERS[k];
  return { content: r.content.concat(base.content), title: r.title.concat(base.title), link: r.link };
}

function block_(html, names) {
  for (var k = 0; k < names.length; k++) {
    var re = new RegExp('<(div|article|section|h[1-4]|a|span|p)\\b[^>]*(?:class|id)=["\'](?:[^"\']*\\s)?' + names[k] + '(?:\\s[^"\']*)?["\'][^>]*>', 'i'), m = re.exec(html);
    if (!m) continue;
    var tag = m[1].toLowerCase(), start = m.index + m[0].length, depth = 1, tr = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi'), t;
    tr.lastIndex = start;
    while ((t = tr.exec(html))) { depth += t[1] ? -1 : 1; if (depth === 0) return html.slice(start, t.index); }
    return html.slice(start);
  }
  return null;
}


function clean_(h) {
  h = h.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|noscript|nav|footer|form|ins|button)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<div[^>]*(?:class|id)=["'][^"']*\b(?:ads?|adsbygoogle|banner|share|comments?|menu|related|recommend\w*|similar|rating|rate|sidebar|breadcrumbs?|pagination|widget|social)\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<(ul|ol)\b[^>]*>[\s\S]*?<\/\1>/gi, function (blk) {
      var links = blk.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [], lt = links.join('').replace(/<[^>]+>/g, '').length, tt = blk.replace(/<[^>]+>/g, '').length;
      return links.length >= 3 && tt > 0 && lt / tt > 0.6 ? '' : blk;
    })
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li)>/gi, '\n\n').replace(/<[^>]+>/g, '');
  return decode_(h).replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}


function autoBlock_(html) {
  var src = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|iframe|svg|form|nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, '');
  var re = /<(\/?)(div|article|section|main|a)\b[^>]*>|([^<]+)/gi, m, stack = [{ tag: '#', nl: 0, ln: 0, start: 0 }], linkDepth = 0, cands = [];
  while ((m = re.exec(src))) {
    var top = stack[stack.length - 1];
    if (m[3] !== undefined) {
      var len = m[3].replace(/\s+/g, ' ').trim().length;
      if (len) { if (linkDepth > 0) top.ln += len; else top.nl += len; }
      continue;
    }
    var close = m[1] === '/', tag = m[2].toLowerCase();
    if (tag === 'a') { linkDepth = Math.max(0, linkDepth + (close ? -1 : 1)); continue; }
    if (!close) { stack.push({ tag: tag, nl: 0, ln: 0, start: m.index + m[0].length }); continue; }
    var i = stack.length - 1;
    while (i > 0 && stack[i].tag !== tag) i--;
    if (i <= 0) continue;
    while (stack.length - 1 > i) { var lost = stack.pop(); stack[stack.length - 1].nl += lost.nl; stack[stack.length - 1].ln += lost.ln; }
    var el = stack.pop();
    el.end = m.index;
    stack[stack.length - 1].nl += el.nl; stack[stack.length - 1].ln += el.ln;
    cands.push(el);
  }
  var best = null;
  function good(c) { return c.nl >= 300 && c.ln <= 0.25 * (c.nl + c.ln); }
  cands.forEach(function (c) { if (!good(c)) return; c.score = c.nl - 2 * c.ln; if (!best || c.score > best.score) best = c; });
  if (!best) return null;
  var pick = best;
  cands.forEach(function (c) { if (good(c) && c.score >= 0.85 * best.score && c.nl + c.ln < pick.nl + pick.ln) pick = c; });
  return src.slice(pick.start, pick.end);
}


function bookName_(html, host) {
  var n = null, ld = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi, m;
  while (!n && (m = ld.exec(html))) {
    try {
      var j = JSON.parse(m[1]);
      [].concat(j, j['@graph'] || []).forEach(function (o) {
        if (!n && o && o.name && /Book|Article|CreativeWork|Series/i.test([].concat(o['@type'] || []).join(','))) n = o.name;
      });
    } catch (e) { }
  }
  var h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i), og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i), ti = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  n = n || (h1 && txt_(h1[1])) || (og && decode_(og[1])) || (ti && txt_(ti[1]));
  if (!n) throw mk_('PARSER_ERROR', 'Không nhận diện được tên truyện.');
  var base = host.split('.')[0].toLowerCase();
  var parts = decode_(n).split(/\s+[-–—|]\s+/).filter(function (p) {
    return !/^(chương|chuong|chapter|chap)\b/i.test(p) && !/^(truyện\s*)?full$/i.test(p.trim()) && p.toLowerCase().indexOf(base) < 0;
  });
  return cleanName_((parts[0] || n).replace(/\b(chương|chuong|chapter|chap)\s*\d+/ig, ''));
}


function authorName_(html) {
  var a = '', ld = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi, m;
  while (!a && (m = ld.exec(html))) {
    try {
      var j = JSON.parse(m[1]);
      [].concat(j, j['@graph'] || []).forEach(function (o) {
        if (a || !o || !o.author) return;
        var x = [].concat(o.author)[0];
        a = typeof x === 'string' ? x : (x && x.name) || '';
      });
    } catch (e) { }
  }
  if (!a && (m = html.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)/i))) a = decode_(m[1]);
  if (!a && (m = html.match(/<[^>]+itemprop=["']author["'][^>]*>([\s\S]*?)<\/(?:a|span|div|p)>/i))) a = txt_(m[1]);
  if (!a) { var b = block_(html, ['author', 'tac-gia']); if (b) a = txt_(b); }
  return String(a).replace(/^\s*(tác giả|tac gia|author)\s*[:：-]?\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 100);
}


function genreNames_(html) {
  var g = [], m;
  function add(x) { x = String(x || '').replace(/^\s*(thể loại|the loai|genre)\s*[:：-]?\s*/i, '').trim(); if (x && g.indexOf(x) < 0) g.push(x); }
  var ld = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = ld.exec(html))) {
    try {
      var j = JSON.parse(m[1]);
      [].concat(j, j['@graph'] || []).forEach(function (o) { if (o && o.genre) [].concat(o.genre).forEach(add); });
    } catch (e) { }
  }
  if (!g.length) {
    var re = /<[^>]+itemprop=["']genre["'][^>]*>([\s\S]*?)<\/(?:a|span|div|p)>/gi;
    while ((m = re.exec(html))) add(txt_(m[1]));
  }
  if (!g.length) { var b = block_(html, ['genre', 'the-loai']); if (b) { var as = b.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi); if (as) as.forEach(function (x) { add(txt_(x)); }); else add(txt_(b)); } }
  return g.slice(0, 6).join(', ').slice(0, 100);
}

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
  var rows = parse(text, {relax_column_count:true, skip_empty_lines:true}) || [], start = 0, map = {};
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


function parseFolderFileName_(name) {
  var base = String(name || '').replace(/\.[a-z0-9]{1,10}$/i, '').trim();
  var m = FOLDER_CH_HEAD_.exec(base);
  if (m) return { num: parseInt(m[2], 10), title: (m[3] || '').trim(), label: /^h(ồi|oi)$/i.test(m[1]) ? 'Hồi' : 'Chương' };
  m = FOLDER_NUM_HEAD_.exec(base);
  if (m) return { num: parseInt(m[1], 10), title: (m[2] || '').trim(), label: 'Chương' };
  return null;
}


function hasPager_(html) { return /(?:class|id)=["'][^"']*(pagination|paging|pager)/i.test(html); }


function pageNum_(u) { var m = u.match(/[?&]page=(\d+)/i) || u.match(/\/(?:page|trang)[\/-](\d+)/i); return m ? +m[1] : 1; }


function pageBase_(u) { return u.replace(/[?&]page=\d+/i, '').replace(/\/(?:page|trang)[\/-]\d+\/?/i, '/'); }


function nextPage_(html, cur) {
  var tags = html.match(/<(?:a|link)\b[^>]*>/gi) || [], i, m;
  for (i = 0; i < tags.length; i++) if (/rel=["'][^"']*\bnext\b/i.test(tags[i]) && (m = tags[i].match(/href=["']([^"']+)["']/i))) return abs_(m[1], cur);
  var want = pageNum_(cur) + 1, base = pageBase_(cur), re = /<a\b[^>]*href=["']([^"']+)["']/gi;
  while ((m = re.exec(html))) { var u = abs_(m[1], cur); if (pageNum_(u) === want && pageBase_(u) === base) return u; }
  return null;
}

var VOL_RE_ = /(?:quyen|quyển|tap|tập)[-_\s]*0*(\d+)[-_\s]*(?:chuong|chương|chapter|chap)[-_\s]*0*(\d+)(?:[-_]0*(\d+))?/i;


function chNum_(c, tok) {
  if (tok) {
    var ti = c.url.toLowerCase().indexOf(tok.toLowerCase());
    if (ti >= 0) { var td = c.url.slice(ti + tok.length).match(/^0*(\d+)/); if (td) return +td[1]; }
  }
  var v = c.url.match(VOL_RE_) || c.title.match(VOL_RE_);
  if (v) {
    var vol = +v[1], main = +v[2], sub = v[3] ? +v[3] : 0;
    return vol * 1000 + (sub && sub < 1000 ? main + sub / 1000 : main);
  }
  var m = c.url.match(/(?:chuong|chapter|chap)[-_\s]*0*(\d+)(?:[-_]0*(\d+))?/i) || c.title.match(/(?:chương|chuong|chapter|chap)\s*0*(\d+)(?:[-_.]\s*0*(\d+))?/i);
  if (!m) return null;
  var main2 = +m[1], sub2 = m[2] ? +m[2] : 0;
  return sub2 && sub2 < 1000 ? main2 + sub2 / 1000 : main2;
}


function volInfo_(c) {
  var v = c.url.match(VOL_RE_) || c.title.match(VOL_RE_);
  if (!v) return null;
  var sub = v[3] ? +v[3] : 0;
  return { vol: 'Quyển ' + (+v[1]), dnum: sub && sub < 1000 ? (+v[2]) + '-' + sub : +v[2] };
}


function chapterUrlTemplate_(chs) {
  var sample = chs.reduce(function (a, b) { return a.n <= b.n ? a : b; });
  var m = sample.url.match(/(chuong|chapter|chap)[-_\s]*0*(\d+)/i);
  if (!m) return null;
  var idx = sample.url.indexOf(m[0]), head = sample.url.slice(0, idx) + m[0].slice(0, m[0].length - m[2].length);
  var rest = sample.url.slice(idx + m[0].length);
  return function (n) { return head + n + rest; };
}


function fillSequentialGap_(chs, notes) {
  notes = notes || [];
  var maxN = chs.reduce(function (m, c) { return Math.max(m, c.n); }, 0);
  if (maxN <= chs.length || maxN > 20000) return chs;
  var seen = chs.length, gap = Math.floor(maxN) - seen;
  var tpl = chapterUrlTemplate_(chs);
  if (!tpl) { notes.push('Mục lục chỉ thấy ' + seen + '/' + Math.floor(maxN) + ' chương và không suy ra được mẫu URL để bổ sung; chương thiếu không được thêm.'); return chs; }
  var whole0 = chs.filter(function (c) { return c.n === Math.floor(c.n); }), step = Math.max(1, Math.floor(whole0.length / 5)), probes = [];
  for (var pi = 0; pi < whole0.length && probes.length < 5; pi += step) probes.push(whole0[pi]);
  var bad = probes.filter(function (c) { return tpl(c.n) !== c.url; });
  if (bad.length) { notes.push('Mục lục chỉ thấy ' + seen + '/' + Math.floor(maxN) + ' chương và URL các chương không theo một mẫu chung (ví dụ ' + bad[0].url + '); chương thiếu không được bổ sung. Dùng chế độ Thủ công nếu chắc chắn URL theo mẫu.'); return chs; }
  notes.push('Mục lục chỉ thấy ' + seen + '/' + Math.floor(maxN) + ' chương; đã bổ sung ' + gap + ' chương theo mẫu URL ' + tpl(1) + ' — kiểm tra lại tổng số chương trước khi tải.');
  var byN = {}; chs.forEach(function (c) { byN[c.n] = c; });
  var full = [], whole = Math.floor(maxN);
  for (var i = 1; i <= whole; i++) { full.push(byN[i] || { url: tpl(i), title: '', n: i }); delete byN[i]; }
  Object.keys(byN).forEach(function (k) { full.push(byN[k]); });
  return full.sort(function (a, b) { return a.n - b.n; });
}

var MIX_SHIFT_ = 1000000;


function mixShift_(cands) {
  var firstVol = -1, firstFlat = -1, firstN = null, lastN = null;
  cands.forEach(function (x, i) {
    if (x.vi) { if (firstVol < 0) firstVol = i; return; }
    if (firstFlat < 0) firstFlat = i;
    if (firstN === null) firstN = x.num;
    lastN = x.num;
  });
  var asc = lastN >= firstN;
  return (asc ? firstVol < firstFlat : firstVol > firstFlat) ? -MIX_SHIFT_ : MIX_SHIFT_;
}


function folderIdFrom_(s) {
  s = String(s || '').trim();
  var m = s.match(/\/folders\/([\w-]{10,})/) || s.match(/[?&]id=([\w-]{10,})/) || s.match(/^([\w-]{10,})$/);
  if (!m) throw mk_('INVALID_FOLDER', 'Không nhận diện được Folder ID. Dán ID hoặc link thư mục Google Drive.');
  return m[1];
}

function genreFolderName_(g) { return cleanName_(String(g || '').split(/[,;\/]/)[0]) || 'Chưa phân loại'; }

function padDnum_(n) {
  var m = String(n).match(/^(\d+)-(\d+)$/);
  return m ? pad_(+m[1]) + '-' + pad_(+m[2]) : pad_(n);
}


function fname_(n, title, label) {
  var t = String(title || '').replace(/^(?:(?:quyển|quyen|tập|tap)\s*\d+\s*[-–:.]?\s*)?(?:chương|chuong|chapter|chap)\s*\d+(?:-\d+)?\s*[:.\-–]?\s*/i, '');
  var nm = (label || 'Chương') + ' ' + padDnum_(n) + (t ? ' - ' + t : '');
  return nm.replace(/[\\\/]/g, ' ').replace(/[:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) + '.txt';
}

function logCell_(v) {
  return String(v == null ? '' : v).replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim();
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


function headLike_(s) { return CH_HEAD_.test(s) || /^(?:hồi|hoi)\s*\d+/i.test(s) || PREAMBLE_HEAD_.test(s); }


function stripFileHead_(t, strict, bookName) {
  var parts = t.split('\n\n');
  if (parts.length <= 2) return { headTitle: '', body: t };
  var a = parts[0].trim(), b = parts[1].trim();
  if (a.indexOf('\n') >= 0 || b.indexOf('\n') >= 0 || a.length > 200 || b.length > 300) return { headTitle: '', body: t };
  if (strict && !(normName_(a) === normName_(bookName) && headLike_(b))) return { headTitle: '', body: t };
  return { headTitle: titleOnly_(b), body: parts.slice(2).join('\n\n') };
}


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


export { mk_, pad_, hostOf_, abs_, normUrl_, decode_, txt_, normName_, startsFormula_, assertNoFormula_, cleanName_, vnOrdinalToNum_, parseHoiHead_, normKey_, isToolbar_, toolbarAhead_, splitHead_, junkRe_, stripJunk_, stripJunkInline_, tidyChapter_, titleOnly_, sig_, siteRule_, adapter_, block_, clean_, autoBlock_, bookName_, authorName_, genreNames_, splitChapters_, parseCsvChapters_, splitHoiChapters_, detectImportFormat_, parseImportFile_, cleanChapterList_, docChapterFile_, importFileName_, parseMarkedChapterHead_, parseMarkedFile_, fillMissingNums_, markKey_, mergeTocStory_, numberMarkedList_, parseFolderFileName_, hasPager_, pageNum_, pageBase_, nextPage_, chNum_, volInfo_, chapterUrlTemplate_, fillSequentialGap_, mixShift_, folderIdFrom_, genreFolderName_, padDnum_, fname_, logCell_, sameName_, leadInt_, cmpName_, cmpGroup_, dnumValue_, pickName_, pickGroup_, parseOrder_, groupLabel_, placeChapter_, headLike_, stripFileHead_, isEmptyRow_, emptyRuns_ };

function parseChapterHtml_(html, url, cfg, num) {
  var ad = adapter_(url, cfg), body = block_(html, ad.content), auto = false;
  if (!body) { body = autoBlock_(html); auto = !!body; }
  if (!body) throw mk_('NO_CONTENT', 'Không thấy nội dung chương.');
  var tp = tidyChapter_(clean_(body), cfg.JUNK_WORDS), text = tp.body;
  if (text.length < 50) throw mk_('TOO_SHORT', 'Nội dung chương quá ngắn, có thể lấy sai.');
  var tb = block_(html, ad.title), h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  var title = stripJunkInline_(tb ? txt_(tb) : (h1 ? txt_(h1[1]) : ''), cfg.JUNK_WORDS) || tp.title;
  return { title: title || 'Chương ' + num, text: text, auto: auto };
}

export { parseChapterHtml_ };

function cleanGenreList_(list) {
  var out = [], seen = {};
  (Array.isArray(list) ? list : []).forEach(function (g) {
    g = cleanName_(String(g == null ? '' : g).replace(/[,;\/]/g, ' '));
    var k = normName_(g);
    if (g && !seen[k]) { seen[k] = 1; out.push(g); }
  });
  return out;
}

export { cleanGenreList_ };

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


export { utf8Len_ };

function siteCookie_(url, cfg) {
  var host = hostOf_(url), lines = String(cfg.SITE_COOKIES || '').split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim(); if (!line) continue;
    var p = line.indexOf('='); if (p < 0) continue;
    var domain = line.slice(0, p).trim().toLowerCase().replace(/^www\./, '');
    if (domain && matchesDomain(host, domain)) return line.slice(p + 1).trim();
  }
  return '';
}


export { siteCookie_ };

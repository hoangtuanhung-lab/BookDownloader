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

function discover_(bookUrl, firstHtml, cfg) {
  var host = hostOf_(bookUrl), seen = {}, pages = {}, chs = [], url = bookUrl, html = firstHtml, n = 0, t0 = Date.now();
  var rule = siteRule_(bookUrl, cfg), tok = rule.link, notes = [];
  var prefix = bookUrl.replace(/\/$/, '');
  while (url && n < 300) {
    if (Date.now() - t0 > 300000) throw mk_('TIMEOUT', 'Quá thời gian khi lấy danh sách chương.');
    pages[url] = 1; n++;
    if (n > 1) { Utilities.sleep(cfg.DELAY_MS); html = fetch_(url, cfg); }
    var re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, m;
    while ((m = re.exec(html))) {
      var u = abs_(m[1], url).split('?')[0].replace(/\/$/, '');
      if (hostOf_(u) !== host || u.indexOf(prefix) !== 0 || seen[u]) continue;
      var rest = u.slice(prefix.length);
      if (tok ? rest.toLowerCase().indexOf(tok.toLowerCase()) < 0 : !/(?:^|[\/\-_])(?:chuong|chapter|chap)[-_]?[^\/]*/i.test(rest)) continue;
      seen[u] = 1; chs.push({ url: u, title: txt_(m[2]) });
    }
    var next = nextPage_(html, url);
    if (!next && n === 1 && hasPager_(html)) throw mk_('PARSER_ERROR', 'Có phân trang nhưng không xác định được trang kế tiếp. Nhờ hỗ trợ thêm hoặc dùng chế độ Thủ công.');
    url = next && !pages[next] ? next : null;
  }
  if (!chs.length) throw mk_('PARSER_ERROR', 'Không tìm thấy link chương. Thêm quy tắc cho website này ở Cài đặt → SITE_RULES (ví dụ: link=/c-).');
  var cands = [], noNum = 0;
  chs.forEach(function (c) {
    var num = chNum_(c, tok);
    if (num === null) { noNum++; return; }
    cands.push({ c: c, num: num, vi: volInfo_(c) });
  });
  var mixed = cands.some(function (x) { return x.vi; }) && cands.some(function (x) { return !x.vi; }), shift = mixed ? mixShift_(cands) : 0;
  var used = {}, ok = [], dupes = [];
  cands.forEach(function (x) {
    var key = (mixed && x.vi ? 'V' : '') + x.num;
    if (used[key]) { dupes.push(x.c.title || x.c.url); return; }
    used[key] = 1;
    x.c.n = mixed && x.vi ? x.num + shift : x.num;
    x.c.vol = x.vi ? x.vi.vol : ''; x.c.dnum = x.vi ? x.vi.dnum : '';
    ok.push(x.c);
  });
  if (!ok.length) throw mk_('PARSER_ERROR', 'Không xác định được số chương cho bất kỳ link nào tìm thấy. Thêm quy tắc link=... cho website này ở Cài đặt → SITE_RULES.');
  ok.sort(function (a, b) { return a.n - b.n; });
  if (dupes.length) notes.push('Bỏ ' + dupes.length + ' link có số chương trùng (' + dupes.slice(0, 3).join('; ') + (dupes.length > 3 ? '…' : '') + ').');
  if (noNum) notes.push('Bỏ ' + noNum + ' link chương không xác định được số chương.');
  if (mixed) notes.push('Truyện trộn hai kiểu link (Quyển/Chương và Chương liền số): ' + ok.filter(function (c) { return c.vol; }).length + ' chương theo Quyển được xếp ' + (shift < 0 ? 'trước' : 'sau') + ' các chương liền số.');
  var result = ok.some(function (c) { return VOL_RE_.test(c.url) || VOL_RE_.test(c.title); }) ? ok : fillSequentialGap_(ok, notes);
  result.notes = notes;
  return result;
}

function chaptersOf_(id) {
  return bookRows_(id).rows.map(function (r) { return [r[1], r[2], r[4], r[6], r[7], r[3], String(r[9] || ''), String(r[10] || ''), String(r[11] === undefined ? '' : r[11])]; });
}
function errorRows_(id) {
  return bookRows_(id).rows.filter(function (r) { return r[4] === 'ERROR'; }).map(function (r) { return [r[1], r[2], r[6], r[7], r[3], String(r[11] === undefined ? '' : r[11])]; });
}

function activeRows_(id, limit) {
  var rows = bookRows_(id).rows, out = [];
  for (var i = 0; i < rows.length && out.length < limit; i++) {
    var r = rows[i];
    if (r[4] === 'DONE') continue;
    out.push([r[1], r[2], r[3], r[4], r[7], r[11] === undefined ? '' : r[11]]);
  }
  return out;
}

function firstChapterUrls_(ids) {
  var want = {}; ids.forEach(function (id) { want[id] = 1; });
  var s = db_().getSheetByName('CHAPTERS'), n = s.getLastRow(), out = {}, best = {};
  if (n < 2) return out;
  s.getRange(2, 1, n - 1, 9).getValues().forEach(function (r) {
    if (!want[r[0]]) return;
    if (!(r[0] in best) || +r[1] < best[r[0]]) { best[r[0]] = +r[1]; out[r[0]] = r[3]; }
  });
  return out;
}
function resetErrorRows_(rows) {
  rows.forEach(function (r) { if (r[4] === 'ERROR') { r[4] = 'PENDING'; r[6] = 0; r[7] = ''; } });
}
function markMissing_(rows, ids) {
  rows.forEach(function (r) { if (r[4] === 'DONE' && !ids[r[5]]) { r[4] = 'PENDING'; r[5] = ''; r[8] = stamp_(); } });
}

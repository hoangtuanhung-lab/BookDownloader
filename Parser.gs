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

function getChapter_(url, cfg, num) {
  var html = fetch_(url, cfg), ad = adapter_(url, cfg), body = block_(html, ad.content), auto = false;
  if (!body) { body = autoBlock_(html); auto = !!body; }
  if (!body) throw mk_('NO_CONTENT', 'Không thấy nội dung chương.');
  var tp = tidyChapter_(clean_(body), cfg.JUNK_WORDS), text = tp.body;
  if (text.length < 50) throw mk_('TOO_SHORT', 'Nội dung chương quá ngắn, có thể lấy sai.');
  var tb = block_(html, ad.title), h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  var title = stripJunkInline_(tb ? txt_(tb) : (h1 ? txt_(h1[1]) : ''), cfg.JUNK_WORDS) || tp.title;
  return { title: title || 'Chương ' + num, text: text, auto: auto };
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

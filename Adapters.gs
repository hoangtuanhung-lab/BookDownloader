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
    if (!domain || host.indexOf(domain) < 0) return;
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
  for (var k in ADAPTERS) if (k !== 'generic' && h.indexOf(k) >= 0) base = ADAPTERS[k];
  return { content: r.content.concat(base.content), title: r.title.concat(base.title), link: r.link };
}

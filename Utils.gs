function mk_(type, msg) { var e = new Error(msg); e.type = type; return e; }

function stamp_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss'); }

function pad_(n) { return ('000' + n).slice(-Math.max(3, String(n).length)); }

function hostOf_(u) { var m = u.match(/^https?:\/\/([^\/?#]+)/i); return m ? m[1].toLowerCase().replace(/^www\./, '') : ''; }

function safe_(fn) { try { return fn(); } catch (e) { return { error: (e.type || 'UNKNOWN_ERROR') + ': ' + e.message }; } }

function withLock_(fn) {
  var l = LockService.getScriptLock();
  if (!l.tryLock(3000)) return { busy: true, state: getState_() };
  try { return fn(); } finally { l.releaseLock(); }
}

function tryStartTick_() {
  var c = CacheService.getScriptCache();
  if (c.get('TICKING')) return false;
  c.put('TICKING', '1', 330);
  return true;
}
function endTick_() { CacheService.getScriptCache().remove('TICKING'); }

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

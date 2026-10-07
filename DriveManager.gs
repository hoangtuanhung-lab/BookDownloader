function folderIdFrom_(s) {
  s = String(s || '').trim();
  var m = s.match(/\/folders\/([\w-]{10,})/) || s.match(/[?&]id=([\w-]{10,})/) || s.match(/^([\w-]{10,})$/);
  if (!m) throw mk_('INVALID_FOLDER', 'Không nhận diện được Folder ID. Dán ID hoặc link thư mục Google Drive.');
  return m[1];
}
function rootFolder_(cfg) {
  if (cfg.ROOT_FOLDER_ID) {
    try { var f = DriveApp.getFolderById(cfg.ROOT_FOLDER_ID); if (!f.isTrashed()) return f; } catch (e) { }
    throw mk_('DRIVE_ERROR', 'Không truy cập được thư mục gốc đã đăng ký (ID ' + cfg.ROOT_FOLDER_ID + '). Đăng ký lại trong Cài đặt.');
  }
  var it = DriveApp.searchFolders(driveQuery_('title', '=', cfg.ROOT_FOLDER)), root = it.hasNext() ? it.next() : DriveApp.createFolder(cfg.ROOT_FOLDER);
  writeConfig_({ ROOT_FOLDER_ID: root.getId(), ROOT_FOLDER: root.getName() });
  return root;
}
var FLD_MEMO_ = {};
function driveQuery_(field, op, text) {
  return field + ' ' + op + " '" + String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "' and trashed = false";
}
function hashHex_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(text), Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}
function folderUnder_(id, parentId, name) {
  try {
    var f = DriveApp.getFolderById(id);
    if (f.isTrashed() || f.getName() !== name) return null;
    var ps = f.getParents();
    while (ps.hasNext()) if (ps.next().getId() === parentId) return f;
  } catch (e) { }
  return null;
}
function childFolder_(parent, name) {
  var pid = parent.getId(), memoKey = pid + '|' + name;
  if (FLD_MEMO_[memoKey]) return FLD_MEMO_[memoKey];
  var props = PropertiesService.getScriptProperties(), propKey = 'FLD_' + pid + '_' + hashHex_(name);
  var saved = props.getProperty(propKey), f = saved ? folderUnder_(saved, pid, name) : null;
  if (!f) {
    var it = parent.searchFolders(driveQuery_('title', '=', name));
    f = it.hasNext() ? it.next() : parent.createFolder(name);
    props.setProperty(propKey, f.getId());
  }
  FLD_MEMO_[memoKey] = f;
  return f;
}
function genreFolderName_(g) { return cleanName_(String(g || '').split(/[,;\/]/)[0]) || 'Chưa phân loại'; }
function bookFolder_(name, genre, cfg) { return childFolder_(childFolder_(rootFolder_(cfg), genreFolderName_(genre)), name); }
function moveToGenre_(folder, oldGenre, newGenre) {
  var pit = folder.getParents(); if (!pit.hasNext()) return;
  var p = pit.next(), root = p;
  if (p.getName() === genreFolderName_(oldGenre) && p.getParents().hasNext()) root = p.getParents().next();
  var gf = childFolder_(root, genreFolderName_(newGenre));
  if (gf.getId() !== p.getId()) folder.moveTo(gf);
}
function registerRoot_(input) {
  var id = folderIdFrom_(input), f;
  try { f = DriveApp.getFolderById(id); } catch (e) { throw mk_('DRIVE_ERROR', 'Không truy cập được thư mục này. Kiểm tra ID và quyền chia sẻ.'); }
  if (f.isTrashed()) throw mk_('DRIVE_ERROR', 'Thư mục này đang nằm trong thùng rác.');
  try {
    var pm = f.getAccess(Session.getEffectiveUser()), P = DriveApp.Permission;
    if ([P.OWNER, P.EDIT, P.ORGANIZER, P.FILE_ORGANIZER].indexOf(pm) < 0) throw mk_('DRIVE_ERROR', 'Bạn chỉ có quyền xem/bình luận thư mục này; cần quyền Chỉnh sửa (Editor).');
  } catch (e) { if (e.type === 'DRIVE_ERROR') throw e; }
  writeConfig_({ ROOT_FOLDER_ID: id, ROOT_FOLDER: f.getName() });
  return f.getName();
}
function createRoot_(name) {
  var nm = cleanName_(name);
  if (!nm) throw mk_('INVALID_FOLDER', 'Nhập tên thư mục cần tạo.');
  var f = DriveApp.createFolder(nm);
  writeConfig_({ ROOT_FOLDER_ID: f.getId(), ROOT_FOLDER: nm });
  return f.getName();
}
function fileOk_(id) { try { return !!id && !DriveApp.getFileById(id).isTrashed(); } catch (e) { return false; } }

function padDnum_(n) {
  var m = String(n).match(/^(\d+)-(\d+)$/);
  return m ? pad_(+m[1]) + '-' + pad_(+m[2]) : pad_(n);
}

function findByNum_(folder, n, label) {
  var p = (label || 'Chương') + ' ' + padDnum_(n), it = folder.searchFiles(driveQuery_('title', 'contains', p));
  while (it.hasNext()) { var f = it.next(), nm = f.getName(); if (nm === p + '.txt' || nm.indexOf(p + ' ') === 0) return f; }
  return null;
}

function chapterFolder_(bookFolder, part, vol) {
  var f = bookFolder, p = cleanName_(part), v = cleanName_(vol);
  if (p) f = childFolder_(f, p);
  if (v) f = childFolder_(f, v);
  return f;
}
function allFileIds_(folder, ids) {
  ids = ids || {};
  var it = folder.getFiles(); while (it.hasNext()) ids[it.next().getId()] = 1;
  var fi = folder.getFolders(); while (fi.hasNext()) allFileIds_(fi.next(), ids);
  return ids;
}

function fname_(n, title, label) {
  var t = String(title || '').replace(/^(?:(?:quyển|quyen|tập|tap)\s*\d+\s*[-–:.]?\s*)?(?:chương|chuong|chapter|chap)\s*\d+(?:-\d+)?\s*[:.\-–]?\s*/i, '');
  var nm = (label || 'Chương') + ' ' + padDnum_(n) + (t ? ' - ' + t : '');
  return nm.replace(/[\\\/]/g, ' ').replace(/[:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) + '.txt';
}

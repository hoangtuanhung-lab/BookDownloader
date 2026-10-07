// V1.59.2 — cập nhật lần cuối: 08/10/2026
var VERSION = '1.59.2', UPDATED = '08/10/2026';

function doGet() {
  var out = HtmlService.createTemplateFromFile('Index').evaluate().setTitle('Trình tải truyện')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  var favUrl = faviconUrl_();
  if (favUrl) out.setFaviconUrl(favUrl);
  return out;
}
function include(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }

function api_getState() { return safe_(getState_); }

function api_createAndStart(info) {
  return safe_(function () { return withLock_(function () { return createBook_(info); }); });
}

function api_queueAnalyze(urls) {
  return safe_(function () { return withLock_(function () { return queueAnalyze_(urls); }); });
}

function api_dropPending(url) {
  return safe_(function () { dropPending_(String(url || '')); return { state: getState_() }; });
}
function api_analyzeAndHold(url) { return safe_(function () { return analyzeAndHold_(url); }); }

function api_retryAnalyze(url) {
  return safe_(function () { return withLock_(function () { return retryAnalyze_(url); }); });
}

function api_addChapter(id, kind, f) {
  return safe_(function () { return withLock_(function () { return addChapterManual_(id, kind, f); }); });
}

function api_chapterGroups(id) { return safe_(function () { return chapterGroups_(id); }); }

function api_moveToDownload(ids) {
  return safe_(function () { return withLock_(function () { return moveAnalyzed_(ids); }); });
}

function api_manualAnalyze(sampleUrl, total) {
  return safe_(function () {
    var r = manualAnalyze_(sampleUrl, total);
    if (!r.existing) return r;
    if (!r.newChapters || !r.newChapters.length) return { existing: r.existing, added: 0, state: r.state };
    var out = withLock_(function () { return addMissingChapters_(r.existing, r.newChapters); });
    if (out && out.busy) return { busy: true };
    return { existing: r.existing, added: out.added, state: out.state };
  });
}

function api_tick() {
  return safe_(function () { drive_(30000); return { state: getState_() }; });
}

function api_setStatus(id, action) {
  return safe_(function () { return withLock_(function () { setBookStatus_(id, action); return { state: getState_() }; }); });
}

function api_chapters(id) { return safe_(function () { return { rows: chaptersOf_(id) }; }); }

function api_errorChapters(id) { return safe_(function () { return { rows: errorRows_(id) }; }); }

function api_chapterAction(id, num, action) {
  return safe_(function () {
    return withLock_(function () {
      if (action === 'retry') retryChapterRow_(id, num);
      else if (action === 'cancel') cancelChapterRow_(id, num);
      else if (action === 'pause') pauseChapterRow_(id, num);
      else if (action === 'delete') deleteChapterRow_(id, num);
      return { state: getState_() };
    });
  });
}

function api_editChapter(id, num, url, title) {
  return safe_(function () { return withLock_(function () { editChapterRow_(id, num, url, title); return { state: getState_() }; }); });
}

function api_firstChapterUrls(ids) { return safe_(function () { return firstChapterUrls_(ids); }); }

function api_addBookFromFile(filename, base64, meta) { return safe_(function () { return createBookFromFile_(filename, base64, meta); }); }
function api_addBookFromFiles(tocName, tocB64, fileName, fileB64, meta) { return safe_(function () { return createBookFromFiles_(tocName, tocB64, fileName, fileB64, meta); }); }

function api_addBookFromFolder(folderInput, meta) { return safe_(function () { return createBookFromFolder_(folderInput, meta); }); }

function api_saveBook(id, f) {
  return safe_(function () { return withLock_(function () { updateBookInfo_(id, f); return { state: getState_() }; }); });
}

function api_setGenreMany(ids, genre) {
  return safe_(function () { return withLock_(function () { return setGenreMany_(ids, genre); }); });
}

function api_saveBooksBatch(items) {
  return safe_(function () {
    return withLock_(function () {
      var errors = {};
      (items || []).forEach(function (it) {
        try { updateBookInfo_(it.id, { name: it.name, author: it.author, genre: it.genre }); }
        catch (e) { errors[it.id] = (e.type || 'UNKNOWN_ERROR') + ': ' + e.message; }
      });
      return { state: getState_(), errors: errors };
    });
  });
}

function api_deleteBook(id, trashFolder) {
  return safe_(function () { return withLock_(function () { deleteBook_(id, !!trashFolder); return { state: getState_() }; }); });
}

function api_reorderQueue(id, dir) {
  return safe_(function () { return withLock_(function () { reorderQueue_(id, dir); return { state: getState_() }; }); });
}

function api_saveConfig(cfg) {
  return safe_(function () { return withLock_(function () { saveConfig_(cfg); return { state: getState_() }; }); });
}

function api_saveGenres(list) {
  return safe_(function () { return withLock_(function () { saveGenres_(list); return { state: getState_() }; }); });
}

function api_readerList(id) { return safe_(function () { return readerList_(id); }); }
function api_readChapter(bookId, fileId) {
  return safe_(function () { return fileId === undefined ? readChapterFile_('', bookId) : readChapterFile_(bookId, fileId); });
}
function api_readChapterCluster(bookId, fileIds) {
  return safe_(function () { return { rows: readChapterCluster_(bookId, fileIds) }; });
}

function api_saveReadingProgress(bookId, chapterId, y, ratio, t) {
  return safe_(function () { return saveReadingProgress_(bookId, chapterId, y, ratio, t); });
}
function api_getReadingProgress(bookId) {
  return safe_(function () { return getReadingProgress_(bookId); });
}

function api_registerRoot(input) {
  return safe_(function () { return withLock_(function () { var n = registerRoot_(input); return { state: getState_(), name: n }; }); });
}
function api_createRoot(name) {
  return safe_(function () { return withLock_(function () { var n = createRoot_(name); return { state: getState_(), name: n }; }); });
}

/** Copy into a temporary file in the EXISTING Apps Script project.
 * Does not call db_()/getConfig_(): those legacy helpers can create/repair data.
 * Returns JSON to the caller; no writes, no Drive files, no credentials in output.
 */
function exportLegacyReadOnly(spreadsheetId) {
  var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  function rows(name, columns) {
    var sheet = spreadsheet.getSheetByName(name);
    if (!sheet) throw new Error('Missing sheet: ' + name);
    var count = sheet.getLastRow() - 1;
    return count > 0 ? sheet.getRange(2, 1, count, columns).getValues() : [];
  }
  var config = rows('CONFIG',2).filter(function(r) { return ['ROOT_FOLDER','ROOT_FOLDER_ID','BATCH_SIZE','DELAY_MS','MAX_RETRY','MAX_CONCURRENT','FILE_TYPE','ENCODING','AUTO_RESUME','JUNK_WORDS','SITE_RULES','GENRES'].indexOf(String(r[0])) >= 0; });
  var original = PropertiesService.getScriptProperties().getProperties(), safe = {};
  Object.keys(original).forEach(function(key) {
    if (key === 'ROOT_FOLDER_ID' || key === 'ROOT_FOLDER' || /^(FLD_|DEL_)/.test(key)) safe[key] = original[key];
  });
  return JSON.stringify({schemaVersion:1, BOOKS:rows('BOOKS',13), CHAPTERS:rows('CHAPTERS',12), CONFIG:config, properties:safe, files:[], inventoryComplete:false});
}

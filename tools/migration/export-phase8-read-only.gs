/** Temporary helper only; run explicitly as the library owner after legacy worker freeze.
 * Does not modify the 29 baseline files, invoke repair helpers, log secrets or create files.
 * Separate public metadata from private review state. Cookies/credentials are NOT exported.
 */
function exportPhase8ReadOnly(spreadsheetId) {
  var metadata=JSON.parse(exportLegacyReadOnly(spreadsheetId));
  var props=PropertiesService.getScriptProperties().getProperties(), state={};
  Object.keys(props).forEach(function(key){
    if(key==='DB_ID'||key==='ANA_QUEUE'||/^(FLD_|IMP_|DEL_)/.test(key))state[key]=props[key];
  });
  var sheet=SpreadsheetApp.openById(spreadsheetId).getSheetByName('LOG');
  var log=sheet&&sheet.getLastRow()>1?sheet.getRange(2,1,sheet.getLastRow()-1,sheet.getLastColumn()).getValues():[];
  var progress={},user=PropertiesService.getUserProperties().getProperties();
  Object.keys(user).forEach(function(key){if(/^RP_[\w-]{1,100}$/.test(key))progress[key]=user[key];});
  return JSON.stringify({metadata:metadata,privateReview:{scriptState:state,LOG:log,userProgress:progress,
    executingUserEmail:Session.getActiveUser().getEmail(),
    secretTransfer:'Configure credentials separately on server; do not copy cookies into general exports',
    warning:'UserProperties belong to execution identity; confirm owner before importing. LOG and queue errors may contain private text.'}});
}

function writeLogs_(logs) {
  if (!logs.length) return;
  var s = db_().getSheetByName('LOG');
  s.getRange(s.getLastRow() + 1, 1, logs.length, 6).setValues(logs);
}

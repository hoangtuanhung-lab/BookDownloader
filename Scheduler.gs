function autoTick() {
  drive_(270000);
}

function ensureTrigger_() {
  if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'autoTick'; }))
    ScriptApp.newTrigger('autoTick').timeBased().everyMinutes(1).create();
}

function removeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'autoTick') ScriptApp.deleteTrigger(t); });
}

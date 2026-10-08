/* Paste into DevTools in the OLD Apps Script reader frame, under the correct account.
 * Downloads a local file after explicit invocation. No network, no storage mutation.
 * This archive does NOT prove ownership. The operator must verify account and origin.
 */
(() => {
  const properties={};
  for(let i=0;i<localStorage.length;i++){
    const key=localStorage.key(i);
    if(/^rdPos_[\w-]{1,100}$/.test(key))properties[key]=localStorage.getItem(key);
  }
  const url=URL.createObjectURL(new Blob([JSON.stringify({schemaVersion:1,origin:location.origin,properties,ownerBindingRequired:true},null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='legacy-reader-progress-private.json';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
})();

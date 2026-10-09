// Allowlisted diagnostic fields only; no tokens, URLs, bodies, headers or raw errors.
export function safeLog(event:'health_unavailable'|'worker_ready'|'worker_kick_unavailable', correlationId:string):void {
 console.log(JSON.stringify({event,correlationId}));
}

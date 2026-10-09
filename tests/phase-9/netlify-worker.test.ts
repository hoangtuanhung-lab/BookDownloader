import test from "node:test";
import assert from "node:assert/strict";
import { kickWorker, workerStatus, runNetlifyWorker } from "../../packages/infrastructure/src/netlify-worker";
import { handleWorker } from "../../netlify/functions/library-worker-background";
import { handleApi } from "../../netlify/functions/api";
const env = { NETLIFY_WORKER_ENABLED:"true", DATABASE_URL:"postgresql://fixture", DRIVE_ROOT_ID:"rootfixture", DRIVE_CLIENT_ID:"client", DRIVE_CLIENT_SECRET:"drive-secret-sentinel", DRIVE_REFRESH_TOKEN:"token", DRIVE_OWNER_SUBJECT:"google-sub", SUPABASE_SERVICE_ROLE_KEY:"server-secret-sentinel", URL:"https://book.test", APP_ORIGINS:"https://book.test" };
const id="00000000-0000-4000-8000-000000000001";
function services(permissions=["download"]) {
 const operations:string[]=[];
 return { operations, async verify(){return {id,email:"fixture@gmail.com",email_confirmed_at:"2026-10-09",app_metadata:{provider:"google"}};}, async rpc(name:string,args:any){ if(name==="app_me") return {id,name:"Fixture",permissions}; operations.push(args.operation); return [{id,url:"https://source.test/book/"}]; } };
}
const request=(path:string,method="GET",value?:unknown)=>new Request("https://book.test/api/"+path,{method,headers:{Authorization:"Bearer fixture",Origin:"https://book.test","Content-Type":"application/json"},...(value?{body:JSON.stringify(value)}:{})});
test("worker status exposes labels only and rejects incomplete or disabled configuration",async()=>{
 assert(workerStatus(env).configured);
 const status=workerStatus({...env,DATABASE_URL:"",DRIVE_REFRESH_TOKEN:""});
 assert(!status.configured);assert.equal(status.missing.length,2);assert(!JSON.stringify(status).includes("sentinel"));
 await assert.rejects(kickWorker({...env,NETLIFY_WORKER_ENABLED:"false"}),{code:"WORKER_UNCONFIGURED"});
});
test("launcher uses fixed server URL, authenticated POST, no redirects; non-202 and network errors are sanitized",async()=>{
 let req:Request|undefined;
 await kickWorker(env,async(input:any,init:any)=>{req=new Request(input,init);assert.equal(init.redirect,"error");return new Response(null,{status:202});});
 assert.equal(req!.url,"https://book.test/.netlify/functions/library-worker-background");assert.equal(req!.method,"POST");assert.equal(req!.headers.get("authorization"),"Bearer server-secret-sentinel");
 for(const status of [200,403,500]) await assert.rejects(kickWorker(env,async()=>new Response(null,{status})),{code:"WORKER_UNAVAILABLE"});
 await assert.rejects(kickWorker(env,async()=>{throw Error("private-token");}),{message:"Chưa gọi được worker; URL vẫn được giữ trong hàng chờ"});
});
test("background entry denies public GET/POST and wrong credentials without claiming work",async()=>{
 let calls=0;const run=async()=>{calls++;return {processed:1};};
 for(const headers of [new Headers(),new Headers({Authorization:"Bearer wrong"})]) assert.equal((await handleWorker(new Request("https://book.test/worker",{method:"POST",headers}),env,run as any)).status,403);
 assert.equal((await handleWorker(new Request("https://book.test/worker",{headers:{Authorization:"Bearer "+env.SUPABASE_SERVICE_ROLE_KEY}}),env,run as any)).status,403);
 assert.equal(calls,0);
 assert.equal((await handleWorker(new Request("https://book.test/worker",{method:"POST",headers:{Authorization:"Bearer "+env.SUPABASE_SERVICE_ROLE_KEY}}),env,run as any)).status,200);assert.equal(calls,1);
});
test("enqueue commits before automatic wake; wake failure does not lose or resubmit URL",async()=>{
 const auth=services();let kicks=0;
 const response=await handleApi(request("analysis","POST",{urls:["https://source.test/book/"],mode:"auto"}),env,undefined,auth,undefined,{validateUrl:async()=>{},kickWorker:async()=>{assert.deepEqual(auth.operations,["queue"]);kicks++;throw Error("network");}});
 assert.equal(response.status,202);assert.equal(kicks,1);assert.deepEqual(auth.operations,["queue"]);
});
test("manual start retains checkpoint: calls worker without retrying job or requeueing; read-only denied",async()=>{
 let kicks=0;const auth=services();const business={validateUrl:async()=>{},kickWorker:async()=>{kicks++;}};
 assert.equal((await handleApi(request("analysis/worker","POST"),env,undefined,auth,undefined,business)).status,202);assert.equal(kicks,1);assert.deepEqual(auth.operations,[]);
 assert.equal((await handleApi(request("analysis/worker","POST"),env,undefined,services(["read"]),undefined,business)).status,403);assert.equal(kicks,1);
 const wrong=request("analysis/worker","POST");wrong.headers.set("Origin","https://other.test");assert.equal((await handleApi(wrong,env,undefined,auth,undefined,business)).status,403);
});
function dependency(options:{locked?:boolean;maintenance?:boolean;ready?:boolean;fail?:boolean}={}){
 const queries:string[]=[];let released=0,ended=0,runs=0;
 const client={async query(sql:string){queries.push(sql);return {rows:[sql.includes("pg_try")?{ok:options.locked??true}:sql.includes("schema_migrations")?{ready:options.ready??true}:{maintenance:options.maintenance??false,root_id:"dbroot"}]};},release(){released++;}};
 const deps={pool:()=>({async connect(){return client;},async end(){ended++;}}) as any,run:async(_db:any,o:any)=>{runs++;assert.equal(o.rootId,"dbroot");assert.equal(o.maxMs,45000);if(options.fail)throw Error("run failure");return {processed:1,busy:false};}};
 return {deps,queries,state:()=>({released,ended,runs})};
}
test("worker prevents concurrent runs and observes maintenance without workflow IO",async()=>{
 for(const options of [{locked:false},{maintenance:true}]){const d=dependency(options);await runNetlifyWorker(env,d.deps);assert.deepEqual(d.state(),{released:1,ended:1,runs:0});assert.equal(d.queries.some(q=>q.includes("pg_advisory_unlock")),options.locked!==false);}
});
test("worker checks ledger, uses registered root, releases session lock and connection on failure",async()=>{
 for(const options of [{},{fail:true},{ready:false}]){const d=dependency(options);if(options.fail||options.ready===false)await assert.rejects(runNetlifyWorker(env,d.deps));else assert.equal((await runNetlifyWorker(env,d.deps)).processed,1);assert.equal(d.state().released,1);assert.equal(d.state().ended,1);assert(d.queries.at(-1)?.includes("pg_advisory_unlock"));}
});

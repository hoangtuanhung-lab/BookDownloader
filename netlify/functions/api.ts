import {randomUUID} from 'node:crypto';
import {checkDatabase} from '../../packages/infrastructure/src/health';
import {safeLog} from '../../packages/infrastructure/src/logging';
export async function handleApi(request:Request,env:NodeJS.ProcessEnv=process.env,check=checkDatabase):Promise<Response> {
 const correlationId=randomUUID();
 const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Correlation-ID':correlationId,'X-Content-Type-Options':'nosniff'};
 const pathname=new URL(request.url).pathname;
 if(request.method==='GET' && (pathname==='/api/health' || pathname==='/.netlify/functions/api/health')) {
  try {await check(env);return Response.json({status:'ok',database:'ok',correlationId},{headers});}
  catch {safeLog('health_unavailable',correlationId);return Response.json({status:'unavailable',database:'unavailable',correlationId},{status:503,headers});}
 }
 return Response.json({error:'NOT_IMPLEMENTED',correlationId},{status:501,headers});
}
export default (request:Request)=>handleApi(request);
export const config={path:'/api/*'};

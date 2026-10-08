import {createServer} from 'node:http';
import {handleApi} from '../../netlify/functions/api';
const env={...process.env,APP_ENV:process.env.APP_ENV||'local',DATABASE_URL:process.env.DATABASE_URL || 'postgresql://postgres:local-only-password@127.0.0.1:55432/bookdownloader'};
createServer(async (req,res)=>{
 try {
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>8192){res.writeHead(413);res.end('Request too large');return;}chunks.push(chunk);}
  const request=new Request('http://127.0.0.1:8888'+req.url,{method:req.method,headers:req.headers as Record<string,string>,body:['GET','HEAD'].includes(req.method||'GET')?undefined:Buffer.concat(chunks)});
  const response=await handleApi(request,env);
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
 } catch {res.writeHead(500);res.end('Internal error');}
}).listen(8888,'127.0.0.1',()=>console.log('Local API listening on port 8888'));

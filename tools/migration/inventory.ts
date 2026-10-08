import {readFile,writeFile} from 'node:fs/promises';
import {createDrive} from '../../packages/infrastructure/src/drive';
import {LegacyExport} from '../../packages/domain/src/migration';
const [input,output]=process.argv.slice(2);
if(!input||!output){console.error('Usage: npm run migration:inventory -- export.json inventory-export.json');process.exitCode=1;}
else try{
 const data=LegacyExport.parse(JSON.parse(await readFile(input,'utf8'))),drive=createDrive(process.env);
 if(data.properties.ROOT_FOLDER_ID&&data.properties.ROOT_FOLDER_ID!==process.env.DRIVE_ROOT_ID)throw Error('Wrong library root');
 const root=await drive.checkRoot(false);const files=[{id:root.id,name:root.name,parents:root.parents,trashed:false,sizeBytes:0}];const queue=[root.id],seen=new Set(queue);
 for(let i=0;i<queue.length;i++)for(const file of await drive.list(queue[i])){
  if(seen.has(file.id))throw Error('Duplicate/cyclic resource');seen.add(file.id);
  files.push({id:file.id,name:file.name,parents:file.parents,trashed:false,sizeBytes:Number(file.size||0)});
  if(file.mimeType==='application/vnd.google-apps.folder')queue.push(file.id);
 }
 await writeFile(output,JSON.stringify({...data,files,inventoryComplete:true},null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({readOnly:true,remoteWrites:0,files:files.length,metrics:drive.metrics}));
}catch{console.error('Inventory incomplete: check library root, Drive connection, permissions and request budget. No remote writes performed.');process.exitCode=1;}

import {readFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
for(const file of await readdir('apps/web/dist/assets')) {
 const text=await readFile('apps/web/dist/assets/'+file,'utf8');
 for(const marker of ['SUPABASE_SERVICE_ROLE_KEY','DATABASE_URL','DRIVE_CLIENT_SECRET','DRIVE_REFRESH_TOKEN','drive-secret-sentinel','server-secret-sentinel','pg-pool'])assert(!text.includes(marker),'Server marker in browser bundle: '+marker);
}
console.log('Browser bundle: no server config or sentinel found.');

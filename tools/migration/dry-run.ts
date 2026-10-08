import {readFile,writeFile} from 'node:fs/promises';
import {dryRunMigration} from '../../packages/domain/src/migration';
const [input,output]=process.argv.slice(2);
if(!input||!output){console.error('Usage: npm run migration:dry-run -- export.json report.json');process.exitCode=1;}
else try {const report=dryRunMigration(JSON.parse(await readFile(input,'utf8')));await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({dryRun:true,remoteWrites:0,ready:report.ready,...report.totals}));if(!report.ready)process.exitCode=2;}
catch {console.error('Export invalid or output exists; no remote requests/writes performed.');process.exitCode=1;}

import {build} from 'esbuild';
await build({entryPoints:['apps/worker/src/main.ts'],outfile:'dist/worker.mjs',bundle:true,platform:'node',target:'node24',format:'esm',packages:'external'});
await build({entryPoints:['netlify/functions/api.ts'],outfile:'dist/api.mjs',bundle:true,platform:'node',target:'node24',format:'esm',packages:'external'});

// Explicit maintenance command: always capture the pinned legacy commit, never current code.
const fs = require('node:fs');
const path = require('node:path');
const {root,baselineCommit,runCase}=require('./legacy-runtime.cjs');
if (process.argv[2] !== '--record-pinned-baseline') throw new Error('Use --record-pinned-baseline only when intentionally reviewing baseline snapshots.');
const cases=JSON.parse(fs.readFileSync(path.join(root,'tests/baseline/cases.json'),'utf8'));
const output={baselineCommit,provenance:'Executed original .gs from git show at pinned commit. Original synthetic fixtures; no live Google services or websites.',cases:Object.fromEntries(cases.map(c=>[c.id,runCase(c,{pinned:true})]))};
fs.writeFileSync(path.join(root,'tests/baseline/golden.json'),JSON.stringify(output,null,2)+'\n');
console.log(`Recorded ${cases.length} cases from ${baselineCommit}. Review values/errors before accepting.`);

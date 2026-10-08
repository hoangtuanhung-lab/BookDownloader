import {randomUUID} from 'node:crypto';
import {checkDatabase} from '../../../packages/infrastructure/src/health';
import {safeLog} from '../../../packages/infrastructure/src/logging';
// Phase 1: finite readiness command, no jobs claimed before handlers/leases exist.
try {
 await checkDatabase(process.env);
 safeLog('worker_ready',randomUUID());
 console.log('Phase 1 worker skeleton: database available; no job handlers implemented.');
} catch {console.error('Worker database unavailable; no jobs processed.');process.exitCode=1;}

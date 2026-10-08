import {z} from 'zod';
import {createAuthServices} from '../../packages/infrastructure/src/auth';
// Deliberately server-only: configured UUID, never first-login/browser bootstrap.
try {
 const id=z.uuid().parse(process.env.BOOTSTRAP_ADMIN_USER_ID);
 await createAuthServices(process.env).rpc('bootstrap_admin',{target:id});
 console.log('Owner admin bootstrapped once.');
}catch{console.error('Bootstrap failed. Check confirmed Google Auth UUID/configuration; owner may already be set.');process.exitCode=1;}

import pg from "pg";
import {
  releaseContract,
  releaseRevision,
} from "../../../packages/contracts/src/release";
import { setTimeout as delay } from "node:timers/promises";
import { createDrive } from "../../../packages/infrastructure/src/drive";
import {
  SourceHttp,
  sourceValidationSession,
} from "../../../packages/infrastructure/src/source-http";
import { runWorkflows } from "../../../packages/infrastructure/src/workflows";
const databaseUrl =
  process.env.DATABASE_URL ||
  ((process.env.APP_ENV || "local") === "local"
    ? "postgresql://postgres:local-only-password@127.0.0.1:55432/bookdownloader"
    : undefined);
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 1,
  connectionTimeoutMillis: 5000,
});
const stopping = new AbortController();
const stop = () => stopping.abort();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
try {
  if (process.argv.includes("--version")) {
    console.log(
      JSON.stringify({ ...releaseContract, revision: releaseRevision }),
    );
  } else {
    if (!databaseUrl) throw Error("Production database binding required");
    const db = await pool.connect();
    try {
      if (process.argv.includes("--check")) {
        if (
          !(
            await db.query(
              "select exists(select 1 from information_schema.columns where table_schema='public' and table_name='jobs' and column_name='lease_epoch') as ready",
            )
          ).rows[0].ready
        )
          throw Error("Phase 7 migrations required");
        if (
          !(
            await db.query(
              "select to_regclass('private.runtime_control') is not null as ready",
            )
          ).rows[0].ready
        )
          throw Error("Phase 9 schema required");
        if (
          !(
            await db.query(
              "select exists(select 1 from public.schema_migrations where name='202610090023_operations_receipts.sql') as ready",
            )
          ).rows[0].ready
        )
          throw Error("Phase 9 ledger required");
        console.log("Worker database ready; no jobs claimed.");
      } else {
        if (!process.env.DRIVE_OWNER_SUBJECT) throw Error("Missing owner");
        do {
          const runtime = (
            await db.query(
              "select maintenance,root_id from private.runtime_control where singleton",
            )
          ).rows[0];
          const passEnv = {
            ...process.env,
            DRIVE_ROOT_ID: runtime.root_id || process.env.DRIVE_ROOT_ID,
          };
          if (runtime.maintenance) {
            console.log(JSON.stringify({ processed: 0, maintenance: true }));
            if (!process.argv.includes("--loop")) break;
            await delay(1000, undefined, { signal: stopping.signal }).catch(
              () => {},
            );
            continue;
          }
          // Reset IO budgets for each bounded pass; refresh settings from DB in executor.
          const drive = createDrive(passEnv, fetch, {
              maxRequests: 1000,
              maxBytes: 64 * 1024 * 1024,
            }),
            http = new SourceHttp(
              JSON.parse(process.env.SOURCE_COOKIES_JSON || "{}"),
            );
          console.log(
            JSON.stringify(
              await runWorkflows(db, {
                rootId: passEnv.DRIVE_ROOT_ID!,
                owner: process.env.DRIVE_OWNER_SUBJECT,
                drive,
                http,
                validateUrl: sourceValidationSession(),
              }),
            ),
          );
          if (!process.argv.includes("--loop") || stopping.signal.aborted)
            break;
          try {
            await delay(10000, undefined, { signal: stopping.signal });
          } catch {
            break;
          }
        } while (!stopping.signal.aborted);
      }
    } finally {
      db.release();
    }
  }
} catch {
  console.error(
    "Worker chưa sẵn sàng. Kiểm tra database và cấu hình Drive phía máy chủ.",
  );
  process.exitCode = 1;
} finally {
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  await pool.end();
}

import pg from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { createDrive } from "../../../packages/infrastructure/src/drive";
import {
  SourceHttp,
  sourceValidationSession,
} from "../../../packages/infrastructure/src/source-http";
import { runWorkflows } from "../../../packages/infrastructure/src/workflows";
const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://postgres:local-only-password@127.0.0.1:55432/bookdownloader",
  max: 1,
  connectionTimeoutMillis: 5000,
});
const stopping = new AbortController();
const stop = () => stopping.abort();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
try {
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
      console.log("Worker database ready; no jobs claimed.");
    } else {
      if (!process.env.DRIVE_OWNER_SUBJECT) throw Error("Missing owner");
      do {
        // Reset IO budgets for each bounded pass; refresh settings from DB in executor.
        const drive = createDrive(process.env, fetch, {
            maxRequests: 1000,
            maxBytes: 64 * 1024 * 1024,
          }),
          http = new SourceHttp(
            JSON.parse(process.env.SOURCE_COOKIES_JSON || "{}"),
          );
        console.log(
          JSON.stringify(
            await runWorkflows(db, {
              rootId: process.env.DRIVE_ROOT_ID!,
              owner: process.env.DRIVE_OWNER_SUBJECT,
              drive,
              http,
              validateUrl: sourceValidationSession(),
            }),
          ),
        );
        if (!process.argv.includes("--loop") || stopping.signal.aborted) break;
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

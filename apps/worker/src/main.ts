import pg from "pg";
import { createDrive } from "../../../packages/infrastructure/src/drive";
import {
  SourceHttp,
  sourceValidationSession,
} from "../../../packages/infrastructure/src/source-http";
import { runWorkflows } from "../../../packages/infrastructure/src/workflows";
// Explicit finite run; never starts a loop/scheduler or provisions a cloud service.
const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://postgres:local-only-password@127.0.0.1:55432/bookdownloader",
  max: 1,
  connectionTimeoutMillis: 5000,
});
try {
  const db = await pool.connect();
  try {
    if (process.argv.includes("--check")) {
      if (
        !(await db.query("select to_regclass('public.jobs') as name")).rows[0]
          .name
      )
        throw Error("Migrations required");
      console.log("Worker database ready; no jobs claimed.");
    } else {
      if (!process.env.DRIVE_OWNER_SUBJECT) throw Error("Missing owner");
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
  await pool.end();
}

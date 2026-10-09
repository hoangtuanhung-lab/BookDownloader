import { createHash, timingSafeEqual } from "node:crypto";
import pg from "pg";
import { AppError } from "../../contracts/src/index";
import { createDrive } from "./drive";
import { SourceHttp, sourceValidationSession } from "./source-http";
import { runWorkflows } from "./workflows";

export function workerStatus(env: NodeJS.ProcessEnv) {
  const requirements = {
    NETLIFY_WORKER_ENABLED: "bật worker Netlify",
    DATABASE_URL: "kết nối database Session pooler",
    DRIVE_ROOT_ID: "thư mục Drive",
    DRIVE_CLIENT_ID: "OAuth Client ID",
    DRIVE_CLIENT_SECRET: "OAuth Client secret",
    DRIVE_REFRESH_TOKEN: "refresh token Drive",
    DRIVE_OWNER_SUBJECT: "định danh Google của chủ Drive",
    SUPABASE_SERVICE_ROLE_KEY: "khóa máy chủ",
    URL: "URL site Netlify",
  };
  const missing = Object.entries(requirements)
    .filter(([key]) => key === "NETLIFY_WORKER_ENABLED" ? env[key] !== "true" : !env[key])
    .map(([, label]) => label);
  return { configured: missing.length === 0, missing };
}

export async function kickWorker(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch) {
  if (!workerStatus(env).configured)
    throw new AppError("WORKER_UNCONFIGURED", 503, "Chưa cấu hình đủ worker Netlify; xem thông báo ở bảng phân tích");
  const site = new URL(env.URL!);
  if (site.protocol !== "https:" || site.username || site.password)
    throw new AppError("WORKER_UNCONFIGURED", 503, "URL worker không hợp lệ");
  try {
    const response = await fetcher(new URL("/.netlify/functions/library-worker-background", site), {
      method: "POST", headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY },
      signal: AbortSignal.timeout(5000), redirect: "error",
    });
    if (response.status !== 202) throw Error();
  } catch {
    throw new AppError("WORKER_UNAVAILABLE", 503, "Chưa gọi được worker; URL vẫn được giữ trong hàng chờ");
  }
}

export function workerAuthorized(request: Request, env: NodeJS.ProcessEnv) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(request.headers.get("authorization") || ""), digest("Bearer " + env.SUPABASE_SERVICE_ROLE_KEY));
}

export async function runNetlifyWorker(env: NodeJS.ProcessEnv, dependencies = { pool: (url: string) => new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 }), run: runWorkflows }) {
  if (!workerStatus(env).configured) throw Error("Worker configuration missing");
  // Session pooler is required: advisory locks must survive transaction boundaries.
  const pool = dependencies.pool(env.DATABASE_URL!);
  try {
    const db = await pool.connect();
    let locked = false;
    try {
      locked = (await db.query("select pg_try_advisory_lock(610100001) as ok")).rows[0].ok;
      if (!locked) return { processed: 0, busy: true };
      const ready = (await db.query("select exists(select 1 from public.schema_migrations where name='202610090023_operations_receipts.sql') as ready")).rows[0].ready;
      if (!ready) throw Error("Worker schema mismatch");
      const state = (await db.query("select maintenance,root_id from private.runtime_control where singleton")).rows[0];
      if (state.maintenance) return { processed: 0, maintenance: true };
      const rootId = state.root_id || env.DRIVE_ROOT_ID!;
      return await dependencies.run(db, {
        rootId, owner: env.DRIVE_OWNER_SUBJECT!,
        drive: createDrive({ ...env, DRIVE_ROOT_ID: rootId }, fetch, { maxRequests: 1000, maxBytes: 64 * 1024 * 1024 }),
        http: new SourceHttp(JSON.parse(env.SOURCE_COOKIES_JSON || "{}")),
        validateUrl: sourceValidationSession(), maxMs: 45000,
      });
    } finally {
      try { if (locked) await db.query("select pg_advisory_unlock(610100001)"); }
      finally { db.release(); }
    }
  } finally { await pool.end(); }
}

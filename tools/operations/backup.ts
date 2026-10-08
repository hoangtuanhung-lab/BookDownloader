import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  chmod,
  realpath,
  rm,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import { relative, resolve, isAbsolute } from "node:path";
import { z } from "zod";
import type { PoolClient } from "pg";
import { localPool } from "../../packages/infrastructure/src/database";
import { localUrl, localCommand } from "./local";
const FileMap = z.record(
  z.string().regex(/^[\w-]{1,200}$/),
  z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
);
export async function fileHash(path: string) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}
async function inside(root: string, path: string) {
  const full = await realpath(resolve(root, path)),
    r = relative(root, full);
  if (r === ".." || r.startsWith("../") || isAbsolute(r))
    throw Error("Backup path outside root");
  return full;
}
export async function databaseDigest(db: PoolClient) {
  const tables = (
    await db.query(
      "select schemaname,tablename from pg_tables where schemaname in ('public','private','auth') and not(schemaname='private' and tablename in ('reader_cache','operation_transactions')) order by schemaname,tablename",
    )
  ).rows;
  const result: Record<string, string> = {};
  for (const t of tables) {
    if (
      !/^[a-z_][a-z0-9_]*$/.test(t.schemaname) ||
      !/^[a-z_][a-z0-9_]*$/.test(t.tablename)
    )
      throw Error("Unsupported table name");
    const name = t.schemaname + "." + t.tablename;
    result[name] = (
      await db.query(
        "select md5(coalesce(string_agg(row_hash,'' order by row_hash),'')) as hash from (select md5(to_jsonb(t)::text) row_hash from " +
          name +
          " t) rows",
      )
    ).rows[0].hash;
  }
  return result;
}
async function pgTool(
  tool: "pg_dump" | "pg_restore",
  url: string,
  path: string,
  args: string[],
) {
  // Refuse remote targets even if credentials happen to be present.
  const guard = localPool(url);
  await guard.end();
  const u = new URL(url);
  const native =
    spawnSync(tool, ["--version"], { stdio: "ignore" }).status === 0;
  let process: ChildProcessWithoutNullStreams;
  if (native)
    process = spawn(tool, args, {
      env: {
        ...globalThis.process.env,
        PGHOST: u.hostname,
        PGPORT: u.port || "5432",
        PGDATABASE: u.pathname.slice(1),
        PGUSER: decodeURIComponent(u.username),
        PGPASSWORD: decodeURIComponent(u.password),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
  else {
    const container =
      globalThis.process.env.BOOK_POSTGRES_CONTAINER || "bookdownloader-db-1";
    if (
      !/^[\w.-]+$/.test(container) ||
      u.username !== "postgres" ||
      !["127.0.0.1", "localhost"].includes(u.hostname) ||
      u.port !== "55432"
    )
      throw Error("Native PostgreSQL tools required for this local connection");
    const config =
      globalThis.process.env.BOOK_DOCKER_CONFIG || "/tmp/book-docker";
    process = spawn(
      "docker",
      [
        "--config",
        config,
        "exec",
        "-i",
        container,
        tool,
        "-U",
        "postgres",
        ...args,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
  }
  const completed = new Promise<void>((ok, bad) => {
    process.on("error", bad);
    process.on("close", (code) =>
      code === 0
        ? ok()
        : bad(Error("PostgreSQL backup/restore process failed")),
    );
  });
  process.stderr.resume();
  const streams =
    tool === "pg_dump"
      ? pipeline(
          process.stdout,
          createWriteStream(path, { flags: "wx", mode: 0o600 }),
        )
      : pipeline(createReadStream(path), process.stdin);
  if (tool === "pg_dump") process.stdin.end();
  else process.stdout.resume();
  await Promise.all([streams, completed]);
}
export async function createLocalBackup(
  db: PoolClient,
  url: string,
  output: string,
  filesRoot: string,
  filesInput: unknown,
) {
  const files = FileMap.parse(filesInput),
    root = await realpath(filesRoot);
  await db.query("select pg_advisory_lock_shared(610090001)");
  try {
    if (
      !(
        await db.query(
          "select maintenance from private.runtime_control where singleton",
        )
      ).rows[0].maintenance
    )
      throw Error("Enable maintenance before backup");
    const expected = (
      await db.query(
        "select file_id id from public.drive_resources union select file_id from public.chapters where file_id is not null union select checkpoint->>'importId' from public.jobs where checkpoint ? 'importId' and status not in ('done','cancelled')",
      )
    ).rows;
    for (const f of expected)
      if (!files[f.id]) throw Error("Backup missing a referenced content file");
    await mkdir(output, { mode: 0o700 });
    await mkdir(resolve(output, "files"), { mode: 0o700 });
    const stored: Record<string, { path: string; sha256: string }> = {};
    for (const [id, value] of Object.entries(files)) {
      const from = await inside(root, value.path),
        to = resolve(output, "files", id + ".bin");
      if ((await fileHash(from)) !== value.sha256)
        throw Error("Input file checksum conflict");
      await copyFile(from, to);
      await chmod(to, 0o600);
      if ((await fileHash(to)) !== value.sha256)
        throw Error("File changed during backup");
      stored[id] = { path: "files/" + id + ".bin", sha256: value.sha256 };
    }
    const digest = await databaseDigest(db),
      dump = resolve(output, "database.dump");
    await pgTool("pg_dump", url, dump, [
      "-Fc",
      "--no-owner",
      new URL(url).pathname.slice(1),
    ]);
    const manifest = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      maintenance: true,
      databaseDump: { path: "database.dump", sha256: await fileHash(dump) },
      tables: digest,
      files: stored,
      remoteWrites: 0,
    };
    await writeFile(
      resolve(output, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    return manifest;
  } finally {
    await db.query("select pg_advisory_unlock_shared(610090001)");
  }
}
const Manifest = z.object({
  schemaVersion: z.literal(1),
  maintenance: z.literal(true),
  databaseDump: z.object({
    path: z.literal("database.dump"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  tables: z.record(z.string(), z.string()),
  files: FileMap,
});
export async function restoreLocalBackup(adminUrl: string, directory: string) {
  const guard = localPool(adminUrl),
    root = await realpath(directory),
    manifest = Manifest.parse(
      JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8")),
    );
  try {
    const dump = await inside(root, manifest.databaseDump.path);
    if ((await fileHash(dump)) !== manifest.databaseDump.sha256)
      throw Error("Database dump checksum conflict");
    for (const file of Object.values(manifest.files))
      if ((await fileHash(await inside(root, file.path))) !== file.sha256)
        throw Error("Content backup checksum conflict");
    const name = "book_restore_" + randomUUID().replaceAll("-", ""),
      url = new URL(adminUrl);
    url.pathname = "/" + name;
    await guard.query("create database " + name);
    try {
      await pgTool("pg_restore", url.href, dump, [
        "--exit-on-error",
        "--no-owner",
        "-d",
        name,
      ]);
      const restored = localPool(url.href),
        db = await restored.connect();
      try {
        const actual = await databaseDigest(db);
        if (JSON.stringify(actual) !== JSON.stringify(manifest.tables))
          throw Error("Restored metadata differs from snapshot");
        if (
          !(
            await db.query(
              "select maintenance from private.runtime_control where singleton",
            )
          ).rows[0].maintenance
        )
          throw Error("Restored database must remain in maintenance");
        await db.query("truncate private.reader_cache");
      } finally {
        db.release();
        await restored.end();
      }
      return {
        database: name,
        restored: true,
        maintenance: true,
        files: Object.keys(manifest.files).length,
        remoteWrites: 0,
      };
    } catch (error) {
      await guard.query("drop database " + name + " with (force)");
      throw error;
    }
  } finally {
    await guard.end();
  }
}
async function main() {
  const [action, a, b, c] = process.argv.slice(2);
  if (action === "backup" && a && b && c)
    await localCommand(async (db) => {
      const report = await createLocalBackup(
        db,
        localUrl(),
        a,
        b,
        JSON.parse(await readFile(c, "utf8")),
      );
      console.log(
        JSON.stringify({
          backedUp: true,
          files: Object.keys(report.files).length,
          remoteWrites: 0,
        }),
      );
    });
  else if (action === "restore" && a)
    console.log(JSON.stringify(await restoreLocalBackup(localUrl(), a)));
  else
    throw Error(
      "Usage: operations:backup -- backup NEW_DIR FILES_ROOT FILE_MAP.json | restore BACKUP_DIR",
    );
}
if (process.argv[1]?.endsWith("backup.ts"))
  main().catch(() => {
    console.error(
      "Local backup/restore failed; source not overwritten, no cloud operation performed",
    );
    process.exitCode = 1;
  });

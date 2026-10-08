import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { localPool } from "../../packages/infrastructure/src/database";
import {
  importLegacyLocal,
  prepareImport,
  sha256,
} from "../migration/import-local";
import { migrationId } from "../../packages/domain/src/migration";
import { readStoredChapter } from "../../packages/infrastructure/src/reader-storage";
import type { AuthServices } from "../../packages/infrastructure/src/auth";
import { migrate } from "./migrate";
import { runWorkflows } from "../../packages/infrastructure/src/workflows";
import { memoryDrive } from "../../tests/phase-5/fixture";
import { runPhase8Load } from "./phase8-load";
async function main() {
  const original =
      process.env.DATABASE_URL ||
      "postgresql://postgres:local-only-password@127.0.0.1:55432/bookdownloader",
    admin = localPool(original);
  const name = "book_migration_test_" + randomUUID().replaceAll("-", ""),
    restore = "book_restore_test_" + randomUUID().replaceAll("-", ""),
    url = new URL(original);
  url.pathname = "/" + name;
  const owner = "a8000000-0000-4000-8000-000000000001",
    reader = "a8000000-0000-4000-8000-000000000002";
  const options = {
    sourceKey: "synthetic-v1",
    ownerId: owner,
    ownerEmail: "owner@example.test",
    driveSubject: "synthetic-owner",
    progress: [{ book: "BOOK001", order: 1, ratio: 0.4, scrollPosition: 20 }],
  };
  let pool: ReturnType<typeof localPool> | undefined,
    passed = 0;
  async function check(label: string, fn: () => Promise<void>) {
    await fn();
    console.log("PASS " + label);
    passed++;
  }
  const input = JSON.parse(
    await readFile("tools/migration/sample.json", "utf8"),
  );
  input.BOOKS[0][3] = "WEB";
  input.BOOKS[0][2] = "https://source.test/book/";
  input.BOOKS[0][8] = "DOWNLOADING";
  function docker(args: string[], stdin?: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const p = spawn(
        "docker",
        [
          "--config",
          "/tmp/book-docker",
          "exec",
          ...(stdin ? ["-i"] : []),
          "bookdownloader-db-1",
          ...args,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const chunks: Buffer[] = [];
      p.stdout.on("data", (v) => chunks.push(v));
      p.stderr.resume();
      p.on("error", reject);
      p.on("close", (code) =>
        code === 0
          ? resolve(Buffer.concat(chunks))
          : reject(Error("Local backup process failed")),
      );
      p.stdin.end(stdin);
    });
  }
  try {
    await admin.query("create database " + name);
    process.env.DATABASE_URL = url.href;
    await migrate();
    pool = localPool(url.href);
    const db = await pool.connect();
    try {
      for (const [id, email] of [
        [owner, "owner@example.test"],
        [reader, "reader@example.test"],
      ])
        await db.query(
          'insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data) values($1,$2,now(),\'{"provider":"google"}\')',
          [id, email],
        );
      await db.query("select public.bootstrap_admin($1)", [owner]);
      await check(
        "foreign/unverified owner denied with no imported rows",
        async () => {
          await assert.rejects(
            importLegacyLocal(db, input, { ...options, ownerId: reader }),
          );
          await assert.rejects(
            importLegacyLocal(db, input, {
              ...options,
              ownerEmail: "wrong@example.test",
            }),
          );
          assert.equal(
            (await db.query("select count(*)::int n from public.books")).rows[0]
              .n,
            0,
          );
        },
      );
      await check(
        "dry-run then atomic private import preserves metadata and exact group/display",
        async () => {
          assert.equal(
            prepareImport(input, options).report.chapters[0].displayNumber,
            "1-2",
          );
          await importLegacyLocal(db, input, options);
          const b = (await db.query("select * from public.books")).rows[0];
          assert.equal(b.visibility, "hidden");
          assert.equal(b.author, input.BOOKS[0][10]);
          assert.equal(b.source_url, input.BOOKS[0][2]);
          assert.equal(b.created_at.toISOString(), "2026-10-07T17:00:00.000Z");
          assert.equal(
            (
              await db.query(
                "select count(*)::int n from public.chapter_groups",
              )
            ).rows[0].n,
            2,
          );
          assert.equal(
            (await db.query("select display_number from public.chapters"))
              .rows[0].display_number,
            "1-2",
          );
        },
      );
      await check(
        "old DOWNLOADING becomes paused job without lease or Drive writes",
        async () => {
          const j = (await db.query("select * from public.jobs")).rows[0];
          assert.equal(j.status, "paused");
          assert.equal(j.lease_owner, null);
          assert.equal(j.lease_until, null);
          assert.equal(j.checkpoint.migrationReviewRequired, true);
          assert.equal(
            (
              await db.query(
                "select count(*)::int n from public.outbox_operations",
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (await db.query("select download_status from public.books")).rows[0]
              .download_status,
            "PAUSED",
          );
        },
      );
      await check(
        "rerun preserves IDs/counts, no duplicate jobs/progress/resources",
        async () => {
          const again = await importLegacyLocal(db, input, options);
          assert.equal(again.repeated, true);
          for (const table of [
            "books",
            "chapters",
            "jobs",
            "reading_progress",
            "drive_resources",
            "migration_runs",
          ])
            assert.equal(
              (await db.query("select count(*)::int n from public." + table))
                .rows[0].n,
              1,
            );
        },
      );
      await check(
        "changed snapshot conflicts; imported data remains unchanged",
        async () => {
          const changed = structuredClone(input);
          changed.BOOKS[0][10] = "Different";
          await assert.rejects(
            importLegacyLocal(db, changed, options),
            /conflict/,
          );
          assert.equal(
            (await db.query("select author from public.books")).rows[0].author,
            input.BOOKS[0][10],
          );
        },
      );
      await check(
        "reader sees no hidden migration books or owner progress",
        async () => {
          assert.equal(
            (await db.query("select public.app_library($1) v", [reader]))
              .rows[0].v.total,
            0,
          );
          assert.equal(
            (await db.query("select user_id from public.reading_progress"))
              .rows[0].user_id,
            owner,
          );
          await db.query("set role authenticated");
          await db.query(
            "select set_config('request.jwt.claim.sub',$1,false)",
            [reader],
          );
          assert.equal(
            (await db.query("select * from public.reading_progress")).rowCount,
            0,
          );
          await assert.rejects(
            db.query("select * from private.legacy_imports"),
            { code: "42501" },
          );
          await db.query("reset role");
        },
      );
      await check(
        "migration review gate blocks API start/retry and worker admission",
        async () => {
          const b = migrationId("book", "BOOK001");
          await assert.rejects(
            db.query(
              "select public.app_download($1,'start',jsonb_build_object('id',$2::text))",
              [owner, b],
            ),
            { code: "55000" },
          );
          assert.equal(
            (
              await db.query(
                "select private.job_actor_allowed($1,'WEB_DOWNLOAD',$2,'{}') v",
                [owner, b],
              )
            ).rows[0].v,
            false,
          );
          await assert.rejects(
            db.query("select public.review_legacy_book($1,$2,$3)", [
              owner,
              b,
              prepareImport(input, options).checksum,
            ]),
            { code: "55000" },
          );
        },
      );
      await check(
        "outbox cannot write migrated folders before review",
        async () => {
          const b = migrationId("book", "BOOK001"),
            f = memoryDrive();
          await db.query(
            "insert into public.outbox_operations(book_id,kind,dedupe_key,payload) values($1,'BOOK_SYNC','phase8-review','{}')",
            [b],
          );
          await runWorkflows(db, {
            rootId: "root",
            owner: "synthetic-owner",
            drive: f.drive,
            http: {
              async get() {
                throw Error("No HTTP allowed");
              },
            },
            validateUrl: async () => {},
            maxMs: 1000,
          });
          assert.equal(
            (
              await db.query(
                "select attempts from public.outbox_operations where dedupe_key='phase8-review'",
              )
            ).rows[0].attempts,
            0,
          );
          assert.equal(f.bodies.size, 0);
          await db.query(
            "delete from public.outbox_operations where dedupe_key='phase8-review'",
          );
        },
      );
      await check(
        "pending file mapping is not readable even to admin",
        async () => {
          await assert.rejects(
            db.query("select public.app_reader_resource($1,$2,$3)", [
              owner,
              migrationId("book", "BOOK001"),
              migrationId("chapter", "BOOK001:1"),
            ]),
            { code: "P0002" },
          );
        },
      );
      await check(
        "rerun does not overwrite later edits; missing resources never resurrect",
        async () => {
          await db.query(
            "update public.books set author='Edited later',version=version+1",
          );
          await importLegacyLocal(db, input, options);
          assert.equal(
            (await db.query("select author from public.books")).rows[0].author,
            "Edited later",
          );
          await db.query("update public.books set deleted_at=now()");
          await assert.rejects(
            importLegacyLocal(db, input, options),
            /missing\/deleted/,
          );
          await db.query("update public.books set deleted_at=null");
        },
      );
      await check(
        "separate owner publication and fixture file verification enable read; blocked user denied after cache",
        async () => {
          await db.query(
            "update public.books set visibility='published';update public.drive_resources set sync_status='synced',content_hash=repeat('a',64)",
          );
          const book = migrationId("book", "BOOK001"),
            chapter = migrationId("chapter", "BOOK001:1");
          await db.query("select public.review_legacy_book($1,$2,$3)", [
            owner,
            book,
            prepareImport(input, options).checksum,
          ]);
          const service: AuthServices = {
            async verify() {
              throw Error("Not used");
            },
            async rpc(r, args) {
              if (r === "app_reader_resource")
                return (
                  await db.query(
                    "select public.app_reader_resource($1,$2,$3) v",
                    [args.actor, args.target_book, args.target_chapter],
                  )
                ).rows[0].v;
              if (r === "app_reader_cache") {
                await db.query(
                  "select public.app_reader_cache($1,$2,$3,$4,$5)",
                  [
                    args.actor,
                    args.target_book,
                    args.target_chapter,
                    args.expected_key,
                    args.new_value,
                  ],
                );
                return null;
              }
              throw Error("Unexpected RPC");
            },
          };
          let reads = 0;
          const storage = {
            async readText() {
              reads++;
              return "Chương 1: Khởi đầu\n\nNội dung mẫu đủ dài.\n";
            },
            async readBytes() {
              throw Error("Unused");
            },
          };
          const cold = await readStoredChapter(
              service,
              storage,
              reader,
              book,
              chapter,
            ),
            warm = await readStoredChapter(
              service,
              storage,
              reader,
              book,
              chapter,
            );
          assert.deepEqual(cold, warm);
          assert.equal(reads, 1);
          await db.query(
            "update public.profiles set status='blocked' where id=$1",
            [reader],
          );
          await assert.rejects(
            readStoredChapter(service, storage, reader, book, chapter),
          );
          await db.query(
            "update public.profiles set status='active' where id=$1",
            [reader],
          );
        },
      );
      if (
        process.env.PHASE8_BACKUP_REHEARSAL === "1" ||
        process.argv.includes("--backup-rehearsal")
      )
        await check(
          "actual PostgreSQL dump restores metadata, permissions, progress and ledger in a second disposable DB",
          async () => {
            const dump = await docker([
              "pg_dump",
              "-U",
              "postgres",
              "-Fc",
              "--no-owner",
              name,
            ]);
            await mkdir(".local-library/phase8", { recursive: true });
            await writeFile(".local-library/phase8/rehearsal.dump", dump, {
              mode: 0o600,
            });
            await admin.query("create database " + restore);
            await docker(
              [
                "pg_restore",
                "-U",
                "postgres",
                "--exit-on-error",
                "--no-owner",
                "-d",
                restore,
              ],
              dump,
            );
            const ru = new URL(original);
            ru.pathname = "/" + restore;
            const restored = localPool(ru.href);
            try {
              for (const table of [
                "public.books",
                "public.chapters",
                "public.chapter_groups",
                "public.jobs",
                "public.drive_resources",
                "public.reading_progress",
                "public.migration_items",
                "private.legacy_imports",
              ]) {
                const q =
                  "select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) v from " +
                  table +
                  " t";
                assert.deepEqual(
                  (await restored.query(q)).rows[0].v,
                  (await db.query(q)).rows[0].v,
                );
              }
              assert.equal(
                (
                  await restored.query(
                    "select has_table_privilege('authenticated','private.legacy_imports','select') v",
                  )
                ).rows[0].v,
                false,
              );
              await writeFile(
                "docs/phase-8/backup-result.json",
                JSON.stringify(
                  {
                    synthetic: true,
                    engine: "PostgreSQL pg_dump/pg_restore",
                    restored: true,
                    dumpSha256: sha256(dump),
                    driveFilesBackedUp: false,
                    checkedTables: 8,
                    permissionsRestored: true,
                  },
                  null,
                  2,
                ) + "\n",
              );
            } finally {
              await restored.end();
            }
          },
        );
      // Fresh target for rollback / skipped / long-library tests.
      await db.query(
        "truncate public.books,public.genres,public.migration_runs,public.audit_logs restart identity cascade",
      );
      await check(
        "SQL collision rolls back complete import and ledger",
        async () => {
          const broken = structuredClone(input);
          broken.BOOKS[0][5] = 2;
          broken.BOOKS[0][6] = 2;
          broken.CHAPTERS.push([...broken.CHAPTERS[0]]);
          broken.CHAPTERS[1][1] = "1.0";
          broken.CHAPTERS[1][5] = "other-file";
          broken.files.push({ id: "other-file", parents: ["sample-book"] });
          await assert.rejects(importLegacyLocal(db, broken, options));
          assert.equal(
            (await db.query("select count(*)::int n from public.books")).rows[0]
              .n,
            0,
          );
          assert.equal(
            (
              await db.query(
                "select count(*)::int n from private.legacy_imports",
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await check(
        "explicit skipped DONE retains fraction/negative order and never becomes readable",
        async () => {
          const skipped = structuredClone(input);
          skipped.CHAPTERS[0][1] = -0.5;
          skipped.CHAPTERS[0][5] = "";
          await importLegacyLocal(db, skipped, {
            ...options,
            progress: [],
            skippedChapterKeys: ["BOOK001:-0.5"],
          });
          const c = (await db.query("select * from public.chapters")).rows[0];
          assert.equal(c.is_skipped, true);
          assert.equal(c.legacy_order, "-0.5");
          await assert.rejects(
            db.query("select public.app_reader_resource($1,$2,$3)", [
              owner,
              c.book_id,
              c.id,
            ]),
          );
        },
      );
      if (process.env.PHASE8_LOAD === "1" || process.argv.includes("--load"))
        await check(
          "Phase 0 synthetic workloads meet fixed local thresholds",
          async () => {
            await runPhase8Load(db, owner, reader);
          },
        );
      console.log("Migration SQL checks passed: " + passed);
    } finally {
      db.release();
    }
  } finally {
    process.env.DATABASE_URL = original;
    await pool?.end();
    await admin.query("drop database if exists " + restore + " with (force)");
    await admin.query("drop database if exists " + name + " with (force)");
    await admin.end();
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof assert.AssertionError
      ? error.message
      : "Migration SQL check failed: " + (error as { code?: string }).code,
  );
  process.exitCode = 1;
});

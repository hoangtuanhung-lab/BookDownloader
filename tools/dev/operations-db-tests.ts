import { localPreflight } from "../release/preflight";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { localPool } from "../../packages/infrastructure/src/database";
import { AppError } from "../../packages/contracts/src/index";
import type { AuthServices } from "../../packages/infrastructure/src/auth";
import { configureRoot } from "../../packages/infrastructure/src/operations";
import { runWorkflows } from "../../packages/infrastructure/src/workflows";
import { memoryDrive } from "../../tests/phase-5/fixture";
import {
  importLegacyLocal,
  prepareImport,
  sha256,
} from "../migration/import-local";
import { reconcileLegacyLocal } from "../migration/reconcile-local";
import { verifyAndRegisterLocalFiles } from "../migration/verify-apply-local";
import {
  planLegacyDelta,
  applyLegacyDeltaLocal,
} from "../migration/delta-local";
import { createLocalBackup, restoreLocalBackup } from "../operations/backup";
import { withOperation } from "../operations/local";
import { migrationId } from "../../packages/domain/src/migration";
import { migrate } from "./migrate";
async function main() {
  const original =
      process.env.DATABASE_URL ||
      "postgresql://postgres:local-only-password@127.0.0.1:55432/bookdownloader",
    admin = localPool(original),
    name = "book_operations_test_" + randomUUID().replaceAll("-", ""),
    url = new URL(original);
  url.pathname = "/" + name;
  const owner = "a9000000-0000-4000-8000-000000000001",
    reader = "a9000000-0000-4000-8000-000000000002";
  const dir = await mkdtemp("/tmp/book-operations-"),
    restored: string[] = [];
  let pool: ReturnType<typeof localPool> | undefined,
    passed = 0;
  async function check(label: string, fn: () => Promise<void>) {
    console.log("CHECK " + label);
    await fn();
    console.log("PASS " + label);
    passed++;
  }
  try {
    await admin.query("create database " + name);
    process.env.DATABASE_URL = url.href;
    await migrate();
    pool = localPool(url.href);
    const db = await pool.connect(),
      other = await pool.connect();
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
      async function op(action: string, input: unknown = {}) {
        return (
          await db.query("select public.app_operations($1,$2,$3) v", [
            owner,
            action,
            JSON.stringify(input),
          ])
        ).rows[0].v;
      }
      const service: AuthServices = {
        async verify() {
          return {
            id: owner,
            email: "owner@example.test",
            email_confirmed_at: "now",
            app_metadata: { provider: "google" },
          };
        },
        async rpc(name, args) {
          if (name !== "app_operations") throw Error("Unexpected RPC");
          try {
            return await op(args.operation as string, args.input);
          } catch (e) {
            throw new AppError("CONFLICT", 409, "Operation rejected");
          }
        },
      };
      await check(
        "operations are admin/service-only; browser cannot read private controls",
        async () => {
          await assert.rejects(
            db.query("select public.app_operations($1,'status')", [reader]),
            { code: "42501" },
          );
          await db.query("set role authenticated");
          await assert.rejects(
            db.query("select * from private.runtime_control"),
            { code: "42501" },
          );
          await assert.rejects(
            db.query(
              "select public.app_operations($1,'maintenance','{\"enabled\":true}')",
              [owner],
            ),
            { code: "42501" },
          );
          await db.query("reset role");
        },
      );
      await check(
        "maintenance refuses to interrupt an active worker session",
        async () => {
          await other.query("select pg_advisory_lock_shared(610090001)");
          await assert.rejects(op("maintenance", { enabled: true }), {
            code: "40001",
          });
          await other.query("select pg_advisory_unlock_shared(610090001)");
          assert.equal((await op("status")).maintenance, false);
        },
      );
      await op("maintenance", { enabled: true });
      await check(
        "SQL rejects metadata writes and worker performs zero IO in maintenance",
        async () => {
          await assert.rejects(
            db.query("insert into public.genres(name) values('Blocked')"),
            { code: "55000" },
          );
          const f = memoryDrive(),
            result = await runWorkflows(db, {
              rootId: "root",
              owner: "synthetic-owner",
              drive: f.drive,
              http: {
                async get() {
                  throw Error("No HTTP");
                },
              },
              validateUrl: async () => {},
            });
          assert.equal("maintenance" in result && result.maintenance, true);
          assert.equal(f.bodies.size, 0);
        },
      );
      const f = memoryDrive();
      const factory = (env: NodeJS.ProcessEnv) => ({
        async checkRoot() {
          return f.drive.assertUnderRoot(env.DRIVE_ROOT_ID!);
        },
        folder: f.drive.folder.bind(f.drive),
      });
      let root = "";
      const rootRequest = randomUUID();
      await check(
        "admin creates/registers a durable root with idempotent receipt",
        async () => {
          const state: any = await configureRoot(
            service,
            owner,
            {
              requestId: rootRequest,
              revision: (await op("status")).revision,
              kind: "create",
              id: "root",
              name: "Thư viện local",
            },
            {},
            factory,
          );
          root = state.rootId;
          assert(root);
          const count = f.files.size;
          assert.equal(
            (
              await configureRoot(
                service,
                owner,
                {
                  requestId: rootRequest,
                  revision: 1,
                  kind: "create",
                  id: "root",
                  name: "Thư viện local",
                },
                {},
                factory,
              )
            ).repeated,
            true,
          );
          assert.equal(f.files.size, count);
          assert.equal(
            (await db.query("select public.app_runtime_root($1) v", [reader]))
              .rows[0].v.rootId,
            root,
          );
        },
      );
      const bookFolder = await f.drive.folder(root, "Truyện mẫu local"),
        part = await f.drive.folder(bookFolder, "Phần một"),
        volume = await f.drive.folder(part, "Quyển một");
      const body =
          "Truyện mẫu local\nChương 1: Khởi đầu\n\n" +
          "Nội dung gốc tự viết dùng kiểm thử. ".repeat(20),
        fileId = await f.drive.putText(volume, "Chương 1.txt", body, 1);
      let importContent = JSON.stringify([
        {
          num: 2,
          title: "Tiếp theo",
          body: "Nội dung chương hai tự viết.",
          part: "Phần một",
          vol: "Quyển một",
          dnum: 2,
          marked: true,
        },
      ]);
      const importId = await f.drive.putText(
        bookFolder,
        "_import.json",
        importContent,
        1,
      );
      const logContent =
          "Mỗi dòng: thời điểm | chương | phần › quyển | tiêu đề | link | lý do.\n08/10/2026 17:23:45 | Chương 0 | Phần một › Quyển một | Chương rỗng | https://source.test/old/ | Nội dung rỗng\n",
        logId = await f.drive.putText(
          bookFolder,
          "_Chương lỗi đã xóa.txt",
          logContent,
          1,
        );
      const data = JSON.parse(
        await readFile("tools/migration/sample.json", "utf8"),
      );
      data.properties.ROOT_FOLDER_ID = root;
      data.BOOKS[0][4] = bookFolder;
      data.BOOKS[0][5] = 2;
      data.BOOKS[0][8] = "DOWNLOADING";
      data.BOOKS[0][9] = "08/10/2026 17:23:45";
      data.CHAPTERS[0][5] = fileId;
      data.CHAPTERS[0][8] = "08/10/2026 17:23:45";
      data.CHAPTERS.push([
        "BOOK001",
        2,
        "Tiếp theo",
        "",
        "PENDING",
        "",
        0,
        "",
        "09/10/2026 00:00:00",
        "Phần một",
        "Quyển một",
        "2",
      ]);
      data.CONFIG = [
        ["BATCH_SIZE", 2],
        ["DELAY_MS", 0],
        ["AUTO_RESUME", "TRUE"],
        ["FILE_TYPE", "TXT"],
        ["ENCODING", "UTF-8"],
        ["GENRES", '["Phiêu lưu","Trinh thám"]'],
      ];
      const inventory = () =>
        [...f.files.values()]
          .filter((v) => !v.trashed)
          .map((v) => ({
            id: v.id,
            name: v.name,
            parents: v.parents,
            trashed: v.trashed,
            ...(f.bodies.has(v.id)
              ? { sizeBytes: f.bodies.get(v.id)!.length }
              : {}),
          }));
      data.files = inventory();
      const options = {
        sourceKey: "phase9-fixture",
        ownerId: owner,
        ownerEmail: "owner@example.test",
        driveSubject: "synthetic-owner",
        progress: [
          { book: "BOOK001", order: 1, ratio: 0.5, scrollPosition: 42 },
        ],
      };
      const state = () => ({
        scriptState: {
          DB_ID: "private-sheet-id",
          ANA_QUEUE: JSON.stringify({
            w: ["https://source.test/queued/"],
            e: [["https://source.test/failed/", "PRIVATE_COOKIE_MESSAGE"]],
            h: [],
          }),
          ["IMP_" + bookFolder]: importId,
          ["DEL_" + bookFolder]: logId,
        },
        LOG: [
          [
            "08/10/2026 17:23:45",
            "BOOK001",
            0,
            "REMOVE",
            "OK",
            "PRIVATE_LOG_MESSAGE",
          ],
        ],
        imports: [
          {
            book: "BOOK001",
            fileId: importId,
            sha256: sha256(importContent),
            content: importContent,
          },
        ],
        removedLogs: [
          {
            book: "BOOK001",
            fileId: logId,
            sha256: sha256(logContent),
            content: logContent,
          },
        ],
      });
      await op("maintenance", { enabled: false });
      await importLegacyLocal(db, data, options);
      await op("maintenance", { enabled: true });
      await check(
        "root cannot be replaced under an existing library",
        async () => {
          const request = randomUUID();
          await assert.rejects(
            configureRoot(
              service,
              owner,
              {
                requestId: request,
                revision: (await op("status")).revision,
                kind: "create",
                id: "root",
                name: "Wrong root",
              },
              {},
              factory,
            ),
          );
          assert.equal((await op("status")).rootId, root);
        },
      );
      await check(
        "missing FILE manifest or credentials reject and roll back the entire transfer",
        async () => {
          await assert.rejects(
            reconcileLegacyLocal(db, data, options, {
              ...state(),
              imports: [],
            }),
          );
          await assert.rejects(
            reconcileLegacyLocal(db, data, options, {
              ...state(),
              scriptState: { SITE_COOKIES: "NEVER_IMPORT" },
            }),
          );
          assert.equal(
            (
              await db.query(
                "select count(*)::int n from private.legacy_transfers",
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await db.query(
                "select count(*)::int n from private.legacy_archives",
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await check(
        "CONFIG, owner dates, FILE checkpoint, queue, LOG and removed log are transferred without secrets in public reports",
        async () => {
          const out = await reconcileLegacyLocal(db, data, options, state());
          assert.equal(out.imports, 1);
          assert.equal(out.analysisJobs, 2);
          assert.equal(out.legacyLogRows, 1);
          assert.equal(out.removedChapters, 1);
          assert(!JSON.stringify(out).includes("PRIVATE_"));
          assert.equal(
            (
              await db.query(
                "select count(*)::int n from public.jobs where kind='ANALYZE' and status in ('paused','failed')",
              )
            ).rows[0].n,
            2,
          );
          assert.equal(
            (
              await db.query(
                "select legacy_updated_at from public.chapters where file_id=$1",
                [fileId],
              )
            ).rows[0].legacy_updated_at.toISOString(),
            "2026-10-08T10:23:45.000Z",
          );
          assert.equal(
            (
              await db.query(
                "select value->>'BATCH_SIZE' v from public.app_settings where key='download'",
              )
            ).rows[0].v,
            "2",
          );
          assert.equal(
            (
              await db.query(
                "select content from private.legacy_archives where kind='LOG'",
              )
            ).rows[0].content[0][5],
            "PRIVATE_LOG_MESSAGE",
          );
        },
      );
      await check(
        "reconcile rerun retains counts/IDs; private-state change fails",
        async () => {
          assert.equal(
            (await reconcileLegacyLocal(db, data, options, state())).repeated,
            true,
          );
          const changed = state();
          changed.scriptState.DB_ID = "changed";
          await assert.rejects(
            reconcileLegacyLocal(db, data, options, changed),
          );
          assert.equal(
            (
              await db.query(
                "select count(*)::int n from public.removed_chapters",
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await mkdir(dir + "/raw");
      const files: Record<string, { path: string; sha256: string }> = {};
      for (const [id, b] of f.bodies) {
        await writeFile(dir + "/raw/" + id, b);
        files[id] = { path: id, sha256: sha256(b) };
      }
      await check(
        "verified local chapter bytes register only matching ownership and preserve owner progress",
        async () => {
          const out = await verifyAndRegisterLocalFiles(
            db,
            data,
            options,
            dir + "/raw",
            files,
          );
          assert.equal(out.checked, 1);
          assert.equal(out.liveDriveAccessVerified, false);
          assert.equal(
            (
              await db.query(
                "select user_id,ratio from public.reading_progress",
              )
            ).rows[0].user_id,
            owner,
          );
          await withOperation(db, owner, "review-test", async () => {
            await db.query("select public.review_legacy_book($1,$2,$3)", [
              owner,
              migrationId("book", "BOOK001"),
              prepareImport(data, options).checksum,
            ]);
          });
        },
      );
      await check(
        "reads remain available while progress/metadata mutation is blocked",
        async () => {
          await withOperation(db, owner, "publish-test", async () => {
            await db.query("update public.books set visibility='published'");
          });
          assert.equal(
            (await db.query("select public.app_library($1) v", [reader]))
              .rows[0].v.total,
            1,
          );
          await assert.rejects(
            db.query("update public.reading_progress set ratio=.7"),
            { code: "55000" },
          );
          assert.equal(
            (
              await db.query("select public.app_reader_resource($1,$2,$3) v", [
                reader,
                migrationId("book", "BOOK001"),
                migrationId("chapter", "BOOK001:1"),
              ])
            ).rows[0].v.fileId,
            fileId,
          );
        },
      );
      let backup: any;
      await check(
        "full metadata/content backup rejects missing files and produces private checksummed snapshot",
        async () => {
          await assert.rejects(
            createLocalBackup(db, url.href, dir + "/missing", dir + "/raw", {}),
          );
          backup = await createLocalBackup(
            db,
            url.href,
            dir + "/backup",
            dir + "/raw",
            files,
          );
          assert.equal(Object.keys(backup.files).length, 3);
          assert(backup.tables["private.legacy_archives"]);
        },
      );
      await check(
        "restore creates another maintenance database with original metadata and every content hash",
        async () => {
          const out = await restoreLocalBackup(original, dir + "/backup");
          restored.push(out.database);
          const u = new URL(original);
          u.pathname = "/" + out.database;
          const rp = localPool(u.href);
          try {
            assert.equal(
              (await rp.query("select author from public.books")).rows[0]
                .author,
              data.BOOKS[0][10],
            );
            assert.equal(
              (
                await rp.query(
                  "select maintenance from private.runtime_control",
                )
              ).rows[0].maintenance,
              true,
            );
            assert.equal(
              (
                await rp.query(
                  "select has_table_privilege('authenticated','private.legacy_archives','select') v",
                )
              ).rows[0].v,
              false,
            );
          } finally {
            await rp.end();
          }
        },
      );
      await check(
        "corrupted content or dump cannot be restored and never overwrites source",
        async () => {
          const path = dir + "/backup/files/" + fileId + ".bin";
          await writeFile(path, "corrupt");
          await assert.rejects(restoreLocalBackup(original, dir + "/backup"));
          await writeFile(path, body);
          const oldDump = await readFile(dir + "/backup/database.dump");
          await writeFile(dir + "/backup/database.dump", "corrupt");
          await assert.rejects(restoreLocalBackup(original, dir + "/backup"));
          await writeFile(dir + "/backup/database.dump", oldDump);
          assert.equal(
            (await db.query("select count(*)::int n from public.books")).rows[0]
              .n,
            1,
          );
        },
      );
      const target = structuredClone(data);
      target.BOOKS[0][10] = "Tác giả đã cập nhật";
      target.BOOKS[0][6] = 0;
      target.CHAPTERS.shift();
      target.CHAPTERS.push([
        "BOOK001",
        3,
        "Bổ sung",
        "",
        "PENDING",
        "",
        0,
        "",
        "09/10/2026 00:05:00",
        "Phần một",
        "Quyển một",
        "3",
      ]);
      importContent = JSON.stringify([
        {
          num: 2,
          title: "Tiếp theo",
          body: "Nội dung chương hai tự viết.",
          part: "Phần một",
          vol: "Quyển một",
          dnum: 2,
          marked: true,
        },
        {
          num: 3,
          title: "Bổ sung",
          body: "Nội dung chương ba bổ sung.",
          part: "Phần một",
          vol: "Quyển một",
          dnum: 3,
          marked: true,
        },
      ]);
      await f.drive.putText(bookFolder, "_import.json", importContent, 2);
      target.files = inventory();
      const after = { ...options, progress: [] },
        pair = { before: options, after },
        plan = planLegacyDelta(data, target, pair);
      await check(
        "delta is tied to reviewed plan and exact backup; wrong approval changes nothing",
        async () => {
          await assert.rejects(
            applyLegacyDeltaLocal(
              db,
              data,
              target,
              pair,
              "0".repeat(64),
              dir + "/backup",
            ),
          );
          assert.equal(
            (await db.query("select author from public.books")).rows[0].author,
            data.BOOKS[0][10],
          );
        },
      );
      await check(
        "native edits after backup prevent delta rather than overwrite them",
        async () => {
          await withOperation(db, owner, "temporary-edit", async () => {
            await db.query("update public.books set author='Native edit'");
          });
          await assert.rejects(
            applyLegacyDeltaLocal(
              db,
              data,
              target,
              pair,
              plan.planHash,
              dir + "/backup",
            ),
          );
          await withOperation(db, owner, "undo-test-edit", async () => {
            await db.query("update public.books set author=$1", [
              data.BOOKS[0][10],
            ]);
          });
        },
      );
      // Even an undone edit changes fencing/audit. Produce a fresh snapshot to acknowledge that state.
      await createLocalBackup(
        db,
        url.href,
        dir + "/backup2",
        dir + "/raw",
        files,
      );
      await check(
        "metadata-only delta preserves IDs/files, archives removal, resets dangling progress and requires review",
        async () => {
          const count = f.files.size,
            out = await applyLegacyDeltaLocal(
              db,
              data,
              target,
              pair,
              plan.planHash,
              dir + "/backup2",
            );
          assert.equal(out.repeated, false);
          assert.equal(f.files.size, count);
          assert.equal(f.files.get(fileId)!.trashed, false);
          assert.equal(
            (await db.query("select chapter_id from public.reading_progress"))
              .rows[0].chapter_id,
            null,
          );
          assert.equal(
            (await db.query("select count(*)::int n from public.chapters"))
              .rows[0].n,
            2,
          );
          assert.equal(
            (
              await db.query(
                "select reviewed_at from private.legacy_book_review",
              )
            ).rows[0].reviewed_at,
            null,
          );
          assert.equal(
            (await db.query("select id from public.chapters where order_key=2"))
              .rows[0].id,
            migrationId("chapter", "BOOK001:2"),
          );
        },
      );
      await check(
        "delta rerun is idempotent and no old worker lease is reused",
        async () => {
          assert.equal(
            (
              await applyLegacyDeltaLocal(
                db,
                data,
                target,
                pair,
                plan.planHash,
                dir + "/backup2",
              )
            ).repeated,
            true,
          );
          assert.equal(
            (
              await db.query(
                "select count(*)::int n from public.jobs where lease_owner is not null",
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await check(
        "post-delta reconcile deduplicates LOG/queue/removed-log and loads updated FILE manifest",
        async () => {
          await reconcileLegacyLocal(db, target, after, state());
          await verifyAndRegisterLocalFiles(
            db,
            target,
            after,
            dir + "/raw",
            files,
          );
          assert.equal(
            (
              await db.query(
                "select count(*)::int n from public.audit_logs where action='LEGACY_LOG'",
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (
              await db.query(
                "select count(*)::int n from public.jobs where kind='ANALYZE'",
              )
            ).rows[0].n,
            2,
          );
          await withOperation(db, owner, "review-target", async () => {
            await db.query("select public.review_legacy_book($1,$2,$3)", [
              owner,
              migrationId("book", "BOOK001"),
              prepareImport(target, after).checksum,
            ]);
          });
        },
      );
      await op("maintenance", { enabled: false });
      await check(
        "reconciled FILE resumes to DONE without HTTP and removes temp only after completion",
        async () => {
          const b = migrationId("book", "BOOK001");
          await db.query(
            "select public.app_download($1,'start',jsonb_build_object('id',$2::text))",
            [owner, b],
          );
          await runWorkflows(db, {
            rootId: root,
            owner: "synthetic-owner",
            drive: f.drive,
            http: {
              async get() {
                throw Error("FILE must never fetch HTTP");
              },
            },
            validateUrl: async () => {},
            maxItems: 5,
            maxMs: 10000,
          });
          assert.equal(
            (
              await db.query(
                "select count(*)::int n from public.chapters where status='DONE'",
              )
            ).rows[0].n,
            2,
          );
          assert.equal(f.files.get(importId)!.trashed, true);
          assert.equal(
            (
              await db.query(
                "select count(*)::int n from public.drive_resources where kind='IMPORT'",
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await check(
        "alerts include failed jobs/sync and unreviewed books without raw error text",
        async () => {
          const out = await op("status");
          assert.equal(out.alerts.failedJobs, 1);
          assert(!JSON.stringify(out).includes("PRIVATE_"));
        },
      );
      await op("maintenance", { enabled: true });
      await check(
        "preflight verifies every schema checksum and fails readiness on unresolved alerts",
        async () => {
          const result = await localPreflight(db, owner);
          assert.equal(result.schemaVerified, true);
          assert.equal(result.localReady, false);
          assert.equal(result.gates.productionActivated, false);
        },
      );
      await check(
        "rollback restores snapshot metadata and keeps old file bytes independently of newer Drive changes",
        async () => {
          const result = await restoreLocalBackup(original, dir + "/backup");
          restored.push(result.database);
          const u = new URL(original);
          u.pathname = "/" + result.database;
          const p = localPool(u.href);
          try {
            assert.equal(
              (await p.query("select author from public.books")).rows[0].author,
              data.BOOKS[0][10],
            );
            assert.equal(
              (await p.query("select chapter_id from public.reading_progress"))
                .rows[0].chapter_id,
              migrationId("chapter", "BOOK001:1"),
            );
            assert.equal(
              (
                await p.query(
                  "select status from public.chapters where order_key=2",
                )
              ).rows[0].status,
              "PENDING",
            );
            assert.equal(
              await readFile(
                dir + "/backup/files/" + importId + ".bin",
                "utf8",
              ),
              JSON.parse(await readFile(dir + "/backup/manifest.json", "utf8"))
                .files[importId]
                ? JSON.stringify([
                    {
                      num: 2,
                      title: "Tiếp theo",
                      body: "Nội dung chương hai tự viết.",
                      part: "Phần một",
                      vol: "Quyển một",
                      dnum: 2,
                      marked: true,
                    },
                  ])
                : "missing",
            );
          } finally {
            await p.end();
          }
        },
      );
      await mkdir(".local-library/phase9", { recursive: true });
      await writeFile(
        ".local-library/phase9/operations-result.json",
        JSON.stringify(
          {
            date: "2026-10-09",
            synthetic: true,
            checks: passed,
            metadataBackupRestored: true,
            fileBackupVerified: true,
            deltaRehearsed: true,
            fileResumeRehearsed: true,
            cloudActivated: false,
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
      console.log(
        passed +
          "/" +
          passed +
          " operations SQL/backup/delta/executor checks passed",
      );
    } finally {
      db.release();
      other.release();
    }
  } finally {
    process.env.DATABASE_URL = original;
    await pool?.end();
    for (const n of restored)
      await admin.query("drop database if exists " + n + " with (force)");
    await admin.query("drop database if exists " + name + " with (force)");
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
}
main().catch((e: unknown) => {
  console.error(
    e instanceof assert.AssertionError
      ? e.message
      : "Operations SQL check failed: " +
          (e as { code?: string; message?: string }).code +
          " " +
          (e as Error).message,
  );
  process.exitCode = 1;
});

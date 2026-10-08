import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { importLegacyLocal } from "../migration/import-local";
import { migrationId } from "../../packages/domain/src/migration";
import { readStoredChapter } from "../../packages/infrastructure/src/reader-storage";
import type { AuthServices } from "../../packages/infrastructure/src/auth";
import { runWorkflows } from "../../packages/infrastructure/src/workflows";
import { memoryDrive } from "../../tests/phase-5/fixture";

// Fixed BEFORE execution. Synthetic local acceptance only; no extrapolation to cloud quotas/cost.
export const thresholds = {
  importMs: 120000,
  pageP95Ms: 500,
  readMs: 500,
  rssMiB: 512,
  queueMs: 30000,
  warmFileReads: 0,
};
function synthetic(books: number, chaptersPerBook: number, mixed = false) {
  const BOOKS: any[][] = [],
    CHAPTERS: any[][] = [],
    files: any[] = [{ id: "root" }],
    skipped: string[] = [];
  const states = [
    "ANALYZED",
    "IDLE",
    "COMPLETED",
    "DOWNLOADING",
    "PAUSED",
    "READY",
    "ERROR",
  ];
  for (let b = 0; b < books; b++) {
    const id = "LOAD" + String(b).padStart(4, "0"),
      folder = "folder-" + id,
      source = mixed ? ["WEB", "FILE", "FOLDER"][b % 3] : "FILE";
    files.push({ id: folder, parents: ["root"] });
    let done = 0,
      error = 0;
    for (let n = 0; n < chaptersPerBook; n++) {
      const order = n === 0 ? -0.5 : n,
        status = mixed ? ["DONE", "PENDING", "ERROR"][n % 3] : "DONE",
        file =
          status === "DONE" && !(mixed && n === 0)
            ? "file-" + id + "-" + n
            : "";
      if (status === "DONE") done++;
      if (status === "ERROR") error++;
      if (file) files.push({ id: file, parents: [folder] });
      else if (status === "DONE") skipped.push(id + ":" + order);
      CHAPTERS.push([
        id,
        order,
        "Nội dung " + n,
        source === "WEB" ? "https://source.test/" + id + "/" + n : "",
        status,
        file,
        0,
        status === "ERROR" ? "NO_CONTENT" : "",
        "08/10/2026",
        "Phần I",
        "Quyển I",
        n === 0 ? "*" : n === 1 ? "1-2" : String(n),
      ]);
    }
    BOOKS.push([
      id,
      "Sách thử tải " + id,
      source === "WEB" ? "https://source.test/" + id + "/" : "",
      source,
      folder,
      chaptersPerBook,
      done,
      error,
      mixed ? states[b % states.length] : "COMPLETED",
      "08/10/2026",
      "Tác giả giả lập",
      "Phiêu lưu",
      "Chương",
    ]);
  }
  return {
    data: {
      schemaVersion: 1,
      BOOKS,
      CHAPTERS,
      files,
      properties: { ROOT_FOLDER_ID: "root" },
      inventoryComplete: true,
    },
    skipped,
  };
}
export async function runPhase8Load(
  db: PoolClient,
  owner: string,
  reader: string,
) {
  const measurements: any[] = [],
    startRss = process.memoryUsage().rss;
  let peakRss = startRss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 100);
  try {
    for (const [books, chapters, mixed] of [
      [14, 9, true],
      [100, 200, false],
      [1, 20000, false],
    ] as const) {
      await db.query(
        "truncate public.books,public.genres,public.migration_runs,public.audit_logs restart identity cascade",
      );
      await db.query("truncate private.reader_cache");
      const f = synthetic(books, chapters, mixed),
        options = {
          sourceKey: `synthetic-${books}-${chapters}`,
          ownerId: owner,
          ownerEmail: "owner@example.test",
          driveSubject: "synthetic-owner",
          skippedChapterKeys: f.skipped,
        };
      const start = performance.now();
      await importLegacyLocal(db, f.data, options);
      const importMs = performance.now() - start;
      assert(
        importMs < thresholds.importMs,
        `Import threshold exceeded: ${importMs} ms`,
      );
      assert.equal(
        (await db.query("select count(*)::int n from public.chapters")).rows[0]
          .n,
        books * chapters,
      );
      const rerun = performance.now();
      assert.equal(
        (await importLegacyLocal(db, f.data, options)).repeated,
        true,
      );
      const rerunMs = performance.now() - rerun;
      // Publication/resource verification ONLY for generated in-memory fixtures.
      await db.query(
        "update public.books set visibility='published';update public.drive_resources set sync_status='synced',content_hash=repeat('a',64)",
      );
      const pages: number[] = [],
        ids = new Set<string>(),
        book = migrationId("book", "LOAD0000");
      const total = (
        await db.query("select public.app_reader_chapters($1,$2,0,200) v", [
          reader,
          book,
        ])
      ).rows[0].v.total;
      for (let offset = 0; offset < total; offset += 200) {
        const s = performance.now(),
          page = (
            await db.query(
              "select public.app_reader_chapters($1,$2,$3,200) v",
              [reader, book, offset],
            )
          ).rows[0].v;
        pages.push(performance.now() - s);
        for (const c of page.chapters) {
          assert(!ids.has(c.id));
          ids.add(c.id);
        }
      }
      assert.equal(ids.size, total);
      for (let offset = 0; offset < books; offset += 24) {
        const s = performance.now(),
          page = (
            await db.query("select public.app_library($1,'','name',$2) v", [
              reader,
              offset,
            ])
          ).rows[0].v;
        pages.push(performance.now() - s);
        assert.equal(page.total, books);
        assert(page.books.length <= 24);
      }
      const pageP95Ms = pages.sort((a, b) => a - b)[
        Math.ceil(pages.length * 0.95) - 1
      ];
      assert(
        pageP95Ms < thresholds.pageP95Ms,
        `Pagination threshold exceeded: ${pageP95Ms} ms`,
      );
      let fileReads = 0;
      const chapter = (
        await db.query(
          "select id from public.chapters where book_id=$1 and status='DONE' and not is_skipped order by order_key limit 1",
          [book],
        )
      ).rows[0].id;
      const service: AuthServices = {
        async verify() {
          throw Error("Unused");
        },
        async rpc(r, a) {
          if (r === "app_reader_resource")
            return (
              await db.query("select public.app_reader_resource($1,$2,$3) v", [
                a.actor,
                a.target_book,
                a.target_chapter,
              ])
            ).rows[0].v;
          if (r === "app_reader_cache") {
            await db.query("select public.app_reader_cache($1,$2,$3,$4,$5)", [
              a.actor,
              a.target_book,
              a.target_chapter,
              a.expected_key,
              a.new_value,
            ]);
            return null;
          }
          throw Error("Unexpected RPC");
        },
      };
      const storage = {
        async readText() {
          fileReads++;
          return (
            "Chương 1: Nội dung\n\n" +
            "Văn bản mẫu gốc dùng đo tải local. ".repeat(500)
          );
        },
        async readBytes() {
          throw Error("Unused");
        },
      };
      const cold = performance.now(),
        content = await readStoredChapter(
          service,
          storage,
          reader,
          book,
          chapter,
        ),
        coldReadMs = performance.now() - cold;
      const before = fileReads,
        warm = performance.now();
      assert.deepEqual(
        await readStoredChapter(service, storage, reader, book, chapter),
        content,
      );
      const warmReadMs = performance.now() - warm;
      assert(
        coldReadMs < thresholds.readMs && warmReadMs < thresholds.readMs,
        `Read threshold exceeded: ${coldReadMs}/${warmReadMs} ms`,
      );
      assert.equal(fileReads - before, thresholds.warmFileReads);
      assert.equal(before, 1, "Cold read must actually read the mock file");
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      measurements.push({
        books,
        chapters: books * chapters,
        mixed,
        importMs,
        rerunMs,
        pageCount: pages.length,
        pageP95Ms,
        coldReadMs,
        warmReadMs,
        coldMockFileReads: before,
        warmMockFileReads: fileReads - before,
      });
      console.log(`LOAD PASS ${books} books / ${books * chapters} chapters`);
    }
    await db.query(
      "truncate public.books,public.genres,public.migration_runs,public.audit_logs restart identity cascade",
    );
    await db.query(
      'update public.app_settings set value=value||\'{"DELAY_MS":0,"BATCH_SIZE":5,"AUTO_RESUME":true}\' where key=\'download\'',
    );
    const f = memoryDrive();
    let mockFetches = 0;
    for (let n = 0; n < 2; n++) {
      const id = randomUUID(),
        folder = await f.drive.folder("root", "Queue " + n);
      await db.query(
        "insert into public.books(id,name,normalized_name,source_type,source_url,folder_id) values($1,$2,$2,'WEB',$3,$4)",
        [id, "Queue " + n, "https://source.test/queue/" + n, folder],
      );
      for (let c = 1; c <= 10; c++)
        await db.query(
          "insert into public.chapters(book_id,legacy_order,order_key,title,source_url) values($1,$2,$2,$3,$4)",
          [id, c, "Nội dung " + c, "https://source.test/queue/" + n + "/" + c],
        );
      await db.query(
        "select public.app_download($1,'start',jsonb_build_object('id',$2::text))",
        [owner, id],
      );
    }
    const queueStart = performance.now();
    let passes = 0;
    while (
      passes < 8 &&
      (
        await db.query(
          "select count(*)::int n from public.chapters where status<>'DONE'",
        )
      ).rows[0].n
    ) {
      await db.query("update public.jobs set next_run_at=now()");
      await runWorkflows(db, {
        rootId: "root",
        owner: "synthetic-owner",
        drive: f.drive,
        http: {
          async get(raw) {
            mockFetches++;
            return {
              finalUrl: raw,
              body:
                '<h1>Chương 1: Nội dung</h1><div id="chapter-content">' +
                "Văn bản nguyên gốc giả lập. ".repeat(20) +
                "</div>",
            };
          },
        },
        validateUrl: async () => {},
        maxItems: 5,
        maxMs: 10000,
      });
      passes++;
    }
    const queueMs = performance.now() - queueStart,
      done = (
        await db.query(
          "select count(*)::int n from public.chapters where status='DONE'",
        )
      ).rows[0].n;
    assert.equal(done, 20);
    assert(queueMs < thresholds.queueMs);
    assert.equal(mockFetches, 20);
    assert(
      peakRss / 1024 / 1024 < thresholds.rssMiB,
      `RSS threshold exceeded: ${peakRss / 1024 / 1024} MiB`,
    );
    const report = {
      synthetic: true,
      environment:
        "Local PostgreSQL + memory Drive/HTTP; no Google/Netlify/Supabase cloud requests",
      thresholds,
      passed: true,
      measurements,
      peakProcessRssMiB: peakRss / 1024 / 1024,
      queue: {
        done,
        passes,
        queueMs,
        chaptersPerSecond: done / (queueMs / 1000),
        mockFetches,
      },
      cloud: {
        driveQuota: null,
        netlifyCompute: null,
        supabaseEgress: null,
        cost: null,
        reason:
          "Deferred until code closure; local timings do not establish cloud capacity or pricing",
      },
    };
    await writeFile(
      "docs/phase-8/load-result.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    return report;
  } finally {
    clearInterval(sampler);
  }
}

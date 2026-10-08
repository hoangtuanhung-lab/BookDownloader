import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localPool } from "../../packages/infrastructure/src/database";
import { migrate } from "./migrate";
import { runWorkflows } from "../../packages/infrastructure/src/workflows";
import {
  writerLock,
  writerUnlock,
} from "../../packages/infrastructure/src/download-runtime";
import { memoryDrive } from "../../tests/phase-5/fixture";
import { AppError } from "../../packages/contracts/src/index";
import { SourceResponseError } from "../../packages/infrastructure/src/source-http";
import { handleApi } from "../../netlify/functions/api";
const original =
    process.env.DATABASE_URL ||
    "postgresql://postgres:local-only-password@127.0.0.1:55432/bookdownloader",
  admin = localPool(original),
  name = "book_download_test_" + randomUUID().replaceAll("-", ""),
  url = new URL(original);
url.pathname = "/" + name;
let pool: ReturnType<typeof localPool> | undefined,
  passed = 0;
const actor = "a7000000-0000-4000-8000-000000000001",
  reader = "a7000000-0000-4000-8000-000000000002";
async function check(label: string, fn: () => Promise<void>) {
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
    for (const id of [actor, reader])
      await db.query(
        `insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data) values($1,'synthetic@gmail.com',now(),'{"provider":"google"}')`,
        [id],
      );
    await db.query(
      "insert into public.user_permissions values($1,'download'),($1,'manage'),($1,'admin'),($2,'read') on conflict do nothing",
      [actor, reader],
    );
    const f = memoryDrive();
    let fetches = 0;
    const body =
      "Đây là nội dung tự viết dùng kiểm thử tải chương và khôi phục an toàn. ".repeat(
        4,
      );
    const options = {
      rootId: "root",
      owner: "synthetic-owner",
      drive: f.drive,
      http: {
        async get(raw: string) {
          fetches++;
          return {
            body: `<h1>Chương ${raw.match(/\d+$/)?.[0] || 1}: Nội dung</h1><div id="chapter-content">${body}</div>`,
            finalUrl: raw,
          };
        },
      },
      validateUrl: async () => {},
      maxMs: 10000,
    };
    const rpc = async (operation: string, input: any = {}) =>
      (
        await db.query("select public.app_download($1,$2,$3) as value", [
          actor,
          operation,
          input,
        ])
      ).rows[0].value;
    const cfg = async (value: any) => {
      await db.query(
        "update public.app_settings set value=value||$1::jsonb where key='download'",
        [JSON.stringify(value)],
      );
    };
    await cfg({ DELAY_MS: 0, BATCH_SIZE: 2 });
    async function create(source = "WEB", count = 2) {
      const id = randomUUID(),
        folder = await f.drive.folder("root", "Book " + id);
      await db.query(
        "insert into public.books(id,name,normalized_name,source_url,source_type,folder_id) values($1,$2,$2,$3,$4,$5)",
        [
          id,
          "Book " + id,
          source === "WEB" ? "https://source.test/" + id + "/" : "",
          source,
          folder,
        ],
      );
      const ids: string[] = [];
      for (let n = 1; n <= count; n++) {
        const c = randomUUID();
        ids.push(c);
        await db.query(
          "insert into public.chapters(id,book_id,order_key,legacy_order,display_number,title,source_url) values($1,$2,$3::numeric,$3::numeric,$3::numeric::text,$4,$5)",
          [
            c,
            id,
            n,
            "Chương " + n,
            source === "WEB"
              ? "https://source.test/" + id + "/chuong-" + n
              : "",
          ],
        );
      }
      return { id, folder, ids };
    }
    const get = async (id: string) =>
      (await db.query("select * from public.books where id=$1", [id])).rows[0];
    const chapter = async (id: string) =>
      (await db.query("select * from public.chapters where id=$1", [id]))
        .rows[0];
    const job = async (id: string) =>
      (
        await db.query(
          "select * from public.jobs where book_id=$1 and kind in ('WEB_DOWNLOAD','FILE_IMPORT') order by created_at desc limit 1",
          [id],
        )
      ).rows[0];
    const force = async (id: string) => {
      await db.query(
        "update public.jobs set next_run_at=now() where book_id=$1",
        [id],
      );
    };
    await check(
      "download APIs deny read-only, enforce origin and reject spoof actor",
      async () => {
        const services = (id: string): any => ({
          verify: async () => ({
            id,
            email: "synthetic@gmail.com",
            email_confirmed_at: "2026-10-08",
            app_metadata: { provider: "google" },
          }),
          rpc: async (fn: string, args: any) => {
            const vals =
              fn === "app_me"
                ? [args.actor]
                : fn === "app_download"
                  ? [args.actor, args.operation, args.input]
                  : [args.actor, args.new_value];
            return (
              await db
                .query(
                  `select public.${fn}(${vals.map((_, i) => "$" + (i + 1)).join(",")}) as value`,
                  vals,
                )
                .catch((e) => {
                  console.error("RPC fixture:", e.message);
                  throw e;
                })
            ).rows[0].value;
          },
        });
        const request = (
          path: string,
          method = "GET",
          data?: any,
          origin = "http://localhost:8888",
        ) =>
          new Request("http://localhost:8888/api" + path, {
            method,
            headers: {
              Authorization: "Bearer synthetic",
              Origin: origin,
              "Content-Type": "application/json",
            },
            ...(data ? { body: JSON.stringify(data) } : {}),
          });
        assert.equal(
          (
            await handleApi(
              request("/download"),
              {},
              undefined,
              services(reader),
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await handleApi(
              request(
                "/download/actions",
                "POST",
                { action: "start-all" },
                "https://other.test",
              ),
              { APP_ORIGINS: "http://localhost:8888" },
              undefined,
              services(actor),
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await handleApi(
              request("/download/actions", "POST", {
                action: "start-all",
                actor: reader,
              }),
              { APP_ORIGINS: "http://localhost:8888" },
              undefined,
              services(actor),
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await handleApi(
              request("/download"),
              {},
              undefined,
              services(actor),
            )
          ).status,
          200,
        );
      },
    );
    let web: Awaited<ReturnType<typeof create>>;
    await check(
      "ANALYZED stays held; explicit start writes WEB files, info, mapping and exact counters",
      async () => {
        web = await create();
        await runWorkflows(db, options);
        assert.equal(fetches, 0);
        await rpc("start", { id: web.id });
        await runWorkflows(db, options);
        assert.equal((await get(web.id)).download_status, "DONE");
        for (const id of web.ids) {
          const c = await chapter(id);
          assert.equal(c.status, "DONE");
          assert(f.bodies.get(c.file_id)!.toString().includes(body.trim()));
          assert.equal(
            (
              await db.query(
                "select owner_subject from public.drive_resources where chapter_id=$1",
                [id],
              )
            ).rows[0].owner_subject,
            options.owner,
          );
        }
        const b = (await rpc("list")).books.find((b: any) => b.id === web.id);
        assert.equal(b.total, 2);
        assert.equal(b.done, 2);
        assert.equal(b.pending, 0);
        assert(
          [...f.files.values()].some(
            (x) => x.name === "info.txt" && x.parents[0] === web.folder,
          ),
        );
      },
    );
    await check(
      "AUTO_RESUME false pauses after batch; explicit continue finishes without rewriting DONE",
      async () => {
        await cfg({ AUTO_RESUME: false, BATCH_SIZE: 1 });
        const b = await create();
        await rpc("start", { id: b.id });
        await runWorkflows(db, options);
        assert.equal((await get(b.id)).download_status, "PAUSED");
        const first = await chapter(b.ids[0]),
          before = fetches;
        await runWorkflows(db, options);
        assert.equal(fetches, before);
        await rpc("start", { id: b.id });
        await runWorkflows(db, options);
        assert.equal((await get(b.id)).download_status, "DONE");
        assert.equal((await chapter(b.ids[0])).file_id, first.file_id);
        await cfg({ AUTO_RESUME: false, BATCH_SIZE: 2 });
        const interrupted = await create("WEB", 3);
        await rpc("start", { id: interrupted.id });
        const http = options.http;
        let throttled = false;
        options.http = {
          async get(raw) {
            if (raw.endsWith("chuong-2") && !throttled) {
              throttled = true;
              throw new SourceResponseError(429, 1000);
            }
            return http.get(raw);
          },
        };
        await runWorkflows(db, options);
        assert.equal((await chapter(interrupted.ids[0])).status, "DONE");
        await force(interrupted.id);
        await runWorkflows(db, options);
        options.http = http;
        assert.equal((await get(interrupted.id)).download_status, "PAUSED");
        assert.equal((await chapter(interrupted.ids[1])).status, "DONE");
        assert.equal((await chapter(interrupted.ids[2])).status, "PENDING");
        await rpc("start", { id: interrupted.id });
        await runWorkflows(db, options);
        assert.equal((await get(interrupted.id)).download_status, "DONE");
        await cfg({ AUTO_RESUME: true, BATCH_SIZE: 2 });
      },
    );
    await check(
      "separate FILE/WEB caps and durable priority/reorder promotion",
      async () => {
        await cfg({ MAX_CONCURRENT: 1, FILE_CONCURRENT: 1, BATCH_SIZE: 1 });
        const a = await create(),
          b = await create(),
          file = await create("FILE");
        const ch = file.ids.map((id, i) => ({
          num: i + 1,
          title: "Chương " + (i + 1),
          body,
        }));
        const temp = await f.drive.putText(
          file.folder,
          "_import.json",
          JSON.stringify(ch),
          1,
        );
        await db.query(
          "insert into public.jobs(kind,book_id,actor_id,dedupe_key,checkpoint) values('FILE_IMPORT',$1,$2,$3,$4)",
          [
            file.id,
            actor,
            "file:" + file.id,
            JSON.stringify({ importId: temp, request: {} }),
          ],
        );
        await db.query(
          "update public.books set download_status='IDLE' where id=$1",
          [file.id],
        );
        await rpc("start", { id: a.id });
        await rpc("start", { id: b.id });
        await rpc("up", { id: b.id });
        await runWorkflows(db, options);
        assert.equal((await chapter(a.ids[0])).status, "PENDING");
        assert.equal((await chapter(b.ids[0])).status, "DONE");
        assert.equal((await chapter(file.ids[0])).status, "DONE");
        assert.equal((await get(a.id)).download_status, "IDLE");
        await runWorkflows(db, options);
        await runWorkflows(db, options);
        await runWorkflows(db, options);
        await cfg({ MAX_CONCURRENT: 2, FILE_CONCURRENT: 2, BATCH_SIZE: 2 });
      },
    );
    await check(
      "two workers compete on same book; unrelated book can progress",
      async () => {
        const a = await create("WEB", 1),
          b = await create("WEB", 1);
        await rpc("start", { id: a.id });
        await rpc("start", { id: b.id });
        assert(await writerLock(db, a.id));
        try {
          const r = await runWorkflows(other, options);
          assert(r.busy);
          assert.equal((await chapter(a.ids[0])).status, "PENDING");
          assert.equal((await chapter(b.ids[0])).status, "DONE");
        } finally {
          await writerUnlock(db, a.id);
        }
        await runWorkflows(db, options);
        assert.equal((await chapter(a.ids[0])).status, "DONE");
      },
    );
    await check(
      "lease expiry reclaims; stale generation cannot commit a created file",
      async () => {
        const b = await create("WEB", 1);
        await rpc("start", { id: b.id });
        const http = options.http;
        options.http = {
          async get(raw) {
            await other.query(
              "update public.jobs set lease_until=now()-interval '1 second' where book_id=$1 and status='running'",
              [b.id],
            );
            return http.get(raw);
          },
        };
        await runWorkflows(db, options);
        assert.equal((await chapter(b.ids[0])).status, "PENDING");
        options.http = http;
        await runWorkflows(db, options);
        assert.equal((await chapter(b.ids[0])).status, "DONE");
        assert(Number((await job(b.id)).lease_epoch) >= 2);
      },
    );
    await check(
      "file written before DB failure recovers by hash without duplicate or repeat HTTP",
      async () => {
        const b = await create("WEB", 1);
        await rpc("start", { id: b.id });
        const put = f.drive.putText.bind(f.drive);
        let crashed = false;
        f.drive.putText = async (parent, name, text, v) => {
          const id = await put(parent, name, text, v);
          if (!crashed && name.startsWith("Chương")) {
            crashed = true;
            throw new AppError("CRASH", 503, "Gián đoạn sau khi tạo file");
          }
          return id;
        };
        await runWorkflows(db, options);
        const before = fetches;
        assert.equal((await chapter(b.ids[0])).status, "PENDING");
        assert.equal((await job(b.id)).status, "queued");
        f.drive.putText = put;
        await force(b.id);
        await runWorkflows(db, options);
        assert.equal(fetches, before);
        assert.equal((await chapter(b.ids[0])).status, "DONE");
        assert.equal(
          [...f.files.values()].filter(
            (x) => x.parents[0] === b.folder && x.name.startsWith("Chương"),
          ).length,
          1,
        );
      },
    );
    await check(
      "pause during HTTP is immediate and fences DB commit; continue resumes",
      async () => {
        const b = await create("WEB", 1);
        await rpc("start", { id: b.id });
        const http = options.http;
        options.http = {
          async get(raw) {
            await other.query("select public.app_download($1,'pause',$2)", [
              actor,
              { id: b.id },
            ]);
            return http.get(raw);
          },
        };
        await runWorkflows(db, options);
        assert.equal((await get(b.id)).download_status, "PAUSED");
        assert.equal((await chapter(b.ids[0])).status, "PENDING");
        assert.equal((await job(b.id)).status, "paused");
        options.http = http;
        await rpc("start", { id: b.id });
        await runWorkflows(db, options);
        assert.equal((await chapter(b.ids[0])).status, "DONE");
      },
    );
    await check(
      "cancel during Drive upload keeps orphan file but never registers; explicit resume recovers",
      async () => {
        const b = await create("WEB", 1);
        await rpc("start", { id: b.id });
        const put = f.drive.putText.bind(f.drive);
        let once = true;
        f.drive.putText = async (parent, name, text, v) => {
          const id = await put(parent, name, text, v);
          if (name.startsWith("Chương") && once) {
            once = false;
            await other.query("select public.app_download($1,'cancel',$2)", [
              actor,
              { id: b.id },
            ]);
          }
          return id;
        };
        await runWorkflows(db, options);
        assert.equal((await chapter(b.ids[0])).file_id, null);
        assert.equal((await job(b.id)).status, "cancelled");
        f.drive.putText = put;
        await rpc("start", { id: b.id });
        await runWorkflows(db, options);
        assert.equal((await chapter(b.ids[0])).status, "DONE");
        assert.equal(
          [...f.files.values()].filter(
            (x) => x.parents[0] === b.folder && x.name.startsWith("Chương"),
          ).length,
          1,
        );
      },
    );
    await check(
      "delete book during HTTP cancels lease and cannot resurrect book or chapters",
      async () => {
        const b = await create("WEB", 1);
        await rpc("start", { id: b.id });
        const http = options.http;
        options.http = {
          async get(raw) {
            await other.query("select public.app_manage($1,'delete',$2)", [
              actor,
              { id: b.id, version: 1, trash: true },
            ]);
            return http.get(raw);
          },
        };
        await runWorkflows(db, options);
        options.http = http;
        assert((await get(b.id)).deleted_at);
        assert.equal((await chapter(b.ids[0])).file_id, null);
        assert.equal((await job(b.id)).status, "cancelled");
        await runWorkflows(db, options);
        assert(f.files.get(b.folder)!.trashed);
      },
    );
    await check(
      "chapter deletion during HTTP never reinserts chapter or changes remaining numbers",
      async () => {
        const b = await create("WEB", 2);
        await rpc("start", { id: b.id });
        const http = options.http;
        let once = true;
        options.http = {
          async get(raw) {
            if (once) {
              once = false;
              await other.query(
                "select public.app_manage($1,'chapter-action',$2)",
                [
                  actor,
                  { id: b.id, chapter: b.ids[0], version: 1, action: "delete" },
                ],
              );
            }
            return http.get(raw);
          },
        };
        await runWorkflows(db, options);
        options.http = http;
        assert.equal(await chapter(b.ids[0]), undefined);
        await runWorkflows(db, options);
        assert.equal((await chapter(b.ids[1])).display_number, "2");
        assert.equal((await chapter(b.ids[1])).status, "DONE");
      },
    );
    await check(
      "metadata edit during HTTP fences old result and sync writes latest four-section info",
      async () => {
        const b = await create("WEB", 1);
        await rpc("start", { id: b.id });
        const http = options.http;
        options.http = {
          async get(raw) {
            await other.query("select public.app_manage($1,'save',$2)", [
              actor,
              {
                items: [
                  {
                    id: b.id,
                    version: 1,
                    name: "Tên mới " + b.id,
                    author: "Mới",
                    genres: ["Nhóm mới"],
                    visibility: "hidden",
                  },
                ],
              },
            ]);
            return http.get(raw);
          },
        };
        await runWorkflows(db, options);
        options.http = http;
        assert.equal((await chapter(b.ids[0])).status, "PENDING");
        await runWorkflows(db, options);
        const c = await chapter(b.ids[0]);
        assert(f.bodies.get(c.file_id)!.toString().startsWith("Tên mới"));
        const info = [...f.files.values()].find(
          (x) => x.name === "info.txt" && x.parents[0] === b.folder,
        )!;
        assert.match(f.bodies.get(info.id)!.toString(), /##Tác giả\nMới/);
        assert.equal(
          (f.bodies.get(info.id)!.toString().match(/^##/gm) || []).length,
          4,
        );
      },
    );
    await check(
      "HTTP 429 Retry-After persists next_run; 403 terminal and retry budget bounded",
      async () => {
        const b = await create("WEB", 1);
        await rpc("start", { id: b.id });
        const http = options.http;
        options.http = {
          async get() {
            throw new SourceResponseError(429, 120000);
          },
        };
        await runWorkflows(db, options);
        let j = await job(b.id);
        assert(new Date(j.next_run_at).getTime() > Date.now() + 100000);
        assert.equal((await chapter(b.ids[0])).retry_count, 1);
        await force(b.id);
        options.http = {
          async get() {
            throw new SourceResponseError(403);
          },
        };
        await runWorkflows(db, options);
        assert.equal((await get(b.id)).download_status, "ERROR");
        assert.equal((await chapter(b.ids[0])).status, "ERROR");
        assert.match((await chapter(b.ids[0])).error_code, /HTTP 403/);
        options.http = http;
        await rpc("retry", { id: b.id });
        await runWorkflows(db, options);
        assert.equal((await get(b.id)).download_status, "DONE");
        const c = await create("WEB", 1);
        await rpc("start", { id: c.id });
        options.http = {
          async get() {
            throw new SourceResponseError(503);
          },
        };
        for (let n = 0; n < 3; n++) {
          await force(c.id);
          await runWorkflows(db, options);
        }
        assert.equal((await chapter(c.ids[0])).retry_count, 3);
        assert.equal((await chapter(c.ids[0])).status, "ERROR");
        options.http = http;
      },
    );
    await check(
      "empty errors are removed only in short bounded runs and removed log survives replay",
      async () => {
        const b = await create("WEB", 4);
        await rpc("start", { id: b.id });
        const http = options.http;
        options.http = {
          async get(raw) {
            if (raw.endsWith("chuong-2") || raw.endsWith("chuong-3"))
              return {
                body: '<div id="chapter-content">ngắn</div>',
                finalUrl: raw,
              };
            return http.get(raw);
          },
        };
        await runWorkflows(db, options);
        assert.equal((await chapter(b.ids[1])).status, "ERROR");
        await runWorkflows(db, options);
        options.http = http;
        assert.equal(await chapter(b.ids[1]), undefined);
        assert.equal(await chapter(b.ids[2]), undefined);
        assert.equal((await chapter(b.ids[3])).display_number, "4");
        assert.equal((await get(b.id)).download_status, "DONE");
        await runWorkflows(db, options);
        const log = [...f.files.values()].find(
          (x) =>
            x.name === "_Chương lỗi đã xóa.txt" && x.parents[0] === b.folder,
        )!;
        assert(log);
        assert(f.bodies.get(log.id)!.toString().includes("Nội dung quá ngắn"));
        assert.equal(
          (
            await db.query(
              "select count(*) from public.removed_chapters where book_id=$1",
              [b.id],
            )
          ).rows[0].count,
          "2",
        );
        await cfg({ BATCH_SIZE: 3 });
        const waves = await create("WEB", 6);
        await rpc("start", { id: waves.id });
        options.http = {
          async get(raw) {
            if (raw.endsWith("chuong-2") || raw.endsWith("chuong-5"))
              return {
                body: '<div id="chapter-content">ngắn</div>',
                finalUrl: raw,
              };
            return http.get(raw);
          },
        };
        await runWorkflows(db, options);
        await runWorkflows(db, options);
        options.http = http;
        await runWorkflows(db, options);
        const waveLog = [...f.files.values()].find(
          (x) =>
            x.name === "_Chương lỗi đã xóa.txt" &&
            x.parents[0] === waves.folder,
        )!;
        const lines = f.bodies.get(waveLog.id)!.toString();
        assert.equal((lines.match(/Nội dung quá ngắn/g) || []).length, 2);
        assert.equal((await get(waves.id)).version, "3");
        await cfg({ BATCH_SIZE: 2 });
      },
    );
    await check(
      "verify missing WEB file resumes; FOLDER reports missing without HTTP job",
      async () => {
        const c = await chapter(web!.ids[0]);
        f.files.get(c.file_id)!.trashed = true;
        await rpc("verify", { id: web!.id });
        await runWorkflows(db, options);
        assert.equal((await chapter(c.id)).status, "PENDING");
        await runWorkflows(db, options);
        assert.equal((await chapter(c.id)).status, "DONE");
        assert.notEqual((await chapter(c.id)).file_id, c.file_id);
        const b = await create("FOLDER", 1);
        const fid = await f.drive.putText(b.folder, "Chương 001.txt", body, 1);
        await db.query(
          "update public.chapters set status='DONE',file_id=$2 where id=$1",
          [b.ids[0], fid],
        );
        await db.query(
          "update public.books set download_status='DONE' where id=$1",
          [b.id],
        );
        f.files.get(fid)!.trashed = true;
        const before = fetches;
        await rpc("verify", { id: b.id });
        await runWorkflows(db, options);
        assert.equal(fetches, before);
        assert.equal((await get(b.id)).download_status, "ERROR");
        await assert.rejects(() => rpc("start", { id: b.id }));
        // Manual add-by-link on FOLDER is a distinct authorized network request,
        // while verify itself still performs no HTTP.
        await db.query("select public.app_manage($1,'chapter-add',$2)", [
          actor,
          {
            id: b.id,
            version: Number((await get(b.id)).version),
            kind: "link",
            order: 2,
            title: "Chương mới",
            part: "",
            volume: "",
            url: "https://source.test/" + b.id + "/chuong-2",
          },
        ]);
        await runWorkflows(db, options);
        const added = (
          await db.query(
            "select * from public.chapters where book_id=$1 and source_url<>''",
            [b.id],
          )
        ).rows[0];
        assert.equal(added.status, "DONE");
        assert.equal(fetches, before + 1);
        assert.equal((await chapter(b.ids[0])).status, "PENDING");
        const wb = await create("WEB", 0);
        await db.query("select public.app_manage($1,'chapter-add',$2)", [
          actor,
          {
            id: wb.id,
            version: 1,
            kind: "link",
            order: 1,
            title: "Thêm URL",
            part: "",
            volume: "",
            url: "https://source.test/" + wb.id + "/chuong-1",
          },
        ]);
        await runWorkflows(db, options);
        assert.equal((await get(wb.id)).download_status, "DONE");
      },
    );
    await check(
      "Drive permission denial preserves chapter/temp and surfaces failed task",
      async () => {
        const b = await create("WEB", 1);
        await rpc("start", { id: b.id });
        const put = f.drive.putText.bind(f.drive);
        f.drive.putText = async () => {
          throw new AppError("DRIVE_FORBIDDEN", 403, "Không có quyền Drive");
        };
        await runWorkflows(db, options);
        f.drive.putText = put;
        assert.equal((await job(b.id)).status, "failed");
        assert.equal((await get(b.id)).download_status, "ERROR");
        assert.equal((await chapter(b.ids[0])).status, "PENDING");
        await rpc("retry", { id: b.id });
        await runWorkflows(db, options);
        assert.equal((await get(b.id)).download_status, "DONE");
      },
    );
    await check(
      "revoked actor cannot fetch; service RPC and settings remain private",
      async () => {
        const b = await create("WEB", 1);
        await rpc("start", { id: b.id });
        await db.query(
          "update public.profiles set status='blocked' where id=$1",
          [actor],
        );
        const before = fetches;
        await runWorkflows(db, options);
        assert.equal(fetches, before);
        assert.equal((await job(b.id)).status, "cancelled");
        await db.query(
          "update public.profiles set status='active' where id=$1",
          [actor],
        );
        assert.equal(
          (
            await db.query(
              "select has_function_privilege('authenticated','public.app_download(uuid,text,jsonb)','EXECUTE') as ok",
            )
          ).rows[0].ok,
          false,
        );
        await assert.rejects(() =>
          db.query("select public.app_download_settings($1,$2)", [
            reader,
            { AUTO_RESUME: true },
          ]),
        );
      },
    );
    await check(
      "chapter cancel is DONE/skipped; pause retains error; retry and deletion honor permissions",
      async () => {
        const b = await create("WEB", 2);
        let v = Number((await get(b.id)).version);
        await rpc("chapter", {
          id: b.id,
          chapter: b.ids[0],
          version: v,
          action: "cancel",
        });
        let c = await chapter(b.ids[0]);
        assert.equal(c.status, "DONE");
        assert(c.is_skipped);
        assert.equal(c.file_id, null);
        v = Number((await get(b.id)).version);
        await rpc("chapter", {
          id: b.id,
          chapter: b.ids[1],
          version: v,
          action: "pause",
        });
        c = await chapter(b.ids[1]);
        assert.equal(c.status, "ERROR");
        assert.match(c.error_code, /MANUAL_PAUSE/);
        v = Number((await get(b.id)).version);
        await rpc("chapter", {
          id: b.id,
          chapter: b.ids[0],
          version: v,
          action: "retry",
        });
        await runWorkflows(db, options);
        c = await chapter(b.ids[0]);
        assert.equal(c.status, "DONE");
        assert(!c.is_skipped);
        const fid = c.file_id;
        v = Number((await get(b.id)).version);
        await rpc("chapter", {
          id: b.id,
          chapter: b.ids[0],
          version: v,
          action: "delete",
        });
        await runWorkflows(db, options);
        assert.equal(await chapter(b.ids[0]), undefined);
        assert(f.files.get(fid)!.trashed);
        assert.equal((await chapter(b.ids[1])).display_number, "2");
      },
    );
    await check(
      "DELAY_MS persists next-run when pass cannot wait; no SQL transaction spans source IO",
      async () => {
        await cfg({ DELAY_MS: 10000 });
        const b = await create("WEB", 2);
        await rpc("start", { id: b.id });
        const http = options.http;
        let open = false;
        options.http = {
          async get(raw) {
            const activity = (
              await other.query(
                "select state from pg_stat_activity where pid=pg_backend_pid()",
              )
            ).rows;
            assert(activity.length);
            const state = (
              await other.query(
                "select state from pg_stat_activity where pid=$1",
                [(db as any).processID],
              )
            ).rows[0].state;
            open = state === "idle in transaction";
            return http.get(raw);
          },
        };
        await runWorkflows(db, { ...options, maxMs: 3000 });
        options.http = http;
        assert(!open);
        assert.equal((await chapter(b.ids[0])).status, "DONE");
        assert.equal((await chapter(b.ids[1])).status, "PENDING");
        assert(
          new Date((await job(b.id)).next_run_at).getTime() > Date.now() + 7000,
        );
        await cfg({ DELAY_MS: 0 });
        await force(b.id);
        await runWorkflows(db, options);
      },
    );
    await check(
      "verify cursor handles more than 100 missing files without skipping shifted DONE rows",
      async () => {
        const b = await create("FOLDER", 205);
        for (let i = 0; i < b.ids.length; i++) {
          const id = "missing-" + i;
          await db.query(
            "update public.chapters set status='DONE',file_id=$2 where id=$1",
            [b.ids[i], id],
          );
        }
        await db.query(
          "update public.books set download_status='DONE' where id=$1",
          [b.id],
        );
        await rpc("verify", { id: b.id });
        for (let n = 0; n < 3; n++) await runWorkflows(db, options);
        assert.equal((await job(b.id)).status, "done");
        assert.equal(
          (
            await db.query(
              "select count(*) from public.chapters where book_id=$1 and status='PENDING'",
              [b.id],
            )
          ).rows[0].count,
          "205",
        );
        assert.equal((await get(b.id)).download_status, "ERROR");
      },
    );
    await check(
      "FILE pause/continue/cancel chapters preserve temp until completion and avoid DONE rewrite",
      async () => {
        await cfg({ BATCH_SIZE: 1 });
        const b = await create("FILE", 3),
          contents = b.ids.map((id, i) => ({
            num: i + 1,
            title: "Chương " + (i + 1),
            body,
          })),
          temp = await f.drive.putText(
            b.folder,
            "_import.json",
            JSON.stringify(contents),
            1,
          );
        await db.query(
          "insert into public.jobs(kind,book_id,actor_id,dedupe_key,checkpoint) values('FILE_IMPORT',$1,$2,$3,$4)",
          [
            b.id,
            actor,
            "file:" + b.id,
            JSON.stringify({ importId: temp, request: {} }),
          ],
        );
        await db.query(
          "update public.books set download_status='IDLE' where id=$1",
          [b.id],
        );
        await runWorkflows(db, options);
        const first = await chapter(b.ids[0]);
        await rpc("pause", { id: b.id });
        assert(!f.files.get(temp)!.trashed);
        await rpc("start", { id: b.id });
        await runWorkflows(db, options);
        assert.equal((await chapter(b.ids[0])).file_id, first.file_id);
        const v = Number((await get(b.id)).version);
        await rpc("chapter", {
          id: b.id,
          chapter: b.ids[2],
          version: v,
          action: "cancel",
        });
        await runWorkflows(db, options);
        assert.equal((await get(b.id)).download_status, "DONE");
        assert(f.files.get(temp)!.trashed);
        assert((await chapter(b.ids[2])).is_skipped);
        await cfg({ BATCH_SIZE: 2 });
      },
    );
    await check(
      "outbox handles metadata mutation during IO without SQL locks and repairs latest info",
      async () => {
        const b = await create("WEB", 1);
        await db.query("select public.app_manage($1,'save',$2)", [
          actor,
          {
            items: [
              {
                id: b.id,
                version: 1,
                name: "Sync " + b.id,
                author: "Trước",
                genres: [],
                visibility: "hidden",
              },
            ],
          },
        ]);
        const put = f.drive.putText.bind(f.drive);
        let changed = false;
        f.drive.putText = async (parent, name, text, v) => {
          if (parent === b.folder && name === "info.txt" && !changed) {
            changed = true;
            await other.query("select public.app_manage($1,'save',$2)", [
              actor,
              {
                items: [
                  {
                    id: b.id,
                    version: 2,
                    name: "Sync " + b.id,
                    author: "Sau",
                    genres: [],
                    visibility: "hidden",
                  },
                ],
              },
            ]);
          }
          return put(parent, name, text, v);
        };
        await runWorkflows(db, options);
        f.drive.putText = put;
        await db.query(
          "update public.outbox_operations set next_run_at=now() where book_id=$1",
          [b.id],
        );
        await runWorkflows(db, options);
        const info = [...f.files.values()].find(
          (x) => x.parents[0] === b.folder && x.name === "info.txt",
        )!;
        assert.match(f.bodies.get(info.id)!.toString(), /##Tác giả\nSau/);
        assert.equal(
          (
            await db.query(
              "select count(*) from public.outbox_operations where book_id=$1 and status='done'",
              [b.id],
            )
          ).rows[0].count,
          "2",
        );
      },
    );
    console.log(`${passed}/${passed} download SQL/API/executor tests passed.`);
  } finally {
    other.release();
    db.release();
  }
} finally {
  if (pool) await pool.end();
  await admin.query(
    "select pg_terminate_backend(pid) from pg_stat_activity where datname=$1",
    [name],
  );
  await admin.query("drop database if exists " + name);
  await admin.end();
  process.env.DATABASE_URL = original;
}

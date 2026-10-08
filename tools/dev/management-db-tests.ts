import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { localPool } from "../../packages/infrastructure/src/database";
import { migrate } from "./migrate";
import { runWorkflows } from "../../packages/infrastructure/src/workflows";
import { handleApi } from "../../netlify/functions/api";
import { AppError } from "../../packages/contracts/src/index";
import type { AuthServices } from "../../packages/infrastructure/src/auth";
import { memoryDrive } from "../../tests/phase-5/fixture";
const original =
    process.env.DATABASE_URL ||
    "postgresql://postgres:local-only-password@127.0.0.1:55432/bookdownloader",
  admin = localPool(original),
  name = "book_manage_test_" + randomUUID().replaceAll("-", ""),
  url = new URL(original);
url.pathname = "/" + name;
let pool: ReturnType<typeof localPool> | undefined,
  passed = 0;
const uid = (n: number) =>
  `a1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function check(label: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log("PASS " + label);
}
try {
  await admin.query("create database " + name);
  process.env.DATABASE_URL = url.href;
  await migrate();
  pool = localPool(url.href);
  const db = await pool.connect();
  try {
    for (let n = 1; n <= 3; n++)
      await db.query(
        "insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data) values($1,'synthetic@gmail.com',now(),'{\"provider\":\"google\"}')",
        [uid(n)],
      );
    await db.query(
      "insert into public.user_permissions values($1,'manage'),($1,'download'),($1,'admin'),($2,'download')",
      [uid(1), uid(3)],
    );
    const f = memoryDrive(),
      options = {
        rootId: "root",
        owner: "synthetic-owner",
        drive: f.drive,
        http: {
          async get(raw: string) {
            return {
              body: '<h1>Truyện nguồn</h1><a href="/book/chuong-1">Chương 1</a><a href="/book/chuong-2">Chương 2</a>',
              finalUrl: raw,
            };
          },
        },
        validateUrl: async () => {},
        maxItems: 1,
        maxMs: 5000,
      };
    function services(n: number): AuthServices {
      return {
        async verify() {
          return {
            id: uid(n),
            email: "synthetic@gmail.com",
            email_confirmed_at: "2026-10-08",
            app_metadata: { provider: "google" },
          };
        },
        async rpc(rpc, args) {
          const ordered: Record<string, unknown[]> = {
            app_me: [args.actor],
            app_manage: [args.actor, args.operation, args.input],
            app_analysis: [args.actor, args.operation, args.input],
            app_cover_asset: [
              args.actor,
              args.upload ?? null,
              args.asset_id ?? null,
              args.content ?? null,
            ],
            app_settings: [args.actor, args.new_value],
            app_manage_cover: [
              args.actor,
              args.target_book,
              args.target_chapter,
            ],
          };
          const params = ordered[rpc];
          assert(params, "Unexpected RPC " + rpc);
          try {
            return (
              await db.query(
                `select public.${rpc}(${params.map((_, i) => "$" + (i + 1)).join(",")}) as value`,
                params,
              )
            ).rows[0].value;
          } catch (e: any) {
            throw new AppError(
              e.code === "42501"
                ? "FORBIDDEN"
                : e.code === "P0002"
                  ? "NOT_FOUND"
                  : ["40001", "23505"].includes(e.code)
                    ? "CONFLICT"
                    : "INVALID_INPUT",
              e.code === "42501"
                ? 403
                : e.code === "P0002"
                  ? 404
                  : ["40001", "23505"].includes(e.code)
                    ? 409
                    : 400,
              e.message,
            );
          }
        },
      };
    }
    const api = (path: string, method = "GET", body?: unknown, n = 1) =>
      handleApi(
        new Request("https://app.test/api" + path, {
          method,
          headers: {
            Authorization: "Bearer synthetic",
            Origin: "https://app.test",
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        { APP_ORIGINS: "https://app.test" },
        undefined,
        services(n),
        {
          readText: (id) => f.drive.readText(id),
          readBytes: async (id) => {
            const file = await f.drive.assertUnderRoot(id);
            return {
              bytes: new Uint8Array(f.bodies.get(id)!),
              mimeType: file.mimeType,
            };
          },
        },
        { validateUrl: async () => ({}) as any },
      );
    async function ok(path: string, method = "GET", body?: unknown, n = 1) {
      const r = await api(path, method, body, n),
        v = await r.json();
      assert(r.ok, JSON.stringify(v));
      return v;
    }
    async function upload(
      text: Buffer,
      purpose = "import",
      name = "story.txt",
      n = 1,
    ) {
      const u = await ok(
        "/manage/uploads",
        "POST",
        { purpose, name, size: text.length },
        n,
      );
      for (
        let offset = 0, index = 0;
        offset < text.length;
        offset += 262144, index++
      )
        await ok(
          "/manage/uploads/" + u.id,
          "PUT",
          {
            index,
            data: text.subarray(offset, offset + 262144).toString("base64"),
          },
          n,
        );
      await ok("/manage/uploads/" + u.id + "/complete", "POST", undefined, n);
      return u.id;
    }
    let bid = "",
      version = 1;
    await check(
      "reader and downloader cannot mutate management or upload; origin protected",
      async () => {
        assert.equal(
          (await api("/manage/books", "GET", undefined, 2)).status,
          403,
        );
        assert.equal(
          (
            await api(
              "/manage/uploads",
              "POST",
              { purpose: "import", name: "a.txt", size: 10 },
              3,
            )
          ).status,
          403,
        );
        const request = new Request("https://app.test/api/analysis", {
          method: "POST",
          headers: {
            Authorization: "Bearer synthetic",
            "Content-Type": "application/json",
          },
          body: "{}",
        });
        assert.equal(
          (
            await handleApi(
              request,
              { APP_ORIGINS: "https://app.test" },
              undefined,
              services(1),
            )
          ).status,
          403,
        );
      },
    );
    await check(
      "chunk upload verifies size/idempotency/ownership and incomplete finalization",
      async () => {
        const u = await ok("/manage/uploads", "POST", {
          purpose: "import",
          name: "a.txt",
          size: 10,
        });
        assert.equal(
          (await api("/manage/uploads/" + u.id + "/complete", "POST")).status,
          400,
        );
        assert.equal(
          (
            await api(
              "/manage/uploads/" + u.id,
              "PUT",
              { index: 0, data: Buffer.alloc(10).toString("base64") },
              3,
            )
          ).status,
          403,
        );
        await ok("/manage/uploads/" + u.id, "PUT", {
          index: 0,
          data: Buffer.alloc(10).toString("base64"),
        });
        await ok("/manage/uploads/" + u.id, "PUT", {
          index: 0,
          data: Buffer.alloc(10).toString("base64"),
        });
        assert.equal(
          (
            await api("/manage/uploads/" + u.id, "PUT", {
              index: 0,
              data: Buffer.alloc(10, 1).toString("base64"),
            })
          ).status,
          409,
        );
        await ok("/manage/uploads/" + u.id, "DELETE");
      },
    );
    await check(
      "file import queues and resumes one chapter per run with info/temp staging",
      async () => {
        const text = Buffer.from(
          "Chương 1: Mở đầu\n" +
            "Nội dung chương thứ nhất. ".repeat(5) +
            "\nChương 2: Tiếp tục\n" +
            "Nội dung chương thứ hai. ".repeat(5),
        );
        const u = await upload(text);
        await ok("/manage/imports", "POST", {
          name: "Đường về",
          author: "Tác giả",
          genres: ["Kiếm hiệp", "Lịch sử"],
          upload: u,
        });
        await runWorkflows(db, options);
        const j = (
          await db.query(
            "select * from public.jobs where kind='FILE_IMPORT' order by created_at limit 1",
          )
        ).rows[0];
        assert.equal(j.status, "queued");
        bid = j.book_id;
        const b = (await ok("/manage/books")).books[0];
        assert.equal(b.done, 1);
        assert.equal(b.total, 2);
        const info = [...f.files.values()].find((x) => x.name === "info.txt")!;
        assert.match(
          f.bodies.get(info.id)!.toString(),
          /##Tên truyện\nĐường về/,
        );
        assert.match(f.bodies.get(info.id)!.toString(), /##link gốc\n\n$/);
        assert(
          [...f.files.values()].some(
            (x) => x.name === "_import.json" && !x.trashed,
          ),
        );
        const trash = f.drive.trashOwned.bind(f.drive);
        f.drive.trashOwned = async (id) => {
          await trash(id);
          f.drive.trashOwned = trash;
          throw new AppError("CRASH", 503, "Gián đoạn sau khi dọn temp");
        };
        await runWorkflows(db, options);
        assert.equal(
          (await db.query("select status from public.jobs where id=$1", [j.id]))
            .rows[0].status,
          "failed",
        );
        await ok("/manage/jobs/" + j.id + "/retry", "POST");
        await runWorkflows(db, options);
        assert.equal(
          (await db.query("select status from public.jobs where id=$1", [j.id]))
            .rows[0].status,
          "done",
        );
        assert.equal((await ok("/manage/books")).books[0].done, 2);
        assert(
          ![...f.files.values()].some(
            (x) => x.name === "_import.json" && !x.trashed,
          ),
        );
      },
    );
    await check(
      "normalized uniqueness, partial batch errors and stale versions",
      async () => {
        const b = (await ok("/manage/books")).books[0];
        const items = [
          {
            id: bid,
            version: 1,
            name: "Đường mới",
            author: "A",
            genres: ["Lịch sử", "Kiếm hiệp"],
            visibility: "published",
          },
          {
            id: randomUUID(),
            version: 1,
            name: "Missing",
            author: "",
            genres: [],
            visibility: "hidden",
          },
        ];
        let r = await ok("/manage/books", "PUT", { items });
        assert.equal(r[0].ok, true);
        assert.equal(r[1].ok, false);
        version = r[0].version;
        r = await ok("/manage/books", "PUT", { items: [items[0]] });
        assert.equal(r[0].ok, false);
        assert.match(r[0].error, /thay đổi/);
        assert.deepEqual((await ok("/manage/books")).books[0].genres, [
          "Lịch sử",
          "Kiếm hiệp",
        ]);
      },
    );
    await check(
      "outbox renames/moves/updates exactly one info and can replay",
      async () => {
        await runWorkflows(db, options);
        const b = (await ok("/manage/books")).books[0],
          folder = f.files.get(b.folderId)!;
        assert.equal(folder.name, "Đường mới");
        assert.equal(f.files.get(folder.parents[0])!.name, "Lịch sử");
        assert.equal(
          [...f.files.values()].filter(
            (x) => !x.trashed && x.name === "info.txt",
          ).length,
          1,
        );
        await runWorkflows(db, options);
        assert.equal(
          [...f.files.values()].filter(
            (x) => !x.trashed && x.name === "info.txt",
          ).length,
          1,
        );
      },
    );
    await check(
      "cover stages normalized bytes, preview scoped to actor, commit/delete deferred",
      async () => {
        const image = await sharp({
            create: { width: 30, height: 20, channels: 3, background: "blue" },
          })
            .png()
            .toBuffer(),
          u = await upload(image, "cover", "cover.png"),
          a = await ok("/manage/uploads/" + u + "/cover", "POST");
        const preview = await api("/manage/assets/" + a.id);
        assert.equal(preview.status, 200);
        assert.equal(preview.headers.get("content-type"), "image/webp");
        assert(
          !(
            await db.query(
              "select 1 from public.drive_resources where book_id=$1 and kind='COVER'",
              [bid],
            )
          ).rowCount,
        );
        const b = (await ok("/manage/books")).books[0];
        const result = await ok("/manage/books", "PUT", {
          items: [
            {
              id: bid,
              version,
              name: b.name,
              author: b.author,
              genres: b.genres,
              visibility: b.visibility,
              coverAsset: a.id,
            },
          ],
        });
        assert(result[0].ok);
        version = result[0].version;
        await runWorkflows(db, options);
        assert((await ok("/manage/books")).books[0].hasCover);
        const remove = await ok("/manage/books", "PUT", {
          items: [
            {
              id: bid,
              version,
              name: b.name,
              author: b.author,
              genres: b.genres,
              visibility: b.visibility,
              coverAsset: null,
            },
          ],
        });
        assert(remove[0].ok);
        version = remove[0].version;
        await runWorkflows(db, options);
        assert(!(await ok("/manage/books")).books[0].hasCover);
      },
    );
    await check(
      "genre catalog removal leaves primary genre on book",
      async () => {
        const genres = await ok("/manage/genres");
        await ok("/manage/genres/" + genres[0].id, "DELETE");
        assert.equal((await ok("/manage/books")).books[0].genres.length, 2);
        await ok("/manage/genres/import", "POST");
        assert.equal((await ok("/manage/genres")).length, 2);
      },
    );
    await check(
      "short paste accepted, duplicate order refused and FILE rejects link",
      async () => {
        await ok("/manage/books/" + bid + "/chapters", "POST", {
          version,
          order: 3,
          title: "Ngắn",
          part: "",
          volume: "",
          kind: "paste",
          text: "Một dòng.",
        });
        await runWorkflows(db, options);
        assert.equal((await ok("/manage/books")).books[0].done, 3);
        version++;
        assert.equal(
          (
            await api("/manage/books/" + bid + "/chapters", "POST", {
              version,
              order: 4,
              title: "",
              part: "",
              volume: "",
              kind: "link",
              url: "https://source.test/c-4",
            })
          ).status,
          400,
        );
        await ok("/manage/books/" + bid + "/chapters", "POST", {
          version,
          order: 3,
          title: "Trùng",
          part: "",
          volume: "",
          kind: "paste",
          text: "a",
        });
        await runWorkflows(db, options);
        assert.equal(
          (
            await db.query(
              "select count(*) from public.chapters where book_id=$1",
              [bid],
            )
          ).rows[0].count,
          "3",
        );
        assert(
          (await ok("/manage/jobs")).some((j: any) => j.status === "failed"),
        );
      },
    );
    await check(
      "analysis holds sequentially, retains error and no auto download",
      async () => {
        await ok(
          "/analysis",
          "POST",
          { urls: ["https://source.test/book/"], mode: "auto" },
          3,
        );
        await runWorkflows(db, options);
        const j = (await ok("/analysis", "GET", undefined, 3)).jobs[0];
        assert.equal(j.status, "done");
        assert.equal(j.book.status, "ANALYZED");
        assert.equal(j.book.done, 0);
        assert.equal(j.book.total, 2);
        assert(j.book.folderId);
        assert(
          ![...f.bodies.values()].some((x) =>
            x.toString().includes("secret-cookie"),
          ),
        );
      },
    );
    await check(
      "reanalyze preserves chapter IDs, existing file and own progress",
      async () => {
        const j = (await ok("/analysis")).jobs[0],
          first = (
            await db.query(
              "select id from public.chapters where book_id=$1 order by order_key limit 1",
              [j.book.id],
            )
          ).rows[0],
          fid = await f.drive.putText(
            j.book.folderId,
            "Chương 001 - Đã tải.txt",
            "Nội dung đã có",
            1,
          );
        await db.query(
          "update public.chapters set file_id=$2,status='DONE' where id=$1",
          [first.id, fid],
        );
        await db.query(
          "insert into public.reading_progress(user_id,book_id,chapter_id,ratio) values($1,$2,$3,0.4)",
          [uid(3), j.book.id, first.id],
        );
        const before = (
          await db.query(
            "select id,file_id,status from public.chapters where book_id=$1 order by order_key",
            [j.book.id],
          )
        ).rows;
        await ok("/analysis/actions", "POST", { id: j.id, action: "retry" });
        await runWorkflows(db, options);
        const after = (
          await db.query(
            "select id,file_id,status from public.chapters where book_id=$1 order by order_key",
            [j.book.id],
          )
        ).rows;
        assert.deepEqual(after, before);
        assert.equal(
          (
            await db.query(
              "select ratio from public.reading_progress where user_id=$1 and book_id=$2",
              [uid(3), j.book.id],
            )
          ).rows[0].ratio,
          "0.4",
        );
      },
    );
    await check(
      "failed analysis keeps URL, retry/drop work and bulk genres check manage",
      async () => {
        options.http = {
          async get() {
            throw new AppError("SOURCE_HTTP", 422, "Website trả HTTP 403");
          },
        };
        await ok("/analysis", "POST", {
          urls: ["https://broken.test/book/"],
          mode: "auto",
        });
        await runWorkflows(db, options);
        const j = (await ok("/analysis")).jobs.find((x: any) =>
          x.url.includes("broken"),
        );
        assert.equal(j.status, "failed");
        assert.match(j.error, /403/);
        assert.equal(
          (await api("/analysis/genres", "PUT", { genres: ["Mẫu"] }, 3)).status,
          403,
        );
        await ok("/analysis/genres", "PUT", { genres: ["Mẫu"] });
        await ok("/analysis/actions", "POST", { id: j.id, action: "drop" });
        assert(!(await ok("/analysis")).jobs.some((x: any) => x.id === j.id));
      },
    );
    await check(
      "folder import excludes info/temp/log/cover and rejects second registration",
      async () => {
        const folder = await f.drive.folder("root", "Sách thư mục");
        await f.drive.putText(folder, "Chương 1 - Một.txt", "text", 1);
        await f.drive.putText(folder, "info.txt", "old", 1);
        await f.drive.putText(folder, "_Chương lỗi đã xóa.txt", "log", 1);
        await f.drive.putText(folder, "_import.json", "[]", 1);
        await f.drive.putCover(
          folder,
          "cover-1.webp",
          Buffer.from("binary"),
          1,
        );
        await ok("/manage/imports", "POST", {
          name: "",
          author: "",
          genres: [],
          folder,
        });
        await runWorkflows(db, options);
        const b = (await ok("/manage/books")).books.find(
          (b: any) => b.folderId === folder,
        );
        assert(b);
        assert.equal(b.total, 1);
        await ok("/manage/imports", "POST", {
          name: "Khác",
          author: "",
          genres: [],
          folder,
        });
        await runWorkflows(db, options);
        assert.equal(
          (
            await db.query(
              "select count(*) from public.books where folder_id=$1",
              [folder],
            )
          ).rows[0].count,
          "1",
        );
      },
    );
    await check(
      "manual chapter error deletion logs reason/URL without renumbering",
      async () => {
        const j = (await ok("/analysis")).jobs.find(
          (x: any) => x.book?.sourceType === "WEB",
        );
        const c = (
          await db.query(
            "select * from public.chapters where book_id=$1 order by order_key limit 1",
            [j.book.id],
          )
        ).rows[0];
        await db.query(
          "update public.chapters set status='ERROR',error_code='TOO_SHORT' where id=$1",
          [c.id],
        );
        await ok("/manage/books/" + j.book.id + "/chapters/" + c.id, "PUT", {
          version: j.book.version,
          action: "delete",
        });
        await runWorkflows(db, options);
        assert.equal(
          (
            await db.query(
              "select order_key from public.chapters where book_id=$1",
              [j.book.id],
            )
          ).rows[0].order_key,
          "2",
        );
        assert(
          [...f.bodies.values()].some((v) =>
            v.toString().includes("Xóa thủ công chương lỗi"),
          ),
        );
      },
    );
    await check(
      "delete cleans progress/jobs and optional trash never touches unrelated folder",
      async () => {
        const b = (await ok("/manage/books")).books.find(
            (x: any) => x.id === bid,
          ),
          folder = f.files.get(b.folderId)!;
        await ok("/manage/books/" + bid, "DELETE", {
          version: b.version,
          trash: true,
        });
        await runWorkflows(db, options);
        assert(folder.trashed);
        assert(!f.files.get("root")!.trashed);
        assert(
          !(await ok("/manage/books")).books.some((x: any) => x.id === bid),
        );
        assert(
          (
            await db.query(
              "select 1 from public.audit_logs where action='book_delete' and actor_id=$1",
              [uid(1)],
            )
          ).rowCount,
        );
      },
    );
    await check(
      "browser cannot spoof actor RPCs or read staging bytes",
      async () => {
        await db.query("set role authenticated");
        for (const sql of [
          "select public.app_manage($1,'list')",
          "select public.app_analysis($1,'list')",
          "select public.app_cover_asset($1)",
          "select bytes from private.cover_assets",
        ])
          await assert.rejects(
            db.query(sql, sql.includes("$1") ? [uid(1)] : []),
            { code: "42501" },
          );
        await db.query("reset role");
      },
    );
    await check(
      "crash after Drive creation retries without duplicate file or book",
      async () => {
        const u = await upload(
          Buffer.from(
            "Chương 1: Mở đầu\n" + "Nội dung chương đủ dài. ".repeat(4),
          ),
        );
        await ok("/manage/imports", "POST", {
          name: "Phục hồi",
          author: "",
          genres: [],
          upload: u,
        });
        f.crashAfterWrite();
        await runWorkflows(db, options);
        const j = (await ok("/manage/jobs")).find(
          (j: any) => j.status === "failed" && j.error.includes("Gián đoạn"),
        );
        assert(j);
        await ok("/manage/jobs/" + j.id + "/retry", "POST");
        await runWorkflows(db, options);
        const b = (await ok("/manage/books")).books.find(
          (b: any) => b.name === "Phục hồi",
        );
        assert(b);
        assert.equal(b.done, 1);
        assert.equal(
          [...f.files.values()].filter(
            (x) => x.name === "Phục hồi" && !x.trashed,
          ).length,
          1,
        );
      },
    );
    await check(
      "pair import matches groups/preface and reports missing/extra",
      async () => {
        const toc = await upload(
            Buffer.from(
              "###@ Phần một\n##@ Quyển một\n00 Lời tựa\n#@ Chương 1\n@ Một\n#@ Chương 2\n@ Thiếu\n#@ Chương 4\n@ Thiếu bốn",
            ),
            "toc",
            "toc.md",
          ),
          story = await upload(
            Buffer.from(
              "###@ Phần một\n##@ Quyển một\n00 Lời tựa\n" +
                "Nội dung lời tựa. ".repeat(4) +
                "\n#@ Chương 1\n@ Một\n" +
                "Nội dung thứ nhất. ".repeat(4) +
                "\n#@ Chương 3\n@ Thừa\n" +
                "Nội dung thứ ba. ".repeat(4),
            ),
          );
        const accepted = await ok("/manage/imports", "POST", {
          name: "Ghép cặp",
          author: "",
          genres: [],
          upload: story,
          toc,
        });
        await runWorkflows(db, options);
        await runWorkflows(db, options);
        await runWorkflows(db, options);
        const j = (await ok("/manage/jobs")).find(
          (j: any) => j.id === accepted.jobId,
        );
        assert(j);
        assert.equal(j.result.skipped, 2);
        assert.equal(j.result.extra, 1);
        const rows = (
          await db.query(
            "select c.display_number,g.name from public.chapters c join public.chapter_groups g on g.id=c.group_id where c.book_id=$1 order by c.order_key",
            [j.result.bookId],
          )
        ).rows;
        assert.equal(rows.length, 3);
        assert.equal(rows[0].display_number, "*");
        assert.equal(rows[1].name, "Quyển một");
      },
    );
    await check(
      "stale running lease recovers and concurrent worker is excluded",
      async () => {
        await db.query(
          "update public.jobs set status='running',lease_owner='crashed-worker',lease_until=now()-interval '1 second' where id=(select id from public.jobs where kind='FILE_IMPORT' and status='done' and checkpoint ? 'importId' and checkpoint->>'importId' is null limit 1)",
        );
        await runWorkflows(db, options);
        const other = await pool!.connect();
        try {
          await db.query(
            "select pg_advisory_lock(hashtextextended('book-workflows',0))",
          );
          assert.equal((await runWorkflows(other, options)).busy, true);
        } finally {
          await db.query(
            "select pg_advisory_unlock(hashtextextended('book-workflows',0))",
          );
          other.release();
        }
      },
    );
    await check(
      "revoked actor pending analysis is cancelled before remote fetch",
      async () => {
        await ok(
          "/analysis",
          "POST",
          { urls: ["https://revoked.test/book/"], mode: "auto" },
          3,
        );
        await db.query(
          "delete from public.user_permissions where user_id=$1 and permission='download'",
          [uid(3)],
        );
        let calls = 0;
        const isolated = {
          ...options,
          http: {
            async get(raw: string) {
              calls++;
              return { body: "", finalUrl: raw };
            },
          },
        };
        await runWorkflows(db, isolated);
        assert.equal(calls, 0);
        assert.equal(
          (
            await db.query(
              "select status from public.jobs where checkpoint->'request'->>'url'='https://revoked.test/book/'",
            )
          ).rows[0].status,
          "cancelled",
        );
      },
    );
    await check(
      "catalog search/sort, reader-owned progress and settings share junk cache key",
      async () => {
        const list = await ok("/manage/books?q=" + encodeURIComponent("Mẫu"));
        assert(list.books.length >= 1);
        assert.equal((await api("/manage/books?sort=evil")).status, 400);
        assert.equal(
          (
            await api(
              "/settings/analysis",
              "PUT",
              { SITE_RULES: "", JUNK_WORDS: "Mẫu rác", DELAY_MS: 0 },
              3,
            )
          ).status,
          403,
        );
        await ok("/settings/analysis", "PUT", {
          SITE_RULES: "",
          JUNK_WORDS: "Mẫu rác",
          DELAY_MS: 0,
        });
        assert.equal(
          (
            await db.query(
              "select value #>> '{}' as value from public.app_settings where key='JUNK_WORDS'",
            )
          ).rows[0].value,
          "Mẫu rác",
        );
      },
    );
    await check(
      "cover asset ownership excludes another manager and private cover is readable by manage",
      async () => {
        await db.query(
          "insert into public.user_permissions values($1,'manage') on conflict do nothing",
          [uid(2)],
        );
        const b = (await ok("/manage/books")).books[0],
          bytes = await sharp({
            create: { width: 10, height: 10, channels: 3, background: "red" },
          })
            .png()
            .toBuffer(),
          u = await upload(bytes, "cover", "private.png"),
          asset = await ok("/manage/uploads/" + u + "/cover", "POST");
        assert.equal(
          (await api("/manage/assets/" + asset.id, "GET", undefined, 2)).status,
          404,
        );
        const r = await ok("/manage/books", "PUT", {
          items: [
            {
              id: b.id,
              version: b.version,
              name: b.name,
              author: b.author,
              genres: b.genres,
              visibility: b.visibility,
              coverAsset: asset.id,
            },
          ],
        });
        assert(r[0].ok);
        await runWorkflows(db, options);
        await db.query(
          "delete from public.user_permissions where user_id=$1 and permission='read'",
          [uid(2)],
        );
        const cover = await api(
          "/manage/books/" + b.id + "/cover",
          "GET",
          undefined,
          2,
        );
        assert.equal(cover.status, 200);
        assert.equal(cover.headers.get("content-type"), "image/webp");
        assert((await cover.arrayBuffer()).byteLength > 0);
      },
    );
    await check(
      "pause file chapter preserves temporary import; retry resumes without rewriting DONE",
      async () => {
        const u = await upload(
          Buffer.from(
            "Chương 1: Một\n" +
              "Nội dung một. ".repeat(5) +
              "\nChương 2: Hai\n" +
              "Nội dung hai. ".repeat(5),
          ),
        );
        const accepted = await ok("/manage/imports", "POST", {
          name: "Tạm dừng nhập",
          author: "",
          genres: [],
          upload: u,
        });
        await runWorkflows(db, options);
        const j = (
            await db.query("select * from public.jobs where id=$1", [
              accepted.jobId,
            ])
          ).rows[0],
          c = (
            await db.query(
              "select id from public.chapters where book_id=$1 and status='PENDING'",
              [j.book_id],
            )
          ).rows[0],
          b = (await ok("/manage/books")).books.find(
            (b: any) => b.id === j.book_id,
          ),
          first = (
            await db.query(
              "select file_id from public.chapters where book_id=$1 and status='DONE'",
              [b.id],
            )
          ).rows[0].file_id;
        await ok("/manage/books/" + b.id + "/chapters/" + c.id, "PUT", {
          version: b.version,
          action: "pause",
        });
        await runWorkflows(db, options);
        assert.equal(
          (await db.query("select status from public.jobs where id=$1", [j.id]))
            .rows[0].status,
          "paused",
        );
        assert(!f.files.get(j.checkpoint.importId)!.trashed);
        await ok("/manage/books/" + b.id + "/chapters/" + c.id, "PUT", {
          version: b.version + 1,
          action: "retry",
        });
        await runWorkflows(db, options);
        assert.equal(
          (await db.query("select status from public.jobs where id=$1", [j.id]))
            .rows[0].status,
          "done",
        );
        assert.equal(
          (
            await db.query(
              "select file_id from public.chapters where book_id=$1 order by order_key limit 1",
              [b.id],
            )
          ).rows[0].file_id,
          first,
        );
      },
    );
    console.log(
      `Management/analysis SQL/API/executor: ${passed} passed; isolated database removed.`,
    );
  } finally {
    db.release();
  }
} finally {
  process.env.DATABASE_URL = original;
  await pool?.end();
  await admin.query("drop database if exists " + name);
  await admin.end();
}

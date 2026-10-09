import {
  DownloadAction,
  DownloadChapterAction,
  DownloadSettings,
} from "../../packages/contracts/src/download";
import {
  readStoredChapter,
  readStoredCover,
  readerStorage,
  type ReaderStorage,
} from "../../packages/infrastructure/src/reader-storage";
import { randomUUID } from "node:crypto";
import { kickWorker, workerStatus } from "../../packages/infrastructure/src/netlify-worker";
import { z } from "zod";
import {
  MetadataEdit,
  UploadStart,
  UploadChunk,
  ImportRequest,
  ChapterAdd,
  AnalysisRequest,
  AnalysisAction,
  SettingsEdit,
} from "../../packages/contracts/src/management";
import { validateSource } from "../../packages/infrastructure/src/source-http";
import { normalizeCover } from "../../packages/infrastructure/src/cover";
import {configureRoot} from '../../packages/infrastructure/src/operations';
import {createDrive} from '../../packages/infrastructure/src/drive';
import {releaseContract,releaseRevision} from '../../packages/contracts/src/release';
import {
  normUrl_,
  folderIdFrom_,
  normName_,
  cleanName_,
  cleanGenreList_,
} from "../../packages/domain/src/legacy.mjs";
import { checkDatabase } from "../../packages/infrastructure/src/health";
import { safeLog } from "../../packages/infrastructure/src/logging";
import {
  createAuthServices,
  type AuthServices,
} from "../../packages/infrastructure/src/auth";
import {
  LibraryBook,
  LibraryPage,
  ChapterPage,
  Account,
  AccountUpdate,
  AdminUser,
  AppError,
  hasPermission,
  ProgressUpdate,
  ReaderPreferences,
} from "../../packages/contracts/src/index";
export async function handleApi(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  check = checkDatabase,
  injected?: AuthServices,
  storage?: ReaderStorage,
  business: {validateUrl:(url:string)=>Promise<unknown>;rootFactory?:typeof createDrive;kickWorker?:typeof kickWorker} = { validateUrl: validateSource },
): Promise<Response> {
  const correlationId = randomUUID();
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Correlation-ID": correlationId,
    "X-Content-Type-Options": "nosniff",
  };
  const url = new URL(request.url),
    pathname = url.pathname.replace(/^\/.netlify\/functions\/api\//, "/api/");
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers });
  if(request.method==='GET'&&pathname==='/api/version')return json({...releaseContract,revision:releaseRevision||env.RELEASE_REVISION||env.COMMIT_REF||null});
  if (request.method === "GET" && pathname === "/api/health") {
    try {
      await check(env);
      return json({ status: "ok", database: "ok", correlationId });
    } catch {
      safeLog("health_unavailable", correlationId);
      return json(
        { status: "unavailable", database: "unavailable", correlationId },
        503,
      );
    }
  }
  if (request.method === "POST" && pathname === "/api/health")
    return json({ error: "NOT_IMPLEMENTED", correlationId }, 501);
  let services: AuthServices | undefined;
  try {
    const bearer = request.headers
      .get("Authorization")
      ?.match(/^Bearer ([A-Za-z0-9._~-]{1,8192})$/);
    if (!bearer) throw new AppError("UNAUTHENTICATED", 401, "Cần đăng nhập");
    if (!["GET", "HEAD"].includes(request.method)) {
      const origin = request.headers.get("Origin");
      const allowed = (env.APP_ORIGINS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!origin || !allowed.includes(origin))
        throw new AppError("INVALID_ORIGIN", 403, "Nguồn yêu cầu không hợp lệ");
    }
    services = injected || createAuthServices(env);
    const identity = await services.verify(bearer[1]);
    const account = Account.parse(
      await services.rpc("app_me", { actor: identity.id }),
    );
    if (account.id !== identity.id)
      throw new AppError("AUTH_UNAVAILABLE", 503, "Tài khoản không hợp lệ");
    const requirePermission = (
      permission: "read" | "manage" | "download" | "admin",
    ) => {
      if (!hasPermission(account, permission))
        throw new AppError(
          "FORBIDDEN",
          403,
          "Bạn không có quyền thực hiện thao tác này",
        );
    };
    async function body(max = 8192) {
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        throw new AppError("INVALID_INPUT", 400, "Cần dữ liệu JSON");
      const declared = Number(request.headers.get("content-length") || 0);
      if (declared > max)
        throw new AppError("INPUT_TOO_LARGE", 413, "Dữ liệu quá lớn");
      const reader = request.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        if (reader)
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > max)
              throw new AppError("INPUT_TOO_LARGE", 413, "Dữ liệu quá lớn");
            chunks.push(part.value);
          }
      } finally {
        await reader?.cancel();
      }
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        return JSON.parse(text);
      } catch {
        throw new AppError("INVALID_INPUT", 400, "JSON không hợp lệ");
      }
    }
    if (pathname === "/api/me" && request.method === "GET")
      return json(account);
    if(pathname==='/api/admin/operations'){
      requirePermission('admin');
      if(request.method==='GET')return json(await services.rpc('app_operations',{actor:identity.id,operation:'status'}));
      if(request.method==='PUT'){
        const input=z.object({enabled:z.boolean()}).strict().parse(await body());
        return json(await services.rpc('app_operations',{actor:identity.id,operation:'maintenance',input}));
      }
    }
    if(pathname==='/api/drive/root'&&request.method==='PUT'){
      requirePermission('admin');
      return json(await configureRoot(services,identity.id,await body(),env,business.rootFactory));
    }
    let rootStorage:ReaderStorage|undefined;
    async function effectiveStorage(){
      if(rootStorage)return rootStorage;
      const binding=z.object({rootId:z.string().nullable(),revision:z.number()}).parse(await services!.rpc('app_runtime_root',{actor:identity.id}));
      return rootStorage=readerStorage({...env,DRIVE_ROOT_ID:binding.rootId||env.DRIVE_ROOT_ID});
    }
    if (pathname === "/api/admin/users" && request.method === "GET") {
      requirePermission("admin");
      const after = url.searchParams.get("after");
      if (after) z.uuid().parse(after);
      return json(
        z.array(AdminUser).parse(
          await services.rpc("app_admin_users", {
            actor: identity.id,
            after_id: after,
          }),
        ),
      );
    }
    const target = /^\/api\/admin\/users\/([^/]+)$/.exec(pathname);
    if (target && request.method === "PUT") {
      requirePermission("admin");
      z.uuid().parse(target[1]);
      const update = AccountUpdate.parse(await body());
      await services.rpc("app_admin_update", {
        actor: identity.id,
        target: target[1],
        permissions: update.permissions,
        account_status: update.status,
      });
      return json({ ok: true });
    }
    if (
      pathname === "/api/me/preferences" &&
      ["GET", "PUT"].includes(request.method)
    ) {
      requirePermission("read");
      const value =
        request.method === "PUT" ? ReaderPreferences.parse(await body()) : null;
      return json(
        await services.rpc("app_preferences", {
          actor: identity.id,
          new_value: value,
        }),
      );
    }
    const progress = /^\/api\/me\/progress\/([^/]+)$/.exec(pathname);
    if (progress && ["GET", "PUT"].includes(request.method)) {
      requirePermission("read");
      z.uuid().parse(progress[1]);
      const value =
        request.method === "PUT" ? ProgressUpdate.parse(await body()) : null;
      return json(
        await services.rpc("app_progress", {
          actor: identity.id,
          target_book: progress[1],
          new_value: value,
        }),
      );
    }
    function offset(name = "offset") {
      return z.coerce
        .number()
        .int()
        .min(0)
        .max(10000000)
        .parse(url.searchParams.get(name) ?? 0);
    }
    async function wakeWorker() {
      if (env.NETLIFY_WORKER_ENABLED !== "true") return;
      try { await (business.kickWorker || kickWorker)(env); }
      catch { safeLog("worker_kick_unavailable", correlationId); }
    }
    const manage = async (operation: string, input: unknown = {}) => {
      const result = await services!.rpc("app_manage", { actor: identity.id, operation, input });
      if (["save", "import", "job-retry", "sync-retry", "chapter-add", "chapter-action", "delete"].includes(operation)) await wakeWorker();
      return result;
    };
    const analysis = async (operation: string, input: unknown = {}) => {
      const result = await services!.rpc("app_analysis", { actor: identity.id, operation, input });
      if (["queue", "retry", "genre-bulk"].includes(operation)) await wakeWorker();
      return result;
    };
    if (pathname.startsWith("/api/manage")) {
      requirePermission("manage");
      const managedCover = /^\/api\/manage\/books\/([^/]+)\/cover$/.exec(
        pathname,
      );
      if (managedCover && request.method === "GET") {
        const content = await readStoredCover(
          services,
          storage || await effectiveStorage(),
          identity.id,
          z.uuid().parse(managedCover[1]),
          true,
        );
        return new Response(Buffer.from(content.bytes), {
          headers: { ...headers, "Content-Type": content.mimeType },
        });
      }
      if (pathname === "/api/manage/books" && request.method === "GET")
        return json(
          await manage("list", {
            q: z
              .string()
              .max(200)
              .parse(url.searchParams.get("q") || ""),
            sort: z
              .enum(["name", "author", "updated"])
              .parse(url.searchParams.get("sort") || "name"),
            offset: offset(),
          }),
        );
      if (pathname === "/api/manage/books" && request.method === "PUT") {
        const items = z
          .array(MetadataEdit)
          .min(1)
          .max(24)
          .parse((await body(128000)).items);
        for (const b of items) {
          b.name = cleanName_(b.name);
          b.author = cleanName_(b.author).slice(0, 100);
          b.genres = cleanGenreList_(b.genres);
          if (!normName_(b.name))
            throw new AppError("INVALID_INPUT", 400, "Tên truyện không hợp lệ");
        }
        return json(await manage("save", { items }));
      }
      if (pathname === "/api/manage/genres" && request.method === "GET")
        return json(await manage("genres"));
      if (pathname === "/api/manage/genres" && request.method === "POST")
        return json(
          await manage(
            "genre-save",
            z
              .object({ name: z.string().trim().min(1).max(100) })
              .strict()
              .parse(await body()),
          ),
        );
      if (pathname === "/api/manage/genres/import" && request.method === "POST")
        return json(await manage("genre-import"));
      const genre = /^\/api\/manage\/genres\/([^/]+)$/.exec(pathname);
      if (genre && request.method === "DELETE")
        return json(
          await manage("genre-drop", { id: z.uuid().parse(genre[1]) }),
        );
      if (pathname === "/api/manage/uploads" && request.method === "POST")
        return json(
          await manage("upload-start", UploadStart.parse(await body())),
          201,
        );
      const upload =
        /^\/api\/manage\/uploads\/([^/]+)(?:\/(complete|cover))?$/.exec(
          pathname,
        );
      if (upload) {
        const id = z.uuid().parse(upload[1]);
        if (!upload[2] && request.method === "PUT")
          return json(
            await manage("upload-chunk", {
              id,
              ...UploadChunk.parse(await body(360000)),
            }),
          );
        if (!upload[2] && request.method === "DELETE")
          return json(await manage("upload-drop", { id }));
        if (upload[2] === "complete" && request.method === "POST")
          return json(await manage("upload-complete", { id }));
        if (upload[2] === "cover" && request.method === "POST") {
          const value = (await services.rpc("app_cover_asset", {
            actor: identity.id,
            upload: id,
          })) as { bytes: string };
          const normalized = await normalizeCover(
            Buffer.from(value.bytes, "base64"),
          );
          return json(
            await services.rpc("app_cover_asset", {
              actor: identity.id,
              upload: id,
              content: normalized.toString("base64"),
            }),
            201,
          );
        }
      }
      const preview = /^\/api\/manage\/assets\/([^/]+)$/.exec(pathname);
      if (preview && request.method === "GET") {
        const value = (await services.rpc("app_cover_asset", {
          actor: identity.id,
          asset_id: z.uuid().parse(preview[1]),
        })) as { bytes: string };
        return new Response(Buffer.from(value.bytes, "base64"), {
          headers: { ...headers, "Content-Type": "image/webp" },
        });
      }
      if (pathname === "/api/manage/imports" && request.method === "POST") {
        const value = ImportRequest.parse(await body());
        if (value.folder) value.folder = folderIdFrom_(value.folder);
        return json(await manage("import", value), 202);
      }
      if (pathname === "/api/manage/jobs" && request.method === "GET")
        return json(await manage("jobs"));
      const retry = /^\/api\/manage\/jobs\/([^/]+)\/retry$/.exec(pathname);
      if (retry && request.method === "POST")
        return json(
          await manage("job-retry", { id: z.uuid().parse(retry[1]) }),
        );
      const book =
        /^\/api\/manage\/books\/([^/]+)(?:\/(chapters|sync-retry))?$/.exec(
          pathname,
        );
      if (book) {
        const id = z.uuid().parse(book[1]);
        if (!book[2] && request.method === "DELETE")
          return json(
            await manage("delete", {
              id,
              ...z
                .object({
                  version: z.number().int().positive(),
                  trash: z.boolean(),
                })
                .strict()
                .parse(await body()),
            }),
          );
        if (book[2] === "sync-retry" && request.method === "POST")
          return json(
            await manage("sync-retry", {
              id,
              ...z
                .object({ version: z.number().int().positive() })
                .strict()
                .parse(await body()),
            }),
          );
        if (book[2] === "chapters" && request.method === "GET")
          return json(await manage("chapters", { id, offset: offset() }));
        if (book[2] === "chapters" && request.method === "POST") {
          const value = ChapterAdd.parse(await body(1200000));
          if (value.url) await business.validateUrl(value.url);
          return json(await manage("chapter-add", { id, ...value }), 202);
        }
      }
      const chapter = /^\/api\/manage\/books\/([^/]+)\/chapters\/([^/]+)$/.exec(
        pathname,
      );
      if (chapter && request.method === "PUT") {
        const value = z
          .object({
            version: z.number().int().positive(),
            action: z.enum(["retry", "cancel", "pause", "delete", "edit"]),
            title: z.string().max(120).optional(),
            url: z.string().max(2000).optional(),
          })
          .strict()
          .parse(await body());
        if (
          value.action === "edit" &&
          (value.title === undefined || value.url === undefined)
        )
          throw new AppError("INVALID_INPUT", 400, "Thiếu tiêu đề hoặc URL");
        if (value.url) await business.validateUrl(value.url);
        return json(
          await manage("chapter-action", {
            id: z.uuid().parse(chapter[1]),
            chapter: z.uuid().parse(chapter[2]),
            ...value,
          }),
        );
      }
    }
    if (pathname.startsWith("/api/download")) {
      requirePermission("download");
      const download = async (operation: string, input: unknown = {}) => {
        const result = await services!.rpc("app_download", { actor: identity.id, operation, input });
        if (!["list", "errors"].includes(operation)) await wakeWorker();
        return result;
      };
      if (pathname === "/api/download" && request.method === "GET") {
        const filter = z
          .enum(["all", "FILE", "WEB", "FOLDER"])
          .parse(url.searchParams.get("filter") || "all");
        return json(await download("list", { filter, offset: offset() }));
      }
      if (pathname === "/api/download/actions" && request.method === "POST") {
        const value = DownloadAction.parse(await body());
        return json(await download(value.action, value));
      }
      if (pathname === "/api/download/chapters" && request.method === "POST") {
        const value = DownloadChapterAction.parse(await body());
        if (value.action === "delete") requirePermission("manage");
        return json(await download("chapter", value));
      }
      const errors = /^\/api\/download\/books\/([^/]+)\/errors$/.exec(pathname);
      if (errors && request.method === "GET")
        return json(
          await download("errors", {
            id: z.uuid().parse(errors[1]),
            offset: offset(),
          }),
        );
    }
    if (
      pathname === "/api/settings/download" &&
      ["GET", "PUT"].includes(request.method)
    ) {
      requirePermission("admin");
      return json(
        await services.rpc("app_download_settings", {
          actor: identity.id,
          new_value:
            request.method === "PUT"
              ? DownloadSettings.parse(await body())
              : null,
        }),
      );
    }
    if (pathname.startsWith("/api/analysis")) {
      requirePermission("download");
      if (pathname === "/api/analysis/worker" && request.method === "GET")
        return json(workerStatus(env));
      if (pathname === "/api/analysis/worker" && request.method === "POST") {
        await (business.kickWorker || kickWorker)(env);
        return json({ accepted: true }, 202);
      }
      if (pathname === "/api/analysis" && request.method === "GET")
        return json(await analysis("list"));
      if (pathname === "/api/analysis" && request.method === "POST") {
        const value = AnalysisRequest.parse(await body(400000));
        value.urls = [
          ...new Set(
            value.urls.map((u) =>
              value.mode === "auto" ? normUrl_(u) : new URL(u).href,
            ),
          ),
        ];
        for (const u of value.urls) await business.validateUrl(u);
        return json(await analysis("queue", value), 202);
      }
      if (pathname === "/api/analysis/actions" && request.method === "POST") {
        const value = AnalysisAction.parse(await body());
        return json(await analysis(value.action, value));
      }
      if (pathname === "/api/analysis/genres" && request.method === "PUT") {
        requirePermission("manage");
        const value = z
          .object({ genres: z.array(z.string().min(1).max(100)).max(6) })
          .strict()
          .parse(await body());
        return json(await analysis("genre-bulk", value));
      }
      // Download-screen metadata edits save immediately, same concurrency guard.
      if (pathname === "/api/analysis/books" && request.method === "PUT") {
        requirePermission("manage");
        const item = MetadataEdit.parse(await body());
        item.name = cleanName_(item.name);
        item.author = cleanName_(item.author).slice(0, 100);
        item.genres = cleanGenreList_(item.genres);
        return json(await manage("save", { items: [item] }));
      }
    }
    if (
      pathname === "/api/settings/analysis" &&
      ["GET", "PUT"].includes(request.method)
    ) {
      requirePermission("admin");
      return json(
        await services.rpc("app_settings", {
          actor: identity.id,
          new_value:
            request.method === "PUT"
              ? SettingsEdit.parse(await body(50000))
              : null,
        }),
      );
    }
    if (pathname === "/api/books" && request.method === "GET") {
      requirePermission("read");
      const query = z
        .string()
        .max(200)
        .parse(url.searchParams.get("q") || "");
      const sort = z
        .enum(["name", "author", "updated", "progress"])
        .parse(url.searchParams.get("sort") || "name");
      return json(
        LibraryPage.parse(
          await services.rpc("app_library", {
            actor: identity.id,
            query,
            sort_by: sort,
            page_offset: offset(),
          }),
        ),
      );
    }
    const readerBook = /^\/api\/books\/([^/]+)$/.exec(pathname);
    if (readerBook && request.method === "GET") {
      requirePermission("read");
      z.uuid().parse(readerBook[1]);
      return json(
        LibraryBook.parse(
          await services.rpc("app_reader_book", {
            actor: identity.id,
            target_book: readerBook[1],
          }),
        ),
      );
    }
    const chapterPage = /^\/api\/books\/([^/]+)\/chapters$/.exec(pathname);
    if (chapterPage && request.method === "GET") {
      requirePermission("read");
      z.uuid().parse(chapterPage[1]);
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .parse(url.searchParams.get("limit") ?? 200);
      return json(
        ChapterPage.parse(
          await services.rpc("app_reader_chapters", {
            actor: identity.id,
            target_book: chapterPage[1],
            page_offset: offset(),
            page_limit: limit,
          }),
        ),
      );
    }
    const cluster = /^\/api\/books\/([^/]+)\/cluster$/.exec(pathname);
    if (cluster && request.method === "GET") {
      requirePermission("read");
      z.uuid().parse(cluster[1]);
      const start = offset("start");
      if (start % 5)
        throw new AppError(
          "INVALID_INPUT",
          400,
          "Cụm chương cần bắt đầu ở bội số 5",
        );
      const args = { actor: identity.id, target_book: cluster[1] };
      const page = ChapterPage.parse(
        await services.rpc("app_reader_chapters", {
          ...args,
          page_offset: start,
          page_limit: 5,
        }),
      );
      let source = storage;
      const drive: ReaderStorage = {
        readText: async (id) => (source ??= await effectiveStorage()).readText(id),
        readBytes: async (id) => (source ??= await effectiveStorage()).readBytes(id),
      };
      const items = [];
      let bytes = 0;
      for (const chapter of page.chapters) {
        try {
          const content = await readStoredChapter(
            services,
            drive,
            identity.id,
            cluster[1],
            chapter.id,
          );
          const size = Buffer.byteLength(JSON.stringify(content));
          if (bytes + size > 2000000)
            throw new AppError(
              "CONTENT_TOO_LARGE",
              413,
              "Nội dung cụm chương quá lớn",
            );
          bytes += size;
          items.push({
            id: chapter.id,
            cacheTag: chapter.cacheTag,
            ...content,
          });
        } catch (error) {
          if (
            !(error instanceof AppError) ||
            ["FORBIDDEN", "UNAUTHENTICATED"].includes(error.code)
          )
            throw error;
          items.push({
            id: chapter.id,
            cacheTag: chapter.cacheTag,
            error: error.message,
          });
        }
      }
      await services.rpc("app_reader_book", args);
      return json({ start, items });
    }
    const chapterContent =
      /^\/api\/books\/([^/]+)\/chapters\/([^/]+)\/content$/.exec(pathname);
    if (chapterContent && request.method === "GET") {
      requirePermission("read");
      z.uuid().parse(chapterContent[1]);
      z.uuid().parse(chapterContent[2]);
      // Resolve storage lazily so a cache hit does not require a fresh Google token.
      const lazy: ReaderStorage = storage || {
        readText: async (id) => (await effectiveStorage()).readText(id),
        readBytes: async (id) => (await effectiveStorage()).readBytes(id),
      };
      return json(
        await readStoredChapter(
          services,
          lazy,
          identity.id,
          chapterContent[1],
          chapterContent[2],
        ),
      );
    }
    const cover = /^\/api\/books\/([^/]+)\/cover$/.exec(pathname);
    if (cover && request.method === "GET") {
      requirePermission("read");
      z.uuid().parse(cover[1]);
      const result = await readStoredCover(
        services,
        storage || await effectiveStorage(),
        identity.id,
        cover[1],
      );
      return new Response(Buffer.from(result.bytes), {
        headers: {
          ...headers,
          "Content-Type": result.mimeType,
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    }
    // Permission guard remains active even before business implementations land.
    if (
      pathname.startsWith("/api/download") ||
      pathname.startsWith("/api/jobs") ||
      pathname.startsWith("/api/analysis") ||
      pathname === "/api/books/from-web" ||
      pathname.endsWith("/download-actions")
    )
      requirePermission("download");
    else if (
      pathname.startsWith("/api/manage") ||
      pathname.startsWith("/api/imports") ||
      pathname === "/api/genres" ||
      (["POST", "PUT", "DELETE", "PATCH"].includes(request.method) &&
        (pathname.startsWith("/api/books") ||
          pathname.startsWith("/api/chapters")))
    )
      requirePermission("manage");
    else if (
      pathname.startsWith("/api/admin") ||
      pathname.startsWith("/api/drive") ||
      pathname.startsWith("/api/settings")
    )
      requirePermission("admin");
    else if (
      pathname.startsWith("/api/books") ||
      pathname.startsWith("/api/chapters") ||
      pathname.startsWith("/api/reader")
    )
      requirePermission("read");
    return json({ error: "NOT_IMPLEMENTED", correlationId }, 501);
  } catch (error) {
    if (error instanceof AppError)
      return json(
        { error: error.code, message: error.message, correlationId },
        error.status,
      );
    if (error instanceof z.ZodError)
      return json(
        {
          error: "INVALID_INPUT",
          message: "Dữ liệu không hợp lệ",
          correlationId,
        },
        400,
      );
    if (
      error instanceof Error &&
      "type" in error &&
      typeof error.type === "string"
    )
      return json(
        { error: error.type, message: error.message, correlationId },
        400,
      );
    return json(
      {
        error: "INTERNAL_ERROR",
        message: "Không xử lý được yêu cầu",
        correlationId,
      },
      500,
    );
  } finally {
    await services?.close?.();
  }
}
export default (request: Request) => handleApi(request);
export const config = { path: "/api/*" };

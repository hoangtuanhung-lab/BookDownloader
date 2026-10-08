import type { PoolClient } from "pg";
import {
  downloadBatch,
  promote,
  writerLock,
  writerUnlock,
  runtimeConfig,
} from "./download-runtime";
import { createHash, randomUUID } from "node:crypto";
import { AppError, BookMetadata } from "../../contracts/src/index";
import { ImportRequest, ChapterAdd } from "../../contracts/src/management";
import { analyze, manualChapters } from "../../domain/src/analysis";
import {
  cleanName_,
  normName_,
  parseImportFile_,
  cleanChapterList_,
  parseMarkedFile_,
  fillMissingNums_,
  mergeTocStory_,
  numberMarkedList_,
  parseFolderFileName_,
  pickGroup_,
  placeChapter_,
  parseOrder_,
  genreFolderName_,
  tidyChapter_,
  importFileName_,
  docChapterFile_,
} from "../../domain/src/legacy.mjs";
import {
  ensureBookFolder,
  writeChapter,
  saveImportData,
  removedLine,
} from "../../domain/src/library-storage";
import { formatBookInfo } from "../../domain/src/index";
import type { HttpFetcher } from "../../domain/src/ports";
import type { DriveFile } from "./drive";
export interface WorkflowDrive {
  folder(parent: string, name: string): Promise<string>;
  putText(
    parent: string,
    name: string,
    text: string,
    version: number,
  ): Promise<string>;
  readText(id: string): Promise<string>;
  assertUnderRoot(id: string): Promise<DriveFile>;
  checkRoot(write?: boolean): Promise<unknown>;
  list(parent: string, name?: string): Promise<DriveFile[]>;
  moveFolder(id: string, parent: string, name: string): Promise<void>;
  trashOwned(id: string): Promise<void>;
  putCover(
    parent: string,
    name: string,
    bytes: Uint8Array,
    version: number,
  ): Promise<string>;
}
export interface WorkflowOptions {
  rootId: string;
  owner: string;
  drive: WorkflowDrive;
  http: HttpFetcher;
  validateUrl: (url: string) => Promise<unknown>;
  maxItems?: number;
  maxMs?: number;
}
type Ch = {
  num: number;
  title: string;
  url?: string;
  part?: string;
  vol?: string;
  dnum?: string;
  body?: string;
  fileId?: string;
  marked?: boolean;
};
async function transaction<T>(db: PoolClient, fn: () => Promise<T>) {
  await db.query("begin");
  try {
    const v = await fn();
    await db.query("commit");
    return v;
  } catch (e) {
    await db.query("rollback");
    throw e;
  }
}
async function jobGuard(db: PoolClient, j: any) {
  const row = (
    await db.query("select * from public.jobs where id=$1 for update", [j.id])
  ).rows[0];
  if (
    !row ||
    row.status !== "running" ||
    row.cancel_requested ||
    row.lease_owner !== j.lease_owner ||
    Number(row.lease_epoch) !== Number(j.lease_epoch) ||
    new Date(row.lease_until).getTime() <= Date.now()
  )
    throw new AppError("FENCED", 409, "Tác vụ đã dừng hoặc lease hết hạn");
}
async function permission(db: PoolClient, actor: string, needed: string) {
  await db.query("select private.require_permission($1,$2)", [actor, needed]);
}
async function book(db: PoolClient, id: string, includeDeleted = false) {
  const b = (
    await db.query(
      "select * from public.books where id=$1 " +
        (includeDeleted ? "" : "and deleted_at is null") +
        " for update",
      [id],
    )
  ).rows[0];
  if (!b) throw new AppError("NOT_FOUND", 404, "Truyện đã bị xóa");
  return b;
}
async function metadata(db: PoolClient, b: any) {
  const genres = (
    await db.query(
      "select g.name from public.book_genres bg join public.genres g on g.id=bg.genre_id where bg.book_id=$1 order by bg.position",
      [b.id],
    )
  ).rows.map((r) => r.name);
  return BookMetadata.parse({
    id: b.id,
    name: b.name,
    author: b.author,
    genres,
    sourceUrl: b.source_url,
    sourceType: b.source_type,
    visibility: b.visibility,
    version: Number(b.version),
  });
}
async function group(db: PoolClient, bid: string, ch: Ch) {
  let parent: string | null = null;
  for (const [kind, name] of [
    ["PART", ch.part],
    ["VOLUME", ch.vol],
  ]) {
    if (!name) continue;
    let g: { id: string } | undefined = (
      await db.query(
        "select id from public.chapter_groups where book_id=$1 and parent_id is not distinct from $2 and kind=$3 and name=$4",
        [bid, parent, kind, name],
      )
    ).rows[0];
    if (!g)
      g = (
        await db.query(
          "insert into public.chapter_groups(book_id,parent_id,kind,name,order_key) values($1,$2,$3,$4,$5) returning id",
          [bid, parent, kind, name, ch.num],
        )
      ).rows[0];
    parent = g!.id;
  }
  return parent;
}
async function resource(
  db: PoolClient,
  o: WorkflowOptions,
  bid: string,
  kind: string,
  fid: string,
  version: number,
  cid?: string,
) {
  if (kind !== "CHAPTER")
    await db.query(
      "delete from public.drive_resources where book_id=$1 and kind=$2 and file_id<>$3",
      [bid, kind, fid],
    );
  await db
    .query(
      "insert into public.drive_resources(file_id,book_id,chapter_id,owner_subject,kind,metadata_version,sync_status) values($1,$2,$3,$4,$5,$6,'synced') on conflict(file_id) do update set metadata_version=excluded.metadata_version,sync_status='synced' where public.drive_resources.book_id=excluded.book_id and public.drive_resources.kind=excluded.kind and public.drive_resources.owner_subject=excluded.owner_subject and public.drive_resources.chapter_id is not distinct from excluded.chapter_id returning file_id",
      [fid, bid, cid || null, o.owner, kind, version],
    )
    .then((r) => {
      if (!r.rowCount)
        throw new AppError(
          "OWNERSHIP_CONFLICT",
          409,
          "File đã đăng ký cho truyện khác",
        );
    });
}
async function folder(db: PoolClient, o: WorkflowOptions, b: any) {
  if (!b.folder_id) {
    await o.drive.checkRoot(true);
    const created = await ensureBookFolder(
      o.drive,
      o.rootId,
      await metadata(db, b),
    );
    await db.query("update public.books set folder_id=$2 where id=$1", [
      b.id,
      created.folderId,
    ]);
    b.folder_id = created.folderId;
    await resource(db, o, b.id, "INFO", created.infoId, Number(b.version));
  }
  return b.folder_id as string;
}
async function upload(
  db: PoolClient,
  id: string,
  actor: string,
  purpose: string,
) {
  const u = (
    await db.query(
      "select * from private.uploads where id=$1 and actor_id=$2 and purpose=$3 and state='ready' and expires_at>now()",
      [id, actor, purpose],
    )
  ).rows[0];
  if (!u)
    throw new AppError(
      "UPLOAD_MISSING",
      404,
      "File upload hết hạn hoặc chưa hoàn tất",
    );
  const chunks = (
    await db.query(
      "select bytes from private.upload_chunks where upload_id=$1 order by chunk_index",
      [id],
    )
  ).rows.map((r) => r.bytes);
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== u.size)
    throw new AppError("UPLOAD_MISSING", 400, "File upload thiếu dữ liệu");
  return {
    name: u.name,
    text: new TextDecoder("utf8", { fatal: true }).decode(bytes),
  };
}
async function insertChapters(db: PoolClient, bid: string, chapters: Ch[]) {
  for (const ch of chapters) {
    const exists = (
      await db.query(
        "select id from public.chapters where book_id=$1 and ((source_url<>'' and source_url=$2) or order_key=$3)",
        [bid, ch.url || "", ch.num],
      )
    ).rows[0];
    if (exists) continue;
    await db.query(
      "insert into public.chapters(book_id,group_id,legacy_order,order_key,display_number,title,source_url,status,file_id) values($1,$2,$3,$3,$4,$5,$6,$7,$8)",
      [
        bid,
        await group(db, bid, ch),
        ch.num,
        String(ch.dnum ?? ""),
        ch.title || "",
        ch.url || "",
        ch.fileId ? "DONE" : "PENDING",
        ch.fileId || null,
      ],
    );
  }
}
async function establishImport(db: PoolClient, o: WorkflowOptions, j: any) {
  const request = ImportRequest.parse(j.checkpoint.request),
    cfg = (
      await db.query(
        "select value from public.app_settings where key='analysis'",
      )
    ).rows[0].value;
  let chapters: Ch[] = [],
    label = "Chương",
    name = cleanName_(request.name),
    skipped = 0,
    extra = 0;
  if (request.folder) {
    const f = await o.drive.assertUnderRoot(request.folder);
    if (
      f.mimeType !== "application/vnd.google-apps.folder" ||
      f.capabilities?.canAddChildren !== true ||
      request.folder === o.rootId
    )
      throw new AppError(
        "DRIVE_FORBIDDEN",
        403,
        "Cần thư mục con có quyền ghi",
      );
    name = name || cleanName_(f.name);
    const seen = new Set<number>();
    for (const file of await o.drive.list(request.folder)) {
      if (
        file.mimeType === "application/vnd.google-apps.folder" ||
        /^(info\.txt|_import\.json|_Chương lỗi đã xóa\.txt|cover[-.]|bìa)/i.test(
          file.name,
        ) ||
        file.mimeType.startsWith("image/")
      ) {
        skipped++;
        continue;
      }
      const p = parseFolderFileName_(file.name);
      if (!p || seen.has(p.num)) {
        skipped++;
        continue;
      }
      seen.add(p.num);
      chapters.push({ num: p.num, title: p.title, fileId: file.id });
      if (p.label === "Hồi") label = "Hồi";
    }
    chapters.sort((a, b) => a.num - b.num);
  } else {
    const f = await upload(db, request.upload!, j.actor_id, "import");
    if (request.toc) {
      const t = await upload(db, request.toc, j.actor_id, "toc"),
        toc = parseMarkedFile_(t.text, "mục lục"),
        story = parseMarkedFile_(f.text, "truyện");
      fillMissingNums_(toc.items);
      fillMissingNums_(story.items);
      const merged = mergeTocStory_(toc.items, story.items),
        all = numberMarkedList_(merged.list);
      chapters = cleanChapterList_(all, cfg);
      label = toc.label;
      skipped = merged.missing + all.length - chapters.length;
      extra = merged.extra;
    } else {
      const parsed = parseImportFile_(
        f.name.split(".").pop()!.toLowerCase(),
        f.text,
      );
      chapters = cleanChapterList_(parsed.chapters, cfg);
      label = parsed.label;
    }
  }
  if (!chapters.length || chapters.length > 20000)
    throw new AppError(
      "IMPORT_INVALID",
      422,
      "Không có chương hợp lệ hoặc vượt 20000 chương",
    );
  const creating = !j.book_id;
  let b: any;
  await transaction(db, async () => {
    await permission(db, j.actor_id, "manage");
    await jobGuard(db, j);
    b = j.book_id
      ? await book(db, j.book_id)
      : (
          await db.query(
            "insert into public.books(name,normalized_name,author,source_type,label,folder_id,download_status) values($1,$2,$3,$4,$5,$6,$7) returning *",
            [
              name,
              normName_(name),
              request.author,
              request.folder ? "FOLDER" : "FILE",
              label,
              request.folder || null,
              request.folder ? "DONE" : "QUEUED",
            ],
          )
        ).rows[0];
    if (creating)
      await db.query("select private.set_genres($1,$2)", [
        b.id,
        JSON.stringify(request.genres),
      ]);
    j.book_id = b.id;
    j.checkpoint = { ...j.checkpoint, preparing: true };
    await db.query(
      "update public.jobs set book_id=$2,checkpoint=$3 where id=$1",
      [j.id, b.id, j.checkpoint],
    );
  });
  const locked = await writerLock(db, b.id);
  if (!locked) throw new AppError("FENCED", 409, "Truyện đang được đồng bộ");
  try {
    await folder(db, o, b);
    const info = await o.drive.putText(
      b.folder_id,
      "info.txt",
      formatBookInfo(await metadata(db, b)),
      Number(b.version),
    );
    await resource(db, o, b.id, "INFO", info, Number(b.version));
    let importId: string | null = null;
    if (!request.folder) {
      importId = await saveImportData(
        o.drive,
        b.folder_id,
        chapters,
        Number(b.version),
      );
      await resource(db, o, b.id, "IMPORT", importId, Number(b.version));
    }
    await transaction(db, async () => {
      await permission(db, j.actor_id, "manage");
      const now = await book(db, b.id);
      await jobGuard(db, j);
      if (Number(now.version) !== Number(b.version))
        throw new AppError("FENCED", 409, "Thông tin import đã thay đổi");
      await insertChapters(db, b.id, chapters);
      if (request.folder)
        for (const c of (
          await db.query("select * from public.chapters where book_id=$1", [
            b.id,
          ])
        ).rows)
          await resource(
            db,
            o,
            b.id,
            "CHAPTER",
            c.file_id,
            Number(c.content_version),
            c.id,
          );
      j.book_id = b.id;
      j.checkpoint = {
        ...j.checkpoint,
        preparing: false,
        importId,
        result: { bookId: b.id, found: chapters.length, skipped, extra },
      };
      await db.query(
        "update public.jobs set book_id=$2,checkpoint=$3 where id=$1",
        [j.id, b.id, j.checkpoint],
      );
      await db.query(
        "insert into public.audit_logs(actor_id,action,entity_id,details) values($1,'import_created',$2,$3)",
        [j.actor_id, b.id, j.checkpoint.result],
      );
    });
  } finally {
    await writerUnlock(db, b.id);
  }
}
async function add(db: PoolClient, o: WorkflowOptions, j: any) {
  if (j.checkpoint.result?.chapterId) {
    await permission(db, j.actor_id, "manage");
    await book(db, j.book_id);
    return;
  }
  const { id: _bookId, ...input } = j.checkpoint.add,
    request = ChapterAdd.parse(input);
  let body = request.text;
  if (request.kind === "file")
    body = (await upload(db, request.upload!, j.actor_id, "chapter")).text;
  if (body !== undefined) {
    body = body
      .replace(/\r\n?/g, "\n")
      .replace(/\u0000/g, "")
      .trim();
    if (!body || body.length > 300000)
      throw new AppError(
        "INVALID_INPUT",
        400,
        "Nội dung chương cần từ 1–300000 ký tự",
      );
    const cfg = (
        await db.query(
          "select value from public.app_settings where key='analysis'",
        )
      ).rows[0].value,
      cleaned = tidyChapter_(body, cfg.JUNK_WORDS);
    body = cleaned.body?.trim() || body;
    if (!request.title) request.title = cleanName_(cleaned.title);
  }
  if (request.url) await o.validateUrl(request.url);
  let b: any,
    prepared: any = j.checkpoint.addPrepared;
  await transaction(db, async () => {
    await permission(db, j.actor_id, "manage");
    b = await book(db, j.book_id);
    await jobGuard(db, j);
    if (Number(b.version) !== request.version)
      throw new AppError("CONFLICT", 409, "Thông tin truyện đã thay đổi");
    if (request.url && b.source_type === "FILE")
      throw new AppError("INVALID_INPUT", 400, "FILE không thêm từ link");
    if (!prepared) {
      const rows = (
        await db.query(
          "select c.*,coalesce(p.name,case when g.kind='PART' then g.name end,'') as part,coalesce(case when g.kind='VOLUME' then g.name end,'') as vol from public.chapters c left join public.chapter_groups g on g.id=c.group_id left join public.chapter_groups p on p.id=g.parent_id where c.book_id=$1 order by c.order_key",
          [b.id],
        )
      ).rows.map((c) => [
        b.id,
        Number(c.order_key),
        c.title,
        c.source_url,
        c.status,
        c.file_id,
        c.retry_count,
        c.error_code,
        "",
        c.part,
        c.vol,
        c.display_number,
      ]);
      const g = pickGroup_(rows, {
          part: request.part,
          vol: request.volume,
          newPart: request.newPart,
          newVol: request.newVolume,
        }),
        pos = placeChapter_(rows, g, parseOrder_(request.order));
      const ch: Ch = {
        num: pos.num,
        dnum: String(pos.dnum),
        title: request.title,
        part: g.part,
        vol: g.vol,
        url: request.url,
        marked: pos.dnum !== "",
      };
      prepared = {
        id: randomUUID(),
        group: await group(db, b.id, ch),
        ch,
        epoch: Number(b.control_epoch),
      };
      await db.query(
        "update public.jobs set checkpoint=checkpoint||jsonb_build_object('addPrepared',$2::jsonb) where id=$1",
        [j.id, JSON.stringify(prepared)],
      );
      j.checkpoint.addPrepared = prepared;
    }
  });
  let fid: string | undefined;
  if (body) {
    await folder(db, o, b);
    let target = b.folder_id;
    for (const g of [prepared.ch.part, prepared.ch.vol])
      if (cleanName_(g)) target = await o.drive.folder(target, cleanName_(g));
    const name = importFileName_(b.label, prepared.ch),
      matches = await o.drive.list(target, name);
    for (const match of matches) {
      const r = (
        await db.query(
          "select * from public.drive_resources where file_id=$1",
          [match.id],
        )
      ).rows[0];
      if (r && (r.chapter_id !== prepared.id || r.owner_subject !== o.owner))
        throw new AppError(
          "OWNERSHIP_CONFLICT",
          409,
          "File chương thuộc tài nguyên khác",
        );
    }
    fid = await o.drive.putText(
      target,
      name,
      docChapterFile_(b.name, b.label, { ...prepared.ch, body }),
      Number(b.version) + 1,
    );
  }
  await transaction(db, async () => {
    await permission(db, j.actor_id, "manage");
    const current = await book(db, b.id);
    await jobGuard(db, j);
    if (
      Number(current.version) !== request.version ||
      Number(current.control_epoch) !== prepared.epoch
    )
      throw new AppError(
        "CONFLICT",
        409,
        "Thông tin truyện đã thay đổi trước khi lưu chương",
      );
    const ch = prepared.ch;
    const c = (
      await db.query(
        "insert into public.chapters(id,book_id,group_id,legacy_order,order_key,display_number,title,source_url,status,file_id) values($1,$2,$3,$4,$4,$5,$6,$7,$8,$9) returning *",
        [
          prepared.id,
          b.id,
          prepared.group,
          ch.num,
          ch.dnum,
          ch.title,
          ch.url || "",
          fid ? "DONE" : "PENDING",
          fid || null,
        ],
      )
    ).rows[0];
    if (fid)
      await resource(
        db,
        o,
        b.id,
        "CHAPTER",
        fid,
        Number(c.content_version),
        c.id,
      );
    await db.query(
      "update public.books set version=version+1,updated_at=now() where id=$1",
      [b.id],
    );
    await db.query("select private.enqueue_sync($1,$2)", [
      b.id,
      Number(b.version) + 1,
    ]);
    await db.query(
      "insert into public.audit_logs(actor_id,action,entity_id) values($1,'chapter_add',$2)",
      [j.actor_id, b.id],
    );
    if (request.url) {
      await db.query(
        "insert into public.jobs(kind,actor_id,book_id,dedupe_key,checkpoint) values('WEB_DOWNLOAD',$1,$2,$3,$4) on conflict(dedupe_key) do update set status='queued',actor_id=excluded.actor_id,cancel_requested=false,lease_owner=null,lease_until=null,next_run_at=now(),checkpoint=public.jobs.checkpoint-'work'-'error'||excluded.checkpoint",
        [
          j.actor_id,
          b.id,
          "download:" + b.id,
          JSON.stringify({
            mode: "download",
            manualLinks: b.source_type === "FOLDER",
            manualBatch: true,
          }),
        ],
      );
      await db.query(
        "update public.books set download_status='IDLE' where id=$1",
        [b.id],
      );
    }
    j.checkpoint.result = { chapterId: c.id };
    await db.query(
      "update public.jobs set checkpoint=$2::jsonb-'addPrepared' where id=$1",
      [j.id, JSON.stringify(j.checkpoint)],
    );
  });
}
async function importBatch(
  db: PoolClient,
  o: WorkflowOptions,
  j: any,
  deadline: number,
) {
  if (j.checkpoint.mode === "verify") return downloadBatch(db, o, j, deadline);
  if (j.checkpoint.add) {
    await add(db, o, j);
    return true;
  }
  const initial = !j.book_id;
  if (initial || j.checkpoint.preparing) await establishImport(db, o, j);
  if (!j.checkpoint.importId) return true;
  let locked = false;
  try {
    if (initial) {
      locked = await writerLock(db, j.book_id);
      if (!locked) return false;
    }
    await promote(db);
    const current = (
      await db.query("select download_status from public.books where id=$1", [
        j.book_id,
      ])
    ).rows[0];
    if (!["READY", "DOWNLOADING"].includes(current.download_status))
      return false;
    return await downloadBatch(db, o, j, deadline);
  } finally {
    if (locked) await writerUnlock(db, j.book_id);
  }
}
async function analysisJob(
  db: PoolClient,
  o: WorkflowOptions,
  j: any,
  signal: AbortSignal,
  deadline: number,
) {
  const request = j.checkpoint.request,
    cfg =
      j.checkpoint.analysisConfig ||
      (
        await db.query(
          "select value from public.app_settings where key='analysis'",
        )
      ).rows[0].value;
  if (!j.checkpoint.analysisConfig)
    await db.query(
      "update public.jobs set checkpoint=checkpoint||jsonb_build_object('analysisConfig',$2::jsonb) where id=$1 and status='running'",
      [j.id, JSON.stringify(cfg)],
    );
  const result =
    request.mode === "manual"
      ? {
          name: request.name,
          author: "",
          genres: [],
          sourceUrl:
            new URL(request.url).origin +
            new URL(request.url).pathname.replace(/[^/]*$/, ""),
          chapters: manualChapters(request.url, request.total),
          notes: [],
        }
      : await analyze(request.url, o.http, cfg, signal, {
          resume: j.checkpoint.discovery,
          shouldYield: () => Date.now() > deadline - 17000,
          checkpoint: async (state) => {
            await transaction(db, async () => {
              await permission(db, j.actor_id, "download");
              const changed = await db.query(
                "update public.jobs set checkpoint=checkpoint||jsonb_build_object('discovery',$2::jsonb),lease_until=now()+interval '90 seconds' where id=$1 and status='running' and lease_owner=$3 and lease_epoch=$4 and lease_until>now()",
                [j.id, JSON.stringify(state), j.lease_owner, j.lease_epoch],
              );
              if (!changed.rowCount)
                throw new AppError("CANCELLED", 409, "Tác vụ đã bị bỏ");
            });
          },
        });
  if ("pending" in result) return false;
  for (const c of result.chapters) {
    signal.throwIfAborted();
    await o.validateUrl(c.url);
  }
  let b: any, bookHeld: string | undefined;
  const acquire = async (id: string) => {
    if (!(await writerLock(db, id)))
      throw new AppError("FENCED", 409, "Truyện đang có worker ghi");
    bookHeld = id;
  };
  try {
    await transaction(db, async () => {
      await permission(db, j.actor_id, "download");
      const job = (
        await db.query(
          "select status,lease_owner,lease_epoch,lease_until from public.jobs where id=$1",
          [j.id],
        )
      ).rows[0];
      if (
        job.status !== "running" ||
        job.lease_owner !== j.lease_owner ||
        Number(job.lease_epoch) !== Number(j.lease_epoch) ||
        new Date(job.lease_until).getTime() <= Date.now()
      )
        throw new AppError("CANCELLED", 409, "Tác vụ đã bị bỏ");
      b = (
        await db.query(
          "select * from public.books where source_url=$1 and deleted_at is null for update",
          [result.sourceUrl],
        )
      ).rows[0];
      if (b) await acquire(b.id);
      if (!b) {
        b = (
          await db.query(
            "insert into public.books(name,normalized_name,author,source_type,source_url,download_status) values($1,$2,$3,'WEB',$4,'ANALYZED') returning *",
            [
              cleanName_(result.name),
              normName_(cleanName_(result.name)),
              result.author.slice(0, 100),
              result.sourceUrl,
            ],
          )
        ).rows[0];
        await acquire(b.id);
        await db.query("select private.set_genres($1,$2)", [
          b.id,
          JSON.stringify(result.genres),
        ]);
      } else {
        const existing = (
          await db.query(
            "select id,order_key,source_url from public.chapters where book_id=$1",
            [b.id],
          )
        ).rows;
        const byUrl = new Map(result.chapters.map((c: Ch) => [c.url, c.num]));
        const changes = existing.filter(
          (c) =>
            byUrl.has(c.source_url) &&
            Number(c.order_key) !== byUrl.get(c.source_url),
        );
        for (let i = 0; i < changes.length; i++)
          await db.query(
            "update public.chapters set order_key=$2 where id=$1",
            [changes[i].id, -1000000000 - i],
          );
        for (const c of changes)
          await db.query(
            "update public.chapters set order_key=$2,legacy_order=$2 where id=$1",
            [c.id, byUrl.get(c.source_url)],
          );
        await db
          .query(
            "update public.books set version=version+1,updated_at=now() where id=$1 returning version",
            [b.id],
          )
          .then((r) => (b.version = r.rows[0].version));
      }
      await insertChapters(db, b.id, result.chapters);
    });

    await permission(db, j.actor_id, "download");
    const live = await book(db, b.id);
    if (Number(live.version) !== Number(b.version))
      throw new AppError("FENCED", 409, "Thông tin truyện đã thay đổi");
    await folder(db, o, b);
    const fid = await o.drive.putText(
      b.folder_id,
      "info.txt",
      formatBookInfo(await metadata(db, b)),
      Number(b.version),
    );
    await transaction(db, async () => {
      await permission(db, j.actor_id, "download");
      const now = await book(db, b.id);
      await jobGuard(db, j);
      if (Number(now.version) !== Number(b.version))
        throw new AppError("FENCED", 409, "Thông tin truyện đã thay đổi");
      await resource(db, o, b.id, "INFO", fid, Number(b.version));
      await db.query(
        "update public.jobs set book_id=$2,checkpoint=checkpoint||$3 where id=$1",
        [
          j.id,
          b.id,
          JSON.stringify({
            result: { notes: result.notes, found: result.chapters.length },
          }),
        ],
      );
      await db.query(
        "insert into public.audit_logs(actor_id,action,entity_id,details) values($1,'analysis_hold',$2,$3)",
        [j.actor_id, b.id, JSON.stringify({ notes: result.notes })],
      );
    });
  } finally {
    if (bookHeld) await writerUnlock(db, bookHeld);
  }
  return true;
}
async function outbox(db: PoolClient, o: WorkflowOptions, item: any) {
  const b = await book(
      db,
      item.book_id,
      ["TRASH", "CHAPTER_TRASH"].includes(item.kind),
    ),
    v = Number(b.version);
  const current = async () => {
    const now = await book(
      db,
      b.id,
      ["TRASH", "CHAPTER_TRASH"].includes(item.kind),
    );
    const op = (
      await db.query(
        "select status,lease_owner,lease_until from public.outbox_operations where id=$1",
        [item.id],
      )
    ).rows[0];
    if (
      Number(now.version) !== v ||
      !op ||
      op.status !== "running" ||
      op.lease_owner !== item.lease_owner ||
      new Date(op.lease_until).getTime() <= Date.now()
    )
      throw new AppError(
        "FENCED",
        409,
        "Thông tin hoặc lease đồng bộ đã thay đổi",
      );
    return now;
  };
  const pending: {
    kind: string;
    fid: string;
    version: number;
    hash?: string;
  }[] = [];
  let coverDelete: string | undefined;
  if (item.kind === "TRASH") {
    if (!b.deleted_at || b.folder_id !== item.payload.folder)
      throw new AppError("OWNERSHIP_CONFLICT", 409, "Thư mục không còn khớp");
    await current();
    if (b.folder_id)
      try {
        await o.drive.trashOwned(b.folder_id);
      } catch (e) {
        if (!(e instanceof AppError) || e.code !== "DRIVE_NOT_FOUND") throw e;
      }
  } else if (item.kind === "CHAPTER_TRASH") {
    if (item.payload.owner !== o.owner || item.payload.file === o.rootId)
      throw new AppError(
        "OWNERSHIP_CONFLICT",
        403,
        "File không thuộc chủ thư viện",
      );
    const mapped = (
      await db.query(
        "select book_id from public.drive_resources where file_id=$1",
        [item.payload.file],
      )
    ).rows[0];
    if (mapped)
      throw new AppError("OWNERSHIP_CONFLICT", 409, "File đã được đăng ký lại");
    await current();
    try {
      await o.drive.trashOwned(item.payload.file);
    } catch (e) {
      if (!(e instanceof AppError) || e.code !== "DRIVE_NOT_FOUND") throw e;
    }
  } else if (item.kind === "BOOK_SYNC") {
    await folder(db, o, b);
    const meta = await metadata(db, b),
      genre = await o.drive.folder(
        o.rootId,
        genreFolderName_(meta.genres.join(", ")),
      );
    await current();
    await o.drive.moveFolder(b.folder_id, genre, cleanName_(b.name));
    await current();
    pending.push({
      kind: "INFO",
      fid: await o.drive.putText(
        b.folder_id,
        "info.txt",
        formatBookInfo(meta),
        v,
      ),
      version: v,
    });
    const removed = (
      await db.query(
        "select * from public.removed_chapters where book_id=$1 order by removed_at,id",
        [b.id],
      )
    ).rows;
    if (removed.length) {
      const lines = removed.map((r) =>
        removedLine(
          {
            num: Number(r.legacy_order),
            dnum: r.display_number,
            title: r.title,
            url: r.details.source_url,
            reason: r.reason,
            part: r.details.part,
            vol: r.details.vol,
          },
          { now: () => new Date(r.removed_at) },
        ),
      );
      const text =
        'Các chương lỗi đã bị xóa khỏi truyện "' +
        b.name +
        '".\nMỗi dòng: thời điểm | chương | phần › quyển | tiêu đề | link | lý do.\n\n' +
        lines.join("\n") +
        "\n";
      await current();
      pending.push({
        kind: "REMOVED_LOG",
        fid: await o.drive.putText(
          b.folder_id,
          "_Chương lỗi đã xóa.txt",
          text,
          v,
        ),
        version: v,
      });
    }
  } else if (item.kind === "COVER") {
    const newest = (
      await db.query(
        "select id from public.outbox_operations where book_id=$1 and kind='COVER' order by (payload->>'version')::bigint desc limit 1",
        [b.id],
      )
    ).rows[0];
    if (newest.id !== item.id) return;
    const old = (
      await db.query(
        "select * from public.drive_resources where book_id=$1 and kind='COVER'",
        [b.id],
      )
    ).rows[0];
    if (item.payload.asset) {
      const asset = (
        await db.query(
          "select * from private.cover_assets where id=$1 and book_id=$2",
          [item.payload.asset, b.id],
        )
      ).rows[0];
      if (!asset)
        throw new AppError("ASSET_MISSING", 404, "Ảnh bìa đã hết hạn");
      await folder(db, o, b);
      await current();
      const fid = await o.drive.putCover(
        b.folder_id,
        "cover-" + item.payload.version + ".webp",
        asset.bytes,
        item.payload.version,
      );
      pending.push({
        kind: "COVER",
        fid,
        version: item.payload.version,
        hash: createHash("sha256").update(asset.bytes).digest("hex"),
      });
      if (old && old.file_id !== fid) {
        if (old.owner_subject !== o.owner)
          throw new AppError("OWNERSHIP_CONFLICT", 403, "Bìa thuộc chủ khác");
        coverDelete = old.file_id;
      }
    } else if (old) {
      if (old.owner_subject !== o.owner)
        throw new AppError("OWNERSHIP_CONFLICT", 403, "Bìa thuộc chủ khác");
      coverDelete = old.file_id;
    }
    if (coverDelete) {
      await current();
      try {
        await o.drive.trashOwned(coverDelete);
      } catch (e) {
        if (!(e instanceof AppError) || e.code !== "DRIVE_NOT_FOUND") throw e;
      }
    }
  }
  await transaction(db, async () => {
    await current();
    for (const p of pending) {
      await resource(db, o, b.id, p.kind, p.fid, p.version);
      if (p.hash)
        await db.query(
          "update public.drive_resources set content_hash=$2 where file_id=$1",
          [p.fid, p.hash],
        );
    }
    if (coverDelete && !pending.some((p) => p.kind === "COVER"))
      await db.query(
        "delete from public.drive_resources where file_id=$1 and book_id=$2",
        [coverDelete, b.id],
      );
  });
}
/** Finite executor. Per-book writer lock, short claim transaction and fenced leases.
 * Downloads commit checkpoints outside remote IO; separate FILE/WEB admission caps. */
async function runWorkflowsUnlocked(db: PoolClient, o: WorkflowOptions) {
  const worker = randomUUID(),
    deadline = Date.now() + (o.maxMs ?? 45000);
  let processed = 0,
    busy = false;
  await db.query(
    "delete from private.uploads where expires_at<now(); delete from private.cover_assets a where (expires_at<now() and book_id is null) or (created_at<now()-interval '24 hours' and book_id is not null and not exists(select 1 from public.outbox_operations o where o.payload->>'asset'=a.id::text and o.status<>'done'))",
  );
  await db.query(
    "with cancelled as (update public.jobs j set status='cancelled',cancel_requested=true,lease_owner=null,lease_until=null,checkpoint=checkpoint||jsonb_build_object('error','Quyền tác vụ đã bị thu hồi') where kind in ('ANALYZE','FILE_IMPORT','WEB_DOWNLOAD') and (status='queued' or status='running' and lease_until<now()) and not private.job_actor_allowed(j.actor_id,j.kind,j.book_id,j.checkpoint) returning book_id,kind) update public.books set download_status='PAUSED',control_epoch=control_epoch+1 where deleted_at is null and id in (select book_id from cancelled where kind in ('FILE_IMPORT','WEB_DOWNLOAD'))",
  );
  await promote(db);
  const seen = new Set<string>();
  while (Date.now() < deadline && processed < 10) {
    const candidates = (
      await db.query(
        "select j.* from public.jobs j left join public.books b on b.id=j.book_id where j.kind in ('ANALYZE','FILE_IMPORT','WEB_DOWNLOAD') and not j.cancel_requested and j.next_run_at<=now() and (j.status='queued' or j.status='running' and j.lease_until<now()) and (j.kind='ANALYZE' or j.book_id is null or j.checkpoint ? 'add' or j.checkpoint->>'mode'='verify' or b.download_status in ('READY','DOWNLOADING')) order by j.priority desc,j.created_at,j.id limit 50",
      )
    ).rows;
    let j: any = null,
      key = "";
    for (const row of candidates) {
      if (seen.has(row.id)) continue;
      key = row.book_id || row.id;
      if (!(await writerLock(db, key))) {
        busy = true;
        continue;
      }
      try {
        j = await transaction(db, async () => {
          const claimed = (
            await db.query(
              "update public.jobs set status='running',attempts=attempts+1,lease_owner=$2,lease_epoch=lease_epoch+1,lease_until=now()+interval '90 seconds' where id=$1 and not cancel_requested and (status='queued' or status='running' and lease_until<now()) returning *",
              [row.id, worker],
            )
          ).rows[0];
          if (
            claimed &&
            !(
              await db.query(
                "select private.job_actor_allowed($1,$2,$3,$4) as ok",
                [
                  claimed.actor_id,
                  claimed.kind,
                  claimed.book_id,
                  claimed.checkpoint,
                ],
              )
            ).rows[0].ok
          )
            throw new AppError("FORBIDDEN", 403, "Quyền tác vụ đã bị thu hồi");
          return claimed;
        });
      } catch (e) {
        await writerUnlock(db, key);
        if (e instanceof AppError && e.code === "FORBIDDEN") {
          await db.query(
            "update public.jobs set status='cancelled',cancel_requested=true,lease_owner=null,lease_until=null where id=$1 and status='queued'",
            [row.id],
          );
          continue;
        }
        throw e;
      }
      if (j) break;
      await writerUnlock(db, key);
    }
    if (!j) break;
    seen.add(j.id);
    try {
      let done = true;
      if (j.kind === "ANALYZE")
        done = await analysisJob(
          db,
          o,
          j,
          AbortSignal.timeout(Math.max(1, deadline - Date.now())),
          deadline,
        );
      else if (j.kind === "FILE_IMPORT")
        done = await importBatch(db, o, j, deadline);
      else done = await downloadBatch(db, o, j, deadline);
      await db.query(
        "update public.jobs set status=$3,lease_owner=null,lease_until=null where id=$1 and lease_owner=$2 and lease_epoch=$4",
        [j.id, worker, done ? "done" : "queued", j.lease_epoch],
      );
    } catch (e) {
      const code = e instanceof AppError ? e.code : "UNKNOWN_ERROR";
      if (code === "FENCED") {
        await db.query(
          "update public.jobs set status='queued',lease_owner=null,lease_until=null,checkpoint=checkpoint-'work',next_run_at=now() where id=$1 and lease_owner=$2 and lease_epoch=$3",
          [j.id, worker, j.lease_epoch],
        );
      } else {
        const cfg = await runtimeConfig(db),
          attempt = Number(j.checkpoint.driveErrors || 0) + 1;
        const retry =
          [
            "DRIVE_UNAVAILABLE",
            "DRIVE_RATE_LIMIT",
            "DRIVE_TIMEOUT",
            "CRASH",
          ].includes(code) && attempt < cfg.MAX_RETRY;
        await db.query(
          "update public.jobs set status=$3,lease_owner=null,lease_until=null,next_run_at=now()+interval '5 seconds',checkpoint=checkpoint||$4 where id=$1 and lease_owner=$2 and lease_epoch=$5",
          [
            j.id,
            worker,
            retry ? "queued" : "failed",
            JSON.stringify({
              driveErrors: attempt,
              error:
                e instanceof AppError
                  ? e.message
                  : "Không xử lý được tác vụ; kiểm tra kết nối hoặc định dạng",
            }),
            j.lease_epoch,
          ],
        );
        if (j.book_id && !retry && j.kind !== "ANALYZE" && !j.checkpoint.add)
          await db.query(
            "update public.books set download_status='ERROR' where id=$1 and deleted_at is null and download_status<>'PAUSED'",
            [j.book_id],
          );
      }
    } finally {
      await writerUnlock(db, key);
    }
    processed++;
    await promote(db);
  }
  const operations = (
    await db.query(
      "select * from public.outbox_operations where private.migration_write_allowed(book_id) and next_run_at<=now() and (status='pending' or status='running' and lease_until<now()) order by next_run_at,id limit 20",
    )
  ).rows;
  for (const candidate of operations) {
    if (Date.now() >= deadline) break;
    if (!(await writerLock(db, candidate.book_id))) {
      busy = true;
      continue;
    }
    try {
      const item = (
        await db.query(
          "update public.outbox_operations set status='running',attempts=attempts+1,lease_owner=$2,lease_until=now()+interval '90 seconds' where id=$1 and private.migration_write_allowed(book_id) and (status='pending' or status='running' and lease_until<now()) returning *",
          [candidate.id, worker],
        )
      ).rows[0];
      if (!item) continue;
      try {
        await outbox(db, o, item);
        await db.query(
          "update public.outbox_operations set status='done',lease_owner=null,lease_until=null where id=$1 and lease_owner=$2",
          [item.id, worker],
        );
      } catch {
        await db.query(
          "update public.outbox_operations set status=case when attempts>=3 then 'failed' else 'pending' end,next_run_at=now()+interval '5 seconds',lease_owner=null,lease_until=null where id=$1 and lease_owner=$2",
          [item.id, worker],
        );
      }
      processed++;
    } finally {
      await writerUnlock(db, candidate.book_id);
    }
  }
  return { processed, busy };
}

/** Session lock spans finite remote IO. Maintenance never interrupts a half-written pass. */
export async function runWorkflows(db:PoolClient,o:WorkflowOptions){
 const locked=(await db.query('select pg_try_advisory_lock_shared(610090001) as ok')).rows[0].ok;
 if(!locked)return {processed:0,busy:true,maintenance:true};
 try{
  const state=(await db.query('select maintenance,root_id from private.runtime_control where singleton')).rows[0];
  if(state.maintenance)return {processed:0,busy:false,maintenance:true};
  if(state.root_id&&state.root_id!==o.rootId)throw new AppError('ROOT_CHANGED',409,'Thư mục gốc đã thay đổi; khởi tạo lại worker');
  return await runWorkflowsUnlocked(db,o);
 }finally{await db.query('select pg_advisory_unlock_shared(610090001)');}
}

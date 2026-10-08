import type { PoolClient } from "pg";
import { AppError, BookMetadata } from "../../contracts/src/index";
import {
  parsedDownload,
  retryDecision,
  emptyChapterIds,
  contentHash,
} from "../../domain/src/download";
import { writeChapter } from "../../domain/src/library-storage";
import { formatBookInfo } from "../../domain/src/index";
import {
  importFileName_,
  docChapterFile_,
  cleanName_,
} from "../../domain/src/legacy.mjs";
import type { WorkflowOptions } from "./workflows";
export async function tx<T>(db: PoolClient, fn: () => Promise<T>) {
  await db.query("begin");
  try {
    const r = await fn();
    await db.query("commit");
    return r;
  } catch (e) {
    await db.query("rollback");
    throw e;
  }
}
const lockKey = (id: string) => "book-writer:" + id;
export async function writerLock(db: PoolClient, id: string) {
  return (
    await db.query(
      "select pg_try_advisory_lock(hashtextextended($1,0)) as ok",
      [lockKey(id)],
    )
  ).rows[0].ok as boolean;
}
export async function writerUnlock(db: PoolClient, id: string) {
  await db.query("select pg_advisory_unlock(hashtextextended($1,0))", [
    lockKey(id),
  ]);
}
export async function runtimeConfig(db: PoolClient) {
  const rows = (
    await db.query(
      "select key,value from public.app_settings where key in ('download','analysis')",
    )
  ).rows;
  return {
    ...rows.find((r) => r.key === "analysis")?.value,
    ...rows.find((r) => r.key === "download")?.value,
  };
}
export async function promote(db: PoolClient) {
  await tx(db, async () => {
    await db.query("select pg_advisory_xact_lock(71007002)");
    const cfg = await runtimeConfig(db);
    for (const source of ["WEB", "FILE"]) {
      const cap = source === "FILE" ? cfg.FILE_CONCURRENT : cfg.MAX_CONCURRENT;
      const active = Number(
        (
          await db.query(
            "select count(*) from public.books where (source_type=$1 or $1='WEB' and source_type='FOLDER') and deleted_at is null and download_status in ('READY','DOWNLOADING') and exists(select 1 from public.jobs j where j.book_id=public.books.id and j.kind in ('WEB_DOWNLOAD','FILE_IMPORT') and j.status in ('queued','running') and not j.cancel_requested)",
            [source],
          )
        ).rows[0].count,
      );
      await db.query(
        "update public.books set download_status='READY' where id in (select b.id from public.books b join public.jobs j on j.book_id=b.id where (b.source_type=$1 or $1='WEB' and b.source_type='FOLDER' and j.checkpoint->>'manualLinks'='true') and b.deleted_at is null and b.download_status in ('IDLE','QUEUED') and j.kind in ('WEB_DOWNLOAD','FILE_IMPORT') and j.status in ('queued','running') and not j.cancel_requested order by j.priority desc,j.created_at,j.id limit $2 for update of b skip locked)",
        [source, Math.max(0, cap - active)],
      );
    }
  });
}
export async function guard(db: PoolClient, j: any, epoch?: number) {
  const row = (
    await db.query(
      "select b.*,j.status as job_status,j.lease_owner,j.lease_epoch,j.cancel_requested,j.lease_until from public.books b join public.jobs j on j.book_id=b.id where j.id=$1",
      [j.id],
    )
  ).rows[0];
  if (
    !row ||
    row.deleted_at ||
    row.cancel_requested ||
    row.job_status !== "running" ||
    row.lease_owner !== j.lease_owner ||
    Number(row.lease_epoch) !== Number(j.lease_epoch) ||
    new Date(row.lease_until).getTime() <= Date.now() ||
    (row.download_status === "PAUSED" && j.checkpoint.mode !== "verify") ||
    (epoch !== undefined && Number(row.control_epoch) !== epoch)
  )
    throw new AppError("FENCED", 409, "Tác vụ đã dừng hoặc dữ liệu thay đổi");
  if (
    !(
      await db.query("select private.job_actor_allowed($1,$2,$3,$4) as ok", [
        j.actor_id,
        j.kind,
        j.book_id,
        j.checkpoint,
      ])
    ).rows[0].ok
  )
    throw new AppError("FORBIDDEN", 403, "Quyền tác vụ đã bị thu hồi");
  return row;
}
async function touch(db: PoolClient, j: any) {
  const r = await db.query(
    "update public.jobs set lease_until=now()+interval '90 seconds' where id=$1 and lease_owner=$2 and lease_epoch=$3 and status='running' and lease_until>now()",
    [j.id, j.lease_owner, j.lease_epoch],
  );
  if (!r.rowCount) throw new AppError("FENCED", 409, "Lease đã hết");
}
async function chapters(db: PoolClient, bid: string) {
  return (
    await db.query(
      "select c.*,coalesce(p.name,case when g.kind='PART' then g.name end,'') as part,coalesce(case when g.kind='VOLUME' then g.name end,'') as vol from public.chapters c left join public.chapter_groups g on g.id=c.group_id left join public.chapter_groups p on p.id=g.parent_id where c.book_id=$1 order by c.order_key",
      [bid],
    )
  ).rows;
}
async function register(
  db: PoolClient,
  o: WorkflowOptions,
  b: any,
  c: any,
  fid: string,
  hash?: string,
) {
  const old = (
    await db.query("select * from public.drive_resources where file_id=$1", [
      fid,
    ])
  ).rows[0];
  if (
    old &&
    (old.book_id !== b.id ||
      old.chapter_id !== c.id ||
      old.owner_subject !== o.owner)
  )
    throw new AppError(
      "OWNERSHIP_CONFLICT",
      409,
      "File thuộc truyện hoặc chủ khác",
    );
  await db.query(
    "delete from public.drive_resources where chapter_id=$1 and file_id<>$2",
    [c.id, fid],
  );
  await db.query(
    "insert into public.drive_resources(file_id,book_id,chapter_id,owner_subject,kind,metadata_version,sync_status,content_hash) values($1,$2,$3,$4,'CHAPTER',$5,'synced',$6) on conflict(file_id) do update set metadata_version=excluded.metadata_version,content_hash=excluded.content_hash,sync_status='synced'",
    [fid, b.id, c.id, o.owner, Number(c.content_version), hash || null],
  );
}
async function syncInfo(db: PoolClient, o: WorkflowOptions, j: any) {
  const b = await guard(db, j),
    genres = (
      await db.query(
        "select g.name from public.book_genres bg join public.genres g on g.id=bg.genre_id where book_id=$1 order by bg.position",
        [b.id],
      )
    ).rows.map((r) => r.name);
  const meta = BookMetadata.parse({
    id: b.id,
    name: b.name,
    author: b.author,
    genres,
    sourceType: b.source_type,
    sourceUrl: b.source_url,
    visibility: b.visibility,
    version: Number(b.version),
  });
  const fid = await o.drive.putText(
    b.folder_id,
    "info.txt",
    formatBookInfo(meta),
    meta.version,
  );
  await tx(db, async () => {
    await db.query("select id from public.books where id=$1 for update", [
      b.id,
    ]);
    await guard(db, j, Number(b.control_epoch));
    const old = (
      await db.query("select * from public.drive_resources where file_id=$1", [
        fid,
      ])
    ).rows[0];
    if (
      old &&
      (old.book_id !== b.id ||
        old.kind !== "INFO" ||
        old.owner_subject !== o.owner)
    )
      throw new AppError("OWNERSHIP_CONFLICT", 409, "info thuộc sách khác");
    await db.query(
      "insert into public.drive_resources(file_id,book_id,owner_subject,kind,metadata_version,sync_status) values($1,$2,$3,'INFO',$4,'synced') on conflict(file_id) do update set metadata_version=excluded.metadata_version,sync_status='synced'",
      [fid, b.id, o.owner, b.version],
    );
  });
}
async function verify(db: PoolClient, o: WorkflowOptions, j: any) {
  const b = await guard(db, j);
  const after = Number(j.checkpoint.verifyAfter ?? -Infinity);
  const list = (await chapters(db, b.id))
    .filter(
      (c) =>
        c.status === "DONE" && !c.is_skipped && Number(c.order_key) > after,
    )
    .slice(0, 100);
  for (const c of list) {
    await touch(db, j);
    let missing = false;
    try {
      const f = await o.drive.assertUnderRoot(c.file_id);
      if (f.mimeType === "application/vnd.google-apps.folder")
        throw new AppError("DRIVE_INVALID", 503, "File chương không hợp lệ");
    } catch (e) {
      if (e instanceof AppError && e.code === "DRIVE_NOT_FOUND") missing = true;
      else throw e;
    }
    if (missing)
      await tx(db, async () => {
        await db.query("select id from public.books where id=$1 for update", [
          b.id,
        ]);
        await guard(db, j);
        await db.query(
          "update public.chapters set status='PENDING',file_id=null,error_code=null,content_version=content_version+1 where id=$1 and file_id=$2",
          [c.id, c.file_id],
        );
        await db.query(
          "delete from public.drive_resources where chapter_id=$1",
          [c.id],
        );
      });
  }
  // A stable order-key cursor does not skip rows when DONE rows become PENDING.
  const last = list.at(-1);
  if (last)
    await db.query(
      "update public.jobs set checkpoint=checkpoint||jsonb_build_object('verifyAfter',$2::text) where id=$1 and lease_owner=$3",
      [j.id, last.order_key, j.lease_owner],
    );
  if (list.length === 100) return false;
  await tx(db, async () => {
    await db.query("select id from public.books where id=$1 for update", [
      b.id,
    ]);
    await guard(db, j);
    const pending = Number(
      (
        await db.query(
          "select count(*) from public.chapters where book_id=$1 and status='PENDING' and not is_skipped",
          [b.id],
        )
      ).rows[0].count,
    );
    await db.query(
      "update public.books set download_status=case when source_type in ('FOLDER','FILE') and $2>0 then 'ERROR' when $2>0 then 'READY' else download_status end where id=$1",
      [b.id, pending],
    );
    if (pending && b.source_type === "WEB") {
      await db.query(
        "update public.jobs set checkpoint=checkpoint-'verifyAfter'||jsonb_build_object('mode','download'),next_run_at=now() where id=$1",
        [j.id],
      );
    } else
      await db.query(
        "update public.jobs set checkpoint=checkpoint-'verifyAfter' where id=$1",
        [j.id],
      );
  });
  return (
    b.source_type !== "WEB" ||
    !Number(
      (
        await db.query(
          "select count(*) from public.chapters where book_id=$1 and status='PENDING' and not is_skipped",
          [b.id],
        )
      ).rows[0].count,
    )
  );
}
export async function downloadBatch(
  db: PoolClient,
  o: WorkflowOptions,
  j: any,
  deadline: number,
) {
  const cfg = await runtimeConfig(db);
  let b = await guard(db, j);
  if (j.checkpoint.mode === "verify") return verify(db, o, j);
  if (b.source_type === "FOLDER" && !j.checkpoint.manualLinks)
    throw new AppError("NO_SOURCE", 422, "FOLDER không có nguồn tải");
  await db.query(
    "update public.books set download_status='DOWNLOADING' where id=$1 and download_status in ('READY','QUEUED','IDLE')",
    [b.id],
  );
  await syncInfo(db, o, j);
  let data: any[] | undefined;
  const pending = (await chapters(db, b.id)).some(
    (c) =>
      c.status === "PENDING" &&
      !c.is_skipped &&
      (b.source_type !== "FOLDER" || c.source_url),
  );
  if (b.source_type === "FILE" && pending) {
    const id = j.checkpoint.importId;
    if (!id)
      throw new AppError(
        "IMPORT_INVALID",
        422,
        "Không còn _import.json; nhập lại file",
      );
    data = JSON.parse(await o.drive.readText(id));
  }
  let remaining = Number(j.checkpoint.batchRemaining ?? cfg.BATCH_SIZE);
  if (!cfg.AUTO_RESUME) {
    if (j.checkpoint.manualBatch !== false) remaining = cfg.BATCH_SIZE;
    await db.query(
      "update public.jobs set checkpoint=checkpoint||jsonb_build_object('batchRemaining',$2::int,'manualBatch',false) where id=$1 and lease_owner=$3",
      [j.id, remaining, j.lease_owner],
    );
  }
  const consume = async () => {
    if (!cfg.AUTO_RESUME) {
      remaining--;
      j.checkpoint.batchRemaining = remaining;
      await db.query(
        "update public.jobs set checkpoint=checkpoint||jsonb_build_object('batchRemaining',$2::int) where id=$1 and lease_owner=$3",
        [j.id, remaining, j.lease_owner],
      );
    }
  };
  const limit = Math.min(
    o.maxItems ?? cfg.BATCH_SIZE,
    cfg.BATCH_SIZE,
    cfg.AUTO_RESUME ? cfg.BATCH_SIZE : remaining,
  );
  for (let n = 0; n < limit && Date.now() < deadline - 1000; n++) {
    await touch(db, j);
    b = await guard(db, j);
    const c = (await chapters(db, b.id)).find(
      (c) =>
        c.status === "PENDING" &&
        !c.is_skipped &&
        (b.source_type !== "FOLDER" || c.source_url),
    );
    if (!c) break;
    const epoch = Number(b.control_epoch);
    let work =
      j.checkpoint.work?.chapter === c.id && j.checkpoint.work?.epoch === epoch
        ? j.checkpoint.work
        : null;
    try {
      if (c.file_id) {
        await o.drive.assertUnderRoot(c.file_id);
        await tx(db, async () => {
          await db.query("select id from public.books where id=$1 for update", [
            b.id,
          ]);
          await guard(db, j, epoch);
          await register(db, o, b, c, c.file_id);
          await db.query(
            "update public.chapters set status='DONE',error_code=null where id=$1 and content_version=$2",
            [c.id, c.content_version],
          );
          await consume();
        });
        continue;
      }
      let text: string | undefined;
      if (!work) {
        let title: string,
          name: string,
          auto = false;
        let target = b.folder_id;
        for (const group of [c.part, c.vol])
          if (cleanName_(group))
            target = await o.drive.folder(target, cleanName_(group));
        if (b.source_type === "FILE") {
          const ch = data!.find((ch) => Number(ch.num) === Number(c.order_key));
          if (!ch)
            throw new AppError(
              "IMPORT_INVALID",
              422,
              "Không tìm thấy nội dung chương tạm",
            );
          const current = { ...ch, title: c.title, part: c.part, vol: c.vol };
          title = c.title;
          name = importFileName_(b.label, current);
          text = docChapterFile_(b.name, b.label, current);
        } else {
          await o.validateUrl(c.source_url);
          const result = await o.http.get(
            c.source_url,
            AbortSignal.timeout(
              Math.max(1, Math.min(20000, deadline - Date.now())),
            ),
          );
          const parsed = parsedDownload(
            result.body,
            result.finalUrl,
            cfg,
            c,
            b,
          );
          ({ text, title, name, auto } = parsed);
        }
        work = {
          chapter: c.id,
          epoch,
          target,
          name,
          title,
          hash: contentHash(text!),
          version: Number(b.version),
          contentVersion: Number(c.content_version),
          auto,
        };
        await tx(db, async () => {
          await db.query("select id from public.books where id=$1 for update", [
            b.id,
          ]);
          await guard(db, j, epoch);
          await db.query(
            "update public.jobs set checkpoint=checkpoint||jsonb_build_object('work',$2::jsonb,'phase','Ghi TXT') where id=$1",
            [j.id, JSON.stringify(work)],
          );
        });
        j.checkpoint.work = work;
      }
      let fid: string | undefined;
      const existing = (await o.drive.list(work.target, work.name)).filter(
        (f) => f.mimeType === "text/plain",
      );
      if (existing.length > 1)
        throw new AppError(
          "DRIVE_CONFLICT",
          409,
          "Nhiều file chương trùng tên",
        );
      if (existing[0]) {
        const mapped = (
          await db.query(
            "select * from public.drive_resources where file_id=$1",
            [existing[0].id],
          )
        ).rows[0];
        if (
          mapped &&
          (mapped.chapter_id !== c.id || mapped.owner_subject !== o.owner)
        )
          throw new AppError(
            "OWNERSHIP_CONFLICT",
            409,
            "File chương thuộc tài nguyên khác",
          );
        if (contentHash(await o.drive.readText(existing[0].id)) === work.hash)
          fid = existing[0].id;
      }
      if (!fid) {
        if (text === undefined) {
          // No file was created before the crash: clear checkpoint and safely fetch again.
          await db.query(
            "update public.jobs set checkpoint=checkpoint-'work' where id=$1 and lease_owner=$2",
            [j.id, j.lease_owner],
          );
          delete j.checkpoint.work;
          n--;
          continue;
        }
        await guard(db, j, epoch);
        fid = await o.drive.putText(work.target, work.name, text, work.version);
      }
      await o.drive.assertUnderRoot(fid);
      await tx(db, async () => {
        await db.query("select id from public.books where id=$1 for update", [
          b.id,
        ]);
        await guard(db, j, epoch);
        const current = (
          await db.query(
            "select * from public.chapters where id=$1 for update",
            [c.id],
          )
        ).rows[0];
        if (
          !current ||
          current.status !== "PENDING" ||
          current.is_skipped ||
          Number(current.content_version) !== work.contentVersion
        )
          throw new AppError("FENCED", 409, "Chương đã thay đổi");
        await register(db, o, b, c, fid!, work.hash);
        await db.query(
          "update public.chapters set status='DONE',file_id=$2,title=$3,error_code=null where id=$1",
          [c.id, fid, work.title],
        );
        await db.query(
          "insert into public.audit_logs(actor_id,action,entity_id,details) values($1,$2,$3,$4)",
          [
            j.actor_id,
            b.source_type === "FILE" ? "IMPORT" : "DOWNLOAD",
            b.id,
            JSON.stringify({
              chapter: c.id,
              result: existing.length ? "RECOVER" : "SUCCESS",
              auto: work.auto,
            }),
          ],
        );
        await db.query(
          "update public.jobs set checkpoint=checkpoint-'work'-'error'||jsonb_build_object('phase','Đã lưu chương','lastChapter',$2::text),next_run_at=now()+$3*interval '1 millisecond' where id=$1",
          [j.id, c.id, b.source_type !== "FILE" ? cfg.DELAY_MS : 0],
        );
        await consume();
      });
      delete j.checkpoint.work;
    } catch (e) {
      if (e instanceof AppError && e.code === "FENCED") throw e;
      if (
        (e as any)?.code?.startsWith("DRIVE_") ||
        (e as any)?.code === "OWNERSHIP_CONFLICT" ||
        (e as any)?.code === "CRASH"
      )
        throw e;
      const decision = retryDecision(
        e,
        Number(c.retry_count) + 1,
        cfg.MAX_RETRY,
        cfg.DELAY_MS,
      );
      await tx(db, async () => {
        await db.query("select id from public.books where id=$1 for update", [
          b.id,
        ]);
        await guard(db, j, epoch);
        await db.query(
          "update public.chapters set retry_count=retry_count+1,status=$2,error_code=$3 where id=$1",
          [
            c.id,
            decision.retry ? "PENDING" : "ERROR",
            decision.code + ": " + decision.message,
          ],
        );
        await db.query(
          "update public.jobs set checkpoint=checkpoint-'work'||jsonb_build_object('error',$2::text),next_run_at=now()+$3*interval '1 millisecond' where id=$1",
          [
            j.id,
            decision.message,
            decision.retry ? Math.ceil(decision.waitMs) : cfg.DELAY_MS,
          ],
        );
        await db.query(
          "insert into public.audit_logs(actor_id,action,entity_id,details) values($1,'DOWNLOAD_ERROR',$2,$3)",
          [
            j.actor_id,
            b.id,
            JSON.stringify({
              chapter: c.id,
              code: decision.code,
              attempt: Number(c.retry_count) + 1,
              retry: decision.retry,
            }),
          ],
        );
        if (!decision.retry) await consume();
      });
      delete j.checkpoint.work;
      if (decision.retry) return false;
    }
    if (b.source_type !== "FILE" && cfg.DELAY_MS) {
      if (Date.now() + cfg.DELAY_MS >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, cfg.DELAY_MS));
    }
  }
  b = await guard(db, j);
  if (b.source_type !== "FILE")
    await tx(db, async () => {
      await db.query("select id from public.books where id=$1 for update", [
        b.id,
      ]);
      await guard(db, j);
      const all = await chapters(db, b.id),
        removed = emptyChapterIds(all);
      for (const id of removed) {
        const c = all.find((c) => c.id === id)!;
        await db.query(
          "insert into public.removed_chapters(book_id,legacy_order,display_number,title,reason,details) values($1,$2,$3,$4,$5,$6)",
          [
            b.id,
            c.legacy_order,
            c.display_number,
            c.title,
            c.error_code.startsWith("NO_CONTENT")
              ? "Không có nội dung"
              : "Nội dung quá ngắn",
            JSON.stringify(c),
          ],
        );
        await db.query(
          "delete from public.reading_progress where chapter_id=$1",
          [id],
        );
        await db.query("delete from public.chapters where id=$1", [id]);
      }
      if (removed.length) {
        const current = (
          await db.query(
            "update public.books set version=version+1 where id=$1 returning version",
            [b.id],
          )
        ).rows[0];
        await db.query("select private.enqueue_sync($1,$2)", [
          b.id,
          current.version,
        ]);
      }
    });
  const all = await chapters(db, b.id),
    left = all.some(
      (c) =>
        c.status === "PENDING" &&
        !c.is_skipped &&
        (b.source_type !== "FOLDER" || c.source_url),
    ),
    paused = all.some((c) => c.is_skipped && c.status !== "DONE"),
    errors = all.some(
      (c) =>
        c.status === "ERROR" ||
        (b.source_type === "FOLDER" && c.status === "PENDING" && !c.source_url),
    );
  if (
    !left &&
    !paused &&
    !errors &&
    b.source_type === "FILE" &&
    j.checkpoint.importId
  ) {
    await guard(db, j);
    try {
      await o.drive.trashOwned(j.checkpoint.importId);
    } catch (e) {
      if (!(e instanceof AppError) || e.code !== "DRIVE_NOT_FOUND") throw e;
    }
    await tx(db, async () => {
      await db.query("select id from public.books where id=$1 for update", [
        b.id,
      ]);
      await guard(db, j);
      await db.query(
        "delete from public.drive_resources where book_id=$1 and kind='IMPORT'",
        [b.id],
      );
      for (const id of [
        j.checkpoint.request?.upload,
        j.checkpoint.request?.toc,
      ].filter(Boolean))
        await db.query(
          "delete from private.uploads where id=$1 and actor_id=$2",
          [id, j.actor_id],
        );
    });
  }
  await tx(db, async () => {
    await db.query("select id from public.books where id=$1 for update", [
      b.id,
    ]);
    await guard(db, j);
    const pause =
      (left && !cfg.AUTO_RESUME && remaining <= 0) || (!left && paused);
    await db.query("update public.books set download_status=$2 where id=$1", [
      b.id,
      pause ? "PAUSED" : left ? "DOWNLOADING" : errors ? "ERROR" : "DONE",
    ]);
    if (pause)
      await db.query(
        "update public.jobs set status='paused',lease_owner=null,lease_until=null,checkpoint=checkpoint-'batchRemaining'||jsonb_build_object('phase','Dừng tại ranh giới đợt') where id=$1",
        [j.id],
      );
  });
  return !left;
}

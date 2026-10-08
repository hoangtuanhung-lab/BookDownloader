import { readFile, writeFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import type { PoolClient } from "pg";
import { prepareImport, legacyTimestamp, sha256 } from "./import-local";
import { withOperation, localCommand } from "../operations/local";
import { databaseDigest, fileHash } from "../operations/backup";
const stable = (value: unknown) => JSON.stringify(value);
function pair(base: unknown, target: unknown, options: unknown) {
  const value = options as { before?: unknown; after?: unknown };
  const before = prepareImport(base, value?.before || options),
    after = prepareImport(target, value?.after || options);
  if (
    before.root !== after.root ||
    before.o.sourceKey !== after.o.sourceKey ||
    before.o.ownerId !== after.o.ownerId ||
    before.o.ownerEmail !== after.o.ownerEmail ||
    before.o.driveSubject !== after.o.driveSubject
  )
    throw Error("Delta owner/root/source binding cannot change");
  for (const b of before.report.books) {
    const n = after.report.books.find((v) => v.id === b.id);
    if (n && (n.folderId !== b.folderId || n.sourceType !== b.sourceType))
      throw Error("Source/folder changes need storage reconciliation");
  }
  return { before, after };
}
export function planLegacyDelta(
  base: unknown,
  target: unknown,
  options: unknown,
) {
  const { before, after } = pair(base, target, options);
  if (before.root !== after.root)
    throw Error("Root change requires a separate storage migration");
  const changes = (a: { id: string }[], b: { id: string }[]) => {
    const am = new Map(a.map((v) => [v.id, v])),
      bm = new Map(b.map((v) => [v.id, v]));
    return {
      added: b.filter((v) => !am.has(v.id)).map((v) => v.id),
      removed: a.filter((v) => !bm.has(v.id)).map((v) => v.id),
      changed: b
        .filter((v) => am.has(v.id) && stable(am.get(v.id)) !== stable(v))
        .map((v) => v.id),
    };
  };
  const plan = {
    sourceKey: before.o.sourceKey,
    baseChecksum: before.checksum,
    targetChecksum: after.checksum,
    books: changes(before.report.books, after.report.books),
    chapters: changes(before.report.chapters, after.report.chapters),
    remoteWrites: 0,
  };
  return { ...plan, planHash: sha256(stable(plan)) };
}
export async function applyLegacyDeltaLocal(
  db: PoolClient,
  base: unknown,
  target: unknown,
  options: unknown,
  approvedPlanHash: string,
  backupDirectory: string,
) {
  const { before: old, after: next } = pair(base, target, options),
    plan = planLegacyDelta(base, target, options);
  if (plan.planHash !== approvedPlanHash) throw Error("Delta plan changed");
  const root = await realpath(backupDirectory),
    manifest = JSON.parse(
      await readFile(resolve(root, "manifest.json"), "utf8"),
    );
  if (
    manifest.schemaVersion !== 1 ||
    !manifest.maintenance ||
    manifest.databaseDump?.path !== "database.dump" ||
    (await fileHash(resolve(root, "database.dump"))) !==
      manifest.databaseDump.sha256
  )
    throw Error("Verified backup required");
  const dumpRelative = relative(
    root,
    await realpath(resolve(root, "database.dump")),
  );
  if (
    dumpRelative === ".." ||
    dumpRelative.startsWith("../") ||
    isAbsolute(dumpRelative)
  )
    throw Error("Backup dump outside root");
  for (const file of Object.values(manifest.files) as {
    path: string;
    sha256: string;
  }[]) {
    const p = await realpath(resolve(root, file.path)),
      r = relative(root, p);
    if (
      r === ".." ||
      r.startsWith("../") ||
      isAbsolute(r) ||
      (await fileHash(p)) !== file.sha256
    )
      throw Error("Backup content invalid");
  }
  return withOperation(db, old.o.ownerId, "legacy_delta", async () => {
    const ledger = (
      await db.query(
        "select * from private.legacy_imports where source_key=$1 and owner_id=$2 for update",
        [old.o.sourceKey, old.o.ownerId],
      )
    ).rows[0];
    if (!ledger) throw Error("Source owner mismatch");
    if (ledger.checksum === next.checksum) {
      const missing = await db.query(
        "select 1 from public.migration_items m where m.run_id=$1 and ((m.entity_kind='book' and not exists(select 1 from public.books b where b.id=m.new_id and b.deleted_at is null)) or (m.entity_kind='chapter' and not exists(select 1 from public.chapters c where c.id=m.new_id))) limit 1",
        [ledger.run_id],
      );
      if (missing.rowCount)
        throw Error("Mapped resource missing; restore or reconcile explicitly");
      return { ...plan, repeated: true };
    }
    if (ledger.checksum !== old.checksum)
      throw Error("Source checksum conflict");
    if (stable(await databaseDigest(db)) !== stable(manifest.tables))
      throw Error("Database changed since backup");
    if (old.checksum === next.checksum) return { ...plan, repeated: true };
    const expected = new Map(old.report.chapters.map((c) => [c.id, c]));
    for (const g of old.report.groups) {
      const live = (
        await db.query("select * from public.chapter_groups where id=$1", [
          g.id,
        ])
      ).rows[0];
      if (
        !live ||
        live.name !== g.name ||
        live.kind !== g.kind ||
        live.parent_id !== g.parentId ||
        Number(live.order_key) !== g.orderKey
      )
        throw Error("Group changed locally; reconcile manually");
    }
    for (const b of old.report.books) {
      const live = (
        await db.query("select * from public.books where id=$1", [b.id])
      ).rows[0];
      if (
        !live ||
        live.deleted_at ||
        [
          live.name,
          live.author,
          live.source_url,
          live.source_type,
          live.label,
          live.folder_id,
        ].join("\u0001") !==
          [
            b.name,
            b.author,
            b.sourceUrl,
            b.sourceType,
            b.label,
            b.folderId,
          ].join("\u0001")
      )
        throw Error("Book changed locally; reconcile manually");
      const genres = (
        await db.query(
          "select g.name from public.book_genres bg join public.genres g on g.id=bg.genre_id where bg.book_id=$1 order by bg.position",
          [b.id],
        )
      ).rows.map((r) => r.name);
      if (stable(genres) !== stable(b.genres))
        throw Error("Genres changed locally");
      const chapters = (
        await db.query("select * from public.chapters where book_id=$1", [b.id])
      ).rows;
      if (
        chapters.length !==
        old.report.chapters.filter((c) => c.bookId === b.id).length
      )
        throw Error("Chapters changed locally");
      for (const c of chapters) {
        const before = expected.get(c.id);
        if (
          !before ||
          c.status !== before.status ||
          c.retry_count !== before.retryCount ||
          (c.error_code || "") !== (before.error || "") ||
          c.title !== before.title ||
          c.source_url !== before.sourceUrl ||
          c.file_id !== before.fileId ||
          c.group_id !== before.groupId ||
          c.display_number !== before.displayNumber ||
          Number(c.order_key) !== before.orderKey ||
          c.is_skipped !== old.skipped.has(before.legacyId)
        )
          throw Error("Chapter changed locally");
      }
    }
    // Archive removed metadata; no Drive deletion or overwrite is performed.
    for (const id of plan.chapters.removed) {
      const c = expected.get(id)!;
      await db.query(
        "insert into public.removed_chapters(book_id,legacy_order,display_number,title,reason,details) values($1,$2,$3,$4,'LEGACY_DELTA',$5)",
        [
          c.bookId,
          c.legacyOrder,
          c.displayNumber,
          c.title,
          JSON.stringify({
            fileId: c.fileId,
            groupId: c.groupId,
            planHash: plan.planHash,
          }),
        ],
      );
      await db.query(
        "update public.reading_progress set chapter_id=null,ratio=0,scroll_position=0,revision=revision+1 where chapter_id=$1",
        [id],
      );
      await db.query("delete from public.job_items where chapter_id=$1", [id]);
      await db.query("delete from public.drive_resources where chapter_id=$1", [
        id,
      ]);
      await db.query("delete from public.chapters where id=$1", [id]);
      await db.query(
        "delete from public.migration_items where run_id=$1 and entity_kind='chapter' and new_id=$2",
        [ledger.run_id, id],
      );
    }
    for (const id of plan.books.removed) {
      await db.query(
        "update public.books set deleted_at=now(),visibility='hidden',version=version+1 where id=$1",
        [id],
      );
      await db.query(
        "update public.jobs set status='cancelled',cancel_requested=true,lease_owner=null,lease_until=null where book_id=$1",
        [id],
      );
      await db.query(
        "delete from public.migration_items where run_id=$1 and entity_kind='book' and new_id=$2",
        [ledger.run_id, id],
      );
    }
    // Stage unique fields inside this transaction so swaps do not fail halfway through.
    for (const id of plan.books.changed)
      await db.query(
        "update public.books set normalized_name=$2,source_url=case when source_type='WEB' then $3 else '' end where id=$1",
        [id, "delta:" + id, "https://migration.invalid/" + id],
      );
    for (const id of plan.chapters.changed) {
      await db.query(
        "update public.chapters set source_url='',file_id=null where id=$1",
        [id],
      );
      await db.query("delete from public.drive_resources where chapter_id=$1", [
        id,
      ]);
    }
    for (const b of next.report.books) {
      if (plan.books.added.includes(b.id)) {
        await db.query(
          "insert into public.books(id,legacy_id,name,normalized_name,author,source_url,source_type,label,folder_id,download_status,created_at) values($1,$2,$3,private.reader_normalize($3),$4,$5,$6,$7,$8,$9,coalesce($10::timestamptz,now()))",
          [
            b.id,
            b.legacyId,
            b.name,
            b.author,
            b.sourceUrl,
            b.sourceType,
            b.label,
            b.folderId,
            ["QUEUED", "DOWNLOADING"].includes(b.status!) ? "PAUSED" : b.status,
            legacyTimestamp(b.created),
          ],
        );
        await db.query(
          "insert into public.migration_items values($1,$2,'book',$3,'mapped')",
          [ledger.run_id, b.legacyId, b.id],
        );
      } else
        await db.query(
          "update public.books set name=$2,normalized_name=private.reader_normalize($2),author=$3,source_url=$4,label=$5,download_status=$6,visibility='hidden',version=version+1,created_at=coalesce($7::timestamptz,created_at) where id=$1",
          [
            b.id,
            b.name,
            b.author,
            b.sourceUrl,
            b.label,
            ["QUEUED", "DOWNLOADING"].includes(b.status!) ? "PAUSED" : b.status,
            legacyTimestamp(b.created),
          ],
        );
      if (
        old.report.books.some(
          (o) =>
            o.id === b.id &&
            (o.folderId !== b.folderId || o.sourceType !== b.sourceType),
        )
      )
        throw Error("Source/folder changes require storage reconciliation");
      await db.query("select private.set_genres($1,$2)", [
        b.id,
        JSON.stringify(b.genres),
      ]);
      await db.query(
        "insert into private.legacy_book_review(book_id) values($1) on conflict(book_id) do update set reviewed_at=null,actor_id=null",
        [b.id],
      );
      await db.query(
        "update public.jobs set status='paused',lease_owner=null,lease_until=null,cancel_requested=false,checkpoint=checkpoint-'work'||'{\"migrationReviewRequired\":true}'::jsonb where book_id=$1 and kind in ('WEB_DOWNLOAD','FILE_IMPORT')",
        [b.id],
      );
      if (
        ["READY", "IDLE", "DOWNLOADING", "PAUSED"].includes(b.legacyStatus) &&
        b.sourceType !== "FOLDER"
      )
        await db.query(
          "insert into public.jobs(kind,book_id,actor_id,status,dedupe_key,checkpoint) values($1,$2,$3,'paused',$4,$5) on conflict(dedupe_key) do nothing",
          [
            b.sourceType === "FILE" ? "FILE_IMPORT" : "WEB_DOWNLOAD",
            b.id,
            next.o.ownerId,
            "download:" + b.id,
            JSON.stringify({
              mode: b.sourceType === "FILE" ? "verify" : "download",
              migrationReviewRequired: true,
            }),
          ],
        );
    }
    for (const g of next.report.groups)
      await db.query(
        "insert into public.chapter_groups(id,book_id,parent_id,kind,name,order_key) values($1,$2,$3,$4,$5,$6) on conflict(id) do nothing",
        [g.id, g.bookId, g.parentId, g.kind, g.name, g.orderKey],
      );
    for (const c of next.report.chapters) {
      const raw = next.rawChapters.get(c.legacyId)!;
      await db.query(
        "insert into public.chapters(id,book_id,group_id,legacy_order,order_key,display_number,title,source_url,status,file_id,retry_count,error_code,is_skipped,legacy_updated_at) values($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict(id) do update set group_id=excluded.group_id,display_number=excluded.display_number,title=excluded.title,source_url=excluded.source_url,status=excluded.status,file_id=excluded.file_id,retry_count=excluded.retry_count,error_code=excluded.error_code,is_skipped=excluded.is_skipped,legacy_updated_at=excluded.legacy_updated_at",
        [
          c.id,
          c.bookId,
          c.groupId,
          String(raw[1]),
          c.displayNumber,
          c.title,
          c.sourceUrl,
          c.status,
          c.fileId,
          c.retryCount,
          c.error || null,
          next.skipped.has(c.legacyId),
          legacyTimestamp(c.updated),
        ],
      );
      if (c.fileId) {
        const mapped = (
          await db.query(
            "select book_id,chapter_id from public.drive_resources where file_id=$1",
            [c.fileId],
          )
        ).rows[0];
        if (
          mapped &&
          (mapped.book_id !== c.bookId || mapped.chapter_id !== c.id)
        )
          throw Error("File ownership conflict");
        await db.query(
          "insert into public.drive_resources(file_id,book_id,chapter_id,owner_subject,kind,metadata_version,sync_status) values($1,$2,$3,$4,'CHAPTER',1,'pending') on conflict(file_id) do update set sync_status='pending',content_hash=null",
          [c.fileId, c.bookId, c.id, next.o.driveSubject],
        );
      }
      await db.query(
        "insert into public.migration_items values($1,$2,'chapter',$3,'mapped') on conflict(run_id,entity_kind,legacy_id) do nothing",
        [ledger.run_id, c.legacyId, c.id],
      );
    }
    for (const g of old.report.groups
      .filter((g) => !next.report.groups.some((n) => n.id === g.id))
      .reverse())
      if (
        !(
          await db.query("select 1 from public.chapters where group_id=$1", [
            g.id,
          ])
        ).rowCount
      )
        await db.query("delete from public.chapter_groups where id=$1", [g.id]);
    await db.query(
      "insert into private.legacy_archives(source_key,kind,content) values($1,$2,$3)",
      [
        old.o.sourceKey,
        "delta:" + old.checksum,
        JSON.stringify({ base: old.data, target: next.data, plan }),
      ],
    );
    await db.query(
      "insert into private.legacy_archives(source_key,kind,content) select source_key,'prior:'||$2||':'||kind,content from private.legacy_archives where source_key=$1 and kind in ('LOG','scriptState','imports','removedLogs','CONFIG')",
      [old.o.sourceKey, old.checksum],
    );
    await db.query(
      "delete from private.legacy_archives where source_key=$1 and kind in ('LOG','scriptState','imports','removedLogs','CONFIG')",
      [old.o.sourceKey],
    );
    await db.query("delete from private.legacy_transfers where source_key=$1", [
      old.o.sourceKey,
    ]);
    const report = {
      ...ledger.report,
      checksum: next.checksum,
      delta: plan,
      totals: next.report.totals,
      review: {
        ...ledger.report.review,
        books: next.report.books,
        chapterDates: next.report.chapters.map((c) => ({
          id: c.id,
          updated: c.updated,
        })),
        config: next.report.config,
        properties: next.report.properties,
      },
    };
    await db.query(
      "update private.legacy_imports set checksum=$2,report=$3 where source_key=$1",
      [old.o.sourceKey, next.checksum, JSON.stringify(report)],
    );
    await db.query("update public.migration_runs set report=$2 where id=$1", [
      ledger.run_id,
      JSON.stringify(report),
    ]);
    return { ...plan, repeated: false, requiresReview: true };
  });
}
async function main() {
  const [action, base, target, options, output, planHash, backup] =
    process.argv.slice(2);
  if (!base || !target || !options || !output)
    throw Error(
      "Usage: migration:delta -- plan|apply BASE TARGET OPTIONS REPORT [PLAN_HASH BACKUP_DIR]",
    );
  const a = JSON.parse(await readFile(base, "utf8")),
    b = JSON.parse(await readFile(target, "utf8")),
    o = JSON.parse(await readFile(options, "utf8"));
  await writeFile(output, "{}\n", { flag: "wx", mode: 0o600 });
  if (action === "plan")
    await writeFile(
      output,
      JSON.stringify(planLegacyDelta(a, b, o), null, 2) + "\n",
    );
  else if (action === "apply" && planHash && backup)
    await localCommand(async (db) => {
      await writeFile(
        output,
        JSON.stringify(
          await applyLegacyDeltaLocal(db, a, b, o, planHash, backup),
          null,
          2,
        ) + "\n",
      );
    });
  else throw Error("Invalid delta command");
  console.log(JSON.stringify({ remoteWrites: 0, reportWritten: true }));
}
if (process.argv[1]?.endsWith("delta-local.ts"))
  main().catch(() => {
    console.error(
      "Local delta failed; inspect source, backup and review plan. No Drive writes.",
    );
    process.exitCode = 1;
  });

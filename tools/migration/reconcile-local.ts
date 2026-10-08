import { readFile, writeFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { z } from "zod";
import { prepareImport, sha256, legacyTimestamp } from "./import-local";
import { migrationId } from "../../packages/domain/src/migration";
import { DownloadSettings } from "../../packages/contracts/src/download";
import { SettingsEdit } from "../../packages/contracts/src/management";
import {
  normUrl_,
  cleanGenreList_,
} from "../../packages/domain/src/legacy.mjs";
import { localCommand, withOperation } from "../operations/local";
const File = z.object({
  book: z.string(),
  fileId: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.string(),
});
export const LegacyPrivate = z
  .object({
    scriptState: z.record(z.string(), z.string()).default({}),
    LOG: z.array(z.array(z.unknown())).default([]),
    imports: z.array(File).default([]),
    removedLogs: z.array(File).default([]),
  })
  .strict();
const Chapter = z.object({
  num: z.number().finite(),
  title: z.string().default(""),
  body: z.string(),
  part: z.string().default(""),
  vol: z.string().default(""),
  dnum: z.union([z.string(), z.number()]).optional(),
  marked: z.boolean().optional(),
  preamble: z.boolean().optional(),
  ordinal: z.string().optional(),
});
export function validatedLegacyManifest(content: string, pending: number[]) {
  if (Buffer.byteLength(content) > 64 * 1024 * 1024)
    throw Error("Manifest too large");
  const chapters = z.array(Chapter).parse(JSON.parse(content));
  const seen = new Set<number>();
  for (const c of chapters) {
    if (seen.has(c.num)) throw Error("Duplicate manifest order");
    seen.add(c.num);
  }
  if (pending.some((n) => !seen.has(n)))
    throw Error("Manifest missing pending chapters");
  return chapters;
}
function assertFileAncestry(
  data: ReturnType<typeof prepareImport>,
  fileId: string,
  folder: string,
) {
  const files = new Map(data.data.files.map((f) => [f.id, f]));
  let current = fileId;
  const seen = new Set<string>();
  while (current !== folder) {
    if (seen.has(current) || seen.size >= 32)
      throw Error("Invalid file ancestry");
    seen.add(current);
    const f = files.get(current);
    if (!f || f.trashed || f.parents.length !== 1)
      throw Error("File outside book");
    current = f.parents[0];
  }
}
export async function reconcileLegacyLocal(
  db: PoolClient,
  input: unknown,
  options: unknown,
  privateInput: unknown,
) {
  const p = prepareImport(input, options),
    state = LegacyPrivate.parse(privateInput),
    checksum = sha256(JSON.stringify({ source: p.checksum, state }));
  for (const key of Object.keys(state.scriptState))
    if (
      !["DB_ID", "ANA_QUEUE", "ROOT_FOLDER", "ROOT_FOLDER_ID"].includes(key) &&
      !/^(FLD_|IMP_|DEL_)/.test(key)
    )
      throw Error(
        "Credentials/unknown Script Properties must stay outside migration",
      );
  return withOperation(db, p.o.ownerId, "legacy_reconcile", async () => {
    const ledger = (
      await db.query(
        "select checksum from private.legacy_imports where source_key=$1 and owner_id=$2",
        [p.o.sourceKey, p.o.ownerId],
      )
    ).rows[0];
    if (!ledger || ledger.checksum !== p.checksum)
      throw Error("Imported source checksum mismatch");
    const old = (
      await db.query(
        "select checksum,report from private.legacy_transfers where source_key=$1",
        [p.o.sourceKey],
      )
    ).rows[0];
    if (old) {
      if (old.checksum !== checksum) throw Error("Private state conflict");
      return { ...old.report, repeated: true };
    }
    const unresolved: string[] = [],
      cfg = p.report.config;
    if (
      cfg.FILE_TYPE !== undefined &&
      String(cfg.FILE_TYPE).toUpperCase() !== "TXT"
    )
      throw Error("Legacy FILE_TYPE requires explicit conversion");
    if (cfg.ENCODING !== undefined && !/^utf-?8$/i.test(String(cfg.ENCODING)))
      throw Error("Legacy encoding requires explicit conversion");
    const download = (
      await db.query(
        "select value from public.app_settings where key='download'",
      )
    ).rows[0].value;
    for (const key of ["BATCH_SIZE", "DELAY_MS", "MAX_RETRY", "MAX_CONCURRENT"])
      if (cfg[key] !== undefined) download[key] = Number(cfg[key]);
    if (cfg.AUTO_RESUME !== undefined) {
      if (!/^(TRUE|FALSE)$/i.test(String(cfg.AUTO_RESUME)))
        throw Error("Invalid AUTO_RESUME");
      download.AUTO_RESUME = String(cfg.AUTO_RESUME).toUpperCase() === "TRUE";
    }
    await db.query("select public.app_download_settings($1,$2)", [
      p.o.ownerId,
      JSON.stringify(DownloadSettings.parse(download)),
    ]);
    const analysis = (
      await db.query(
        "select value from public.app_settings where key='analysis'",
      )
    ).rows[0].value;
    for (const key of ["SITE_RULES", "JUNK_WORDS"])
      if (cfg[key] !== undefined) analysis[key] = String(cfg[key]);
    if (cfg.DELAY_MS !== undefined) analysis.DELAY_MS = Number(cfg.DELAY_MS);
    await db.query("select public.app_settings($1,$2)", [
      p.o.ownerId,
      JSON.stringify(SettingsEdit.parse(analysis)),
    ]);
    if (cfg.GENRES !== undefined) {
      const genres = z
        .array(z.string())
        .max(500)
        .parse(JSON.parse(String(cfg.GENRES)));
      await db.query("update public.genres set listed=false");
      for (const genre of cleanGenreList_(genres))
        await db.query(
          "select public.app_manage($1,'genre-save',jsonb_build_object('name',$2::text))",
          [p.o.ownerId, genre],
        );
    }
    for (const c of p.report.chapters)
      await db.query(
        "update public.chapters set legacy_updated_at=$2 where id=$1",
        [c.id, legacyTimestamp(c.updated)],
      );
    await db.query("insert into private.legacy_archives values($1,$2,$3)", [
      p.o.sourceKey,
      "CONFIG",
      JSON.stringify(cfg),
    ]);
    for (const kind of [
      "LOG",
      "scriptState",
      "imports",
      "removedLogs",
    ] as const)
      await db.query("insert into private.legacy_archives values($1,$2,$3)", [
        p.o.sourceKey,
        kind,
        JSON.stringify(state[kind]),
      ]);
    for (let i = 0; i < state.LOG.length; i++) {
      const inserted = await db.query(
        "insert into private.legacy_log_refs values($1,$2,$3) on conflict do nothing",
        [p.o.sourceKey, i + 2, sha256(JSON.stringify(state.LOG[i]))],
      );
      if (inserted.rowCount)
        await db.query(
          "insert into public.audit_logs(actor_id,action,details,created_at) values($1,'LEGACY_LOG',$2,coalesce($3::timestamptz,now()))",
          [
            p.o.ownerId,
            JSON.stringify({
              source: p.o.sourceKey,
              sourceChecksum: p.checksum,
              row: i + 2,
            }),
            legacyTimestamp(String(state.LOG[i][0] || "")),
          ],
        );
    }
    const imported = new Set<string>();
    for (const f of state.imports) {
      if (imported.has(f.book)) throw Error("Duplicate import manifest");
      imported.add(f.book);
      const b = p.report.books.find((b) => b.legacyId === f.book);
      if (!b || b.sourceType !== "FILE") throw Error("Manifest book invalid");
      assertFileAncestry(p, f.fileId, b.folderId);
      if (sha256(f.content) !== f.sha256) throw Error("Manifest hash conflict");
      const pointer = state.scriptState["IMP_" + b.folderId];
      if (pointer && pointer !== f.fileId)
        throw Error("Legacy manifest pointer conflict");
      validatedLegacyManifest(
        f.content,
        p.report.chapters
          .filter(
            (c) =>
              c.bookId === b.id &&
              c.status !== "DONE" &&
              !p.skipped.has(c.legacyId),
          )
          .map((c) => c.legacyOrder),
      );
      await singleton(db, f.fileId, b.id, p.o.driveSubject, "IMPORT");
      await db.query(
        "insert into public.drive_resources(file_id,book_id,owner_subject,kind,metadata_version,sync_status,content_hash) values($1,$2,$3,'IMPORT',1,'synced',$4) on conflict(file_id) do update set content_hash=excluded.content_hash,sync_status='synced'",
        [f.fileId, b.id, p.o.driveSubject, f.sha256],
      );
      await db.query(
        "insert into public.jobs(kind,book_id,actor_id,status,dedupe_key,checkpoint) values('FILE_IMPORT',$1,$2,'paused',$3,$4) on conflict(dedupe_key) do update set checkpoint=excluded.checkpoint,status='paused',lease_owner=null,lease_until=null,cancel_requested=false",
        [
          b.id,
          p.o.ownerId,
          "download:" + b.id,
          JSON.stringify({
            legacySource: p.o.sourceKey,
            importId: f.fileId,
            mode: "download",
            migrationReviewRequired: true,
            legacyStatus: b.legacyStatus,
          }),
        ],
      );
    }
    for (const b of p.report.books)
      if (
        b.sourceType === "FILE" &&
        p.report.chapters.some(
          (c) =>
            c.bookId === b.id &&
            c.status !== "DONE" &&
            !p.skipped.has(c.legacyId),
        ) &&
        !imported.has(b.legacyId)
      )
        unresolved.push("MISSING_IMPORT:" + b.legacyId);
    let removed = 0;
    for (const f of state.removedLogs) {
      const b = p.report.books.find((b) => b.legacyId === f.book);
      if (!b) throw Error("Removed log book invalid");
      assertFileAncestry(p, f.fileId, b.folderId);
      if (sha256(f.content) !== f.sha256)
        throw Error("Removed log hash conflict");
      for (const [i, line] of f.content.split(/\r?\n/).entries()) {
        if (!line.includes(" | ") || line.startsWith("Mỗi dòng:")) continue;
        const cells = line.split(" | ");
        if (cells.length !== 6 || !/^Chương /.test(cells[1])) {
          unresolved.push("REMOVED_LOG_LINE:" + f.book + ":" + i);
          continue;
        }
        const date = legacyTimestamp(cells[0]);
        await db.query(
          "insert into public.removed_chapters(id,book_id,display_number,title,reason,removed_at,details) values($1,$2,$3,$4,$5,coalesce($6::timestamptz,now()),$7) on conflict(id) do nothing",
          [
            migrationId(
              "removed",
              p.o.sourceKey + ":" + f.book + ":" + i + ":" + sha256(line),
            ),
            b.id,
            cells[1].slice(7),
            cells[3],
            cells[5],
            date,
            JSON.stringify({
              group: cells[2],
              url: cells[4],
              legacyArchiveRow: i,
            }),
          ],
        );
        removed++;
      }
      await singleton(db, f.fileId, b.id, p.o.driveSubject, "REMOVED_LOG");
      await db.query(
        "insert into public.drive_resources(file_id,book_id,owner_subject,kind,metadata_version,sync_status,content_hash) values($1,$2,$3,'REMOVED_LOG',1,'synced',$4) on conflict(file_id) do update set content_hash=excluded.content_hash,sync_status='synced'",
        [f.fileId, b.id, p.o.driveSubject, f.sha256],
      );
    }
    const queue = state.scriptState.ANA_QUEUE
      ? z
          .object({
            w: z.array(z.string()).default([]),
            h: z.array(z.tuple([z.string(), z.string()])).default([]),
            e: z.array(z.tuple([z.string(), z.string()])).default([]),
          })
          .parse(JSON.parse(state.scriptState.ANA_QUEUE))
      : { w: [], h: [], e: [] };
    const rows = [
      ...queue.w.map((url) => ({ url, status: "paused" })),
      ...queue.e.map(([url]) => ({ url, status: "failed" })),
    ];
    if (rows.length > 50)
      throw Error("Legacy analysis queue exceeds runtime limit");
    await db.query(
      "update public.jobs set status='cancelled',lease_owner=null,lease_until=null where kind='ANALYZE' and checkpoint->>'legacySource'=$1",
      [p.o.sourceKey],
    );
    const seen = new Set<string>();
    for (const [i, row] of rows.entries()) {
      const url = normUrl_(row.url);
      const existing = (
        await db.query(
          "select checkpoint from public.jobs where dedupe_key=$1",
          ["analysis:" + url],
        )
      ).rows[0];
      if (existing && existing.checkpoint.legacySource !== p.o.sourceKey)
        throw Error("Native analysis queue conflict");
      if (!/^https?:\/\//.test(url) || url.length > 2000)
        throw Error("Legacy queue URL invalid");
      if (seen.has(url)) throw Error("Legacy queue duplicate");
      seen.add(url);
      await db.query(
        "insert into public.jobs(kind,actor_id,status,priority,dedupe_key,checkpoint) values('ANALYZE',$1,$2,$3,$4,$5) on conflict(dedupe_key) do update set status=excluded.status,checkpoint=excluded.checkpoint,priority=excluded.priority,actor_id=excluded.actor_id,lease_owner=null,lease_until=null",
        [
          p.o.ownerId,
          row.status,
          rows.length - i,
          "analysis:" + url,
          JSON.stringify({
            request: { url, mode: "auto" },
            legacySource: p.o.sourceKey,
            migrationReviewRequired: true,
            ...(row.status === "failed"
              ? {
                  error:
                    "Lỗi phân tích từ dữ liệu cũ; xem archive riêng để đối soát",
                }
              : {}),
          }),
        ],
      );
    }
    for (const [book] of queue.h)
      if (
        !p.report.books.some(
          (b) => b.legacyId === book && b.legacyStatus === "ANALYZED",
        )
      )
        unresolved.push("ANALYZED_REFERENCE:" + book);
    if (unresolved.length)
      throw Error("Unresolved legacy private state; repair before retry");
    const report = {
      repeated: false,
      sourceKey: p.o.sourceKey,
      checksum,
      imports: state.imports.length,
      legacyLogRows: state.LOG.length,
      removedChapters: removed,
      analysisJobs: rows.length,
      unresolved,
      remoteWrites: 0,
      secretsImported: 0,
    };
    await db.query(
      "insert into private.legacy_transfers(source_key,checksum,report) values($1,$2,$3)",
      [p.o.sourceKey, checksum, JSON.stringify(report)],
    );
    return report;
  });
}
async function main() {
  const [input, options, state, output] = process.argv.slice(2);
  if (!input || !options || !state || !output)
    throw Error(
      "Usage: migration:reconcile -- export options private-state report",
    );
  await writeFile(output, "{}\n", { flag: "wx", mode: 0o600 });
  await localCommand(async (db) => {
    const report = await reconcileLegacyLocal(
      db,
      JSON.parse(await readFile(input, "utf8")),
      JSON.parse(await readFile(options, "utf8")),
      JSON.parse(await readFile(state, "utf8")),
    );
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        remoteWrites: 0,
        unresolved: report.unresolved.length,
        repeated: report.repeated,
      }),
    );
  });
}
if (process.argv[1]?.endsWith("reconcile-local.ts"))
  main().catch(() => {
    console.error(
      "Local legacy reconciliation failed; transaction rolled back, no Drive writes",
    );
    process.exitCode = 1;
  });

async function singleton(
  db: PoolClient,
  file: string,
  book: string,
  owner: string,
  kind: string,
) {
  const prior = (
    await db.query("select * from public.drive_resources where file_id=$1", [
      file,
    ])
  ).rows[0];
  if (
    prior &&
    (prior.book_id !== book ||
      prior.owner_subject !== owner ||
      prior.kind !== kind)
  )
    throw Error("File ownership conflict");
  await db.query(
    "delete from public.drive_resources where book_id=$1 and kind=$2 and file_id<>$3",
    [book, kind, file],
  );
}

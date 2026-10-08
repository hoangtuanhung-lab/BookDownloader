import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  dryRunMigration,
  LegacyExport,
  migrationId,
} from "../../packages/domain/src/migration";
import { localPool } from "../../packages/infrastructure/src/database";

const Progress = z.object({
  book: z.string(),
  order: z.union([z.string(), z.number()]),
  ratio: z.number().min(0).max(1),
  scrollPosition: z.number().nonnegative().default(0),
});
export const ImportOptions = z.object({
  sourceKey: z.string().min(1).max(120),
  ownerId: z.uuid(),
  ownerEmail: z.email(),
  driveSubject: z.string().min(1),
  skippedChapterKeys: z.array(z.string()).default([]),
  progress: z.array(Progress).default([]),
});
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
function timestamp(value: string) {
  if (!value) return null;
  const local = /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(
    value,
  );
  const iso = local
    ? `${local[3]}-${local[2]}-${local[1]}T${local[4] || "00"}:${local[5] || "00"}:${local[6] || "00"}+07:00`
    : value;
  if (
    !local &&
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      iso,
    )
  )
    throw Error("Unsupported legacy date; normalize explicitly");
  if (!Number.isFinite(Date.parse(iso))) throw Error("Invalid legacy date");
  const day = local ? `${local[3]}-${local[2]}-${local[1]}` : iso.slice(0, 10);
  const [year, month, date] = day.split("-").map(Number);
  if (
    new Date(Date.UTC(year, month - 1, date)).toISOString().slice(0, 10) !== day
  )
    throw Error("Invalid legacy calendar date");
  return iso;
}
export function prepareImport(input: unknown, options: unknown) {
  const data = LegacyExport.parse(input),
    o = ImportOptions.parse(options),
    report = dryRunMigration(data);
  const skipped = new Set(o.skippedChapterKeys);
  if (skipped.size !== o.skippedChapterKeys.length)
    throw Error("Duplicate skipped chapter key");
  for (const key of skipped) {
    const c = report.chapters.find((c) => c.legacyId === key);
    if (!c || c.status !== "DONE" || c.fileId)
      throw Error("Skipped marker must identify DONE without file");
  }
  const errors = report.issues.filter(
    (i) =>
      i.severity === "error" &&
      !(i.code === "MISSING_CHAPTER_FILE" && skipped.has(i.entity)),
  );
  if (!data.inventoryComplete || errors.length)
    throw Error("Migration inventory/validation gate failed");
  const root = data.properties.ROOT_FOLDER_ID || data.properties.ROOT_FOLDER;
  if (!root) throw Error("Missing inventory root");
  const files = new Map(data.files.map((f) => [f.id, f]));
  const rawChapters = new Map(
    data.CHAPTERS.map((r) => [String(r[0]) + ":" + String(r[1]), r]),
  );
  for (const b of report.books) {
    let current = b.folderId;
    const seen = new Set<string>();
    while (current !== root) {
      if (seen.has(current) || seen.size >= 32)
        throw Error("Invalid root ancestry");
      seen.add(current);
      const f = files.get(current);
      if (!f || f.trashed || f.parents.length !== 1)
        throw Error("Book outside root");
      current = f.parents[0];
    }
    if (!files.has(root) || files.get(root)?.trashed)
      throw Error("Missing root");
    timestamp(b.created);
  }
  for (const c of report.chapters) {
    timestamp(c.updated);
    const raw = rawChapters.get(c.legacyId)![1];
    if (!/^-?\d+(?:\.\d+)?$/.test(String(raw)))
      throw Error("Order must be decimal");
  }
  for (const p of o.progress) {
    const c = report.chapters.find(
      (c) => c.legacyId === p.book + ":" + p.order,
    );
    if (!c || c.status !== "DONE" || !c.fileId || skipped.has(c.legacyId))
      throw Error("Progress points at unreadable chapter");
  }
  if (new Set(o.progress.map((p) => p.book)).size !== o.progress.length)
    throw Error("Duplicate progress book");
  return {
    data,
    o,
    report,
    skipped,
    rawChapters,
    checksum: sha256(canonical({ data, options: o })),
    root,
  };
}

/** Caller uses a local-only pool. No Drive IO, no outbox creation, no automatic publication/resume. */
export async function importLegacyLocal(
  db: PoolClient,
  input: unknown,
  options: unknown,
) {
  const p = prepareImport(input, options),
    { data, o, report, skipped, rawChapters, checksum } = p;
  await db.query("begin");
  try {
    await db.query("select pg_advisory_xact_lock(610080008)");
    const owner = (
      await db.query(
        "select 1 from auth.users u join public.profiles p on p.id=u.id join private.bootstrap_owner b on b.user_id=u.id where u.id=$1 and lower(u.email)=lower($2) and u.email_confirmed_at is not null and p.status='active' and exists(select 1 from public.user_permissions where user_id=u.id and permission='admin')",
        [o.ownerId, o.ownerEmail],
      )
    ).rowCount;
    if (!owner) throw Error("Verified bootstrap owner binding required");
    const prior = (
      await db.query(
        "select checksum,report from private.legacy_imports where source_key=$1",
        [o.sourceKey],
      )
    ).rows[0];
    if (prior) {
      if (prior.checksum !== checksum)
        throw Error("Snapshot conflict; use a reviewed delta migration");
      const missing = await db.query(
        "select 1 from public.migration_items m where m.run_id=(select run_id from private.legacy_imports where source_key=$1) and ((m.entity_kind='book' and not exists(select 1 from public.books b where b.id=m.new_id and b.deleted_at is null)) or (m.entity_kind='chapter' and not exists(select 1 from public.chapters c where c.id=m.new_id))) limit 1",
        [o.sourceKey],
      );
      if (missing.rowCount)
        throw Error(
          "Mapped resource missing/deleted; restore or reconcile explicitly",
        );
      await db.query("commit");
      return { ...prior.report, repeated: true };
    }
    // This local rehearsal requires a clean migration target. Existing application rows are never overwritten.
    if (
      (await db.query("select 1 from public.books limit 1")).rowCount ||
      (
        await db.query(
          "select 1 from public.jobs where status in ('queued','running') limit 1",
        )
      ).rowCount ||
      (
        await db.query(
          "select 1 from public.outbox_operations where status in ('pending','running') limit 1",
        )
      ).rowCount
    )
      throw Error("Use an empty local rehearsal database");
    const run = randomUUID();
    await db.query(
      "insert into public.migration_runs(id,baseline_commit,status) values($1,'aae3c570286edac1db5ca355cbce40f5108d0a10','running')",
      [run],
    );
    const mapped = async (kind: string, legacy: string, id: string) => {
      await db.query(
        "insert into public.migration_items values($1,$2,$3,$4,'mapped')",
        [run, legacy, kind, id],
      );
    };
    for (const b of report.books) {
      const status = ["DOWNLOADING", "QUEUED"].includes(b.status!)
        ? "PAUSED"
        : b.status;
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
          status,
          timestamp(b.created),
        ],
      );
      await db.query("select private.set_genres($1,$2)", [
        b.id,
        JSON.stringify(b.genres),
      ]);
      await mapped("book", b.legacyId, b.id);
      await db.query(
        "insert into private.legacy_book_review(book_id) values($1)",
        [b.id],
      );
      if (
        ["READY", "IDLE", "DOWNLOADING", "PAUSED"].includes(b.legacyStatus) &&
        b.sourceType !== "FOLDER"
      )
        await db.query(
          "insert into public.jobs(kind,book_id,actor_id,status,dedupe_key,checkpoint) values($1,$2,$3,'paused',$4,$5)",
          [
            b.sourceType === "FILE" ? "FILE_IMPORT" : "WEB_DOWNLOAD",
            b.id,
            o.ownerId,
            "download:" + b.id,
            JSON.stringify({
              mode: b.sourceType === "FILE" ? "verify" : "download",
              migrationReviewRequired: true,
              legacyStatus: b.legacyStatus,
            }),
          ],
        );
    }
    for (const g of report.groups)
      await db.query(
        "insert into public.chapter_groups(id,book_id,parent_id,kind,name,order_key) values($1,$2,$3,$4,$5,$6)",
        [g.id, g.bookId, g.parentId, g.kind, g.name, g.orderKey],
      );
    for (const c of report.chapters) {
      const raw = rawChapters.get(c.legacyId)!;
      await db.query(
        "insert into public.chapters(id,book_id,group_id,legacy_order,order_key,display_number,title,source_url,status,file_id,retry_count,error_code,is_skipped) values($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
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
          skipped.has(c.legacyId),
        ],
      );
      if (c.fileId)
        await db.query(
          "insert into public.drive_resources(file_id,book_id,chapter_id,owner_subject,kind,metadata_version,sync_status) values($1,$2,$3,$4,'CHAPTER',1,'pending')",
          [c.fileId, c.bookId, c.id, o.driveSubject],
        );
      await mapped("chapter", c.legacyId, c.id);
    }
    for (const v of o.progress)
      await db.query(
        "insert into public.reading_progress(user_id,book_id,chapter_id,ratio,scroll_position) values($1,$2,$3,$4,$5)",
        [
          o.ownerId,
          migrationId("book", v.book),
          migrationId("chapter", v.book + ":" + v.order),
          v.ratio,
          v.scrollPosition,
        ],
      );
    const result = {
      schemaVersion: 1,
      sourceKey: o.sourceKey,
      checksum,
      runId: run,
      repeated: false,
      driveWrites: 0,
      published: 0,
      totals: report.totals,
      skipped: skipped.size,
      progress: o.progress.length,
      review: {
        books: report.books.map((b) => ({
          id: b.id,
          legacyStatus: b.legacyStatus,
          created: b.created,
        })),
        chapterDates: report.chapters.map((c) => ({
          id: c.id,
          updated: c.updated,
        })),
        config: report.config,
        properties: report.properties,
        logRows: report.legacyLogRows,
        issues: report.issues,
        required: [
          "Verify Drive access and file hashes",
          "Review CONFIG and secrets separately",
          "Review ANA_QUEUE / IMP_ / removed logs from private export",
          "Verify progress provenance; browser-origin export is manual",
          "Review paused jobs; do not reuse legacy leases",
          "Publish selected books explicitly",
        ],
      },
    };
    await db.query(
      "update public.migration_runs set status='done',report=$2 where id=$1",
      [run, JSON.stringify(result)],
    );
    await db.query(
      "insert into private.legacy_imports(source_key,checksum,run_id,owner_id,report) values($1,$2,$3,$4,$5)",
      [o.sourceKey, checksum, run, o.ownerId, JSON.stringify(result)],
    );
    await db.query(
      "insert into public.audit_logs(actor_id,action,details) values($1,'legacy_import_local',$2)",
      [
        o.ownerId,
        JSON.stringify({
          run,
          checksum,
          books: report.books.length,
          chapters: report.chapters.length,
        }),
      ],
    );
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}
async function main() {
  const [input, options, output] = process.argv.slice(2);
  if (!input || !options || !output)
    throw Error(
      "Usage: migration:local -- export.json options.json report.json",
    );
  // Reserve private report before DB writes; existing output is never overwritten.
  await writeFile(output, '{"status":"reserved"}\n', {
    flag: "wx",
    mode: 0o600,
  });
  const pool = localPool(
      process.env.DATABASE_URL ||
        "postgresql://postgres:local-only-password@127.0.0.1:55432/bookdownloader",
    ),
    db = await pool.connect();
  try {
    const result = await importLegacyLocal(
      db,
      JSON.parse(await readFile(input, "utf8")),
      JSON.parse(await readFile(options, "utf8")),
    );
    await writeFile(output, JSON.stringify(result, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        repeated: result.repeated,
        driveWrites: 0,
        published: 0,
      }),
    );
  } catch {
    console.error(
      "Local import failed; inspect validation and private output. No Drive writes.",
    );
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("import-local.ts"))
  main().catch(() => {
    console.error("Local command failed; no credentials logged");
    process.exitCode = 1;
  });

export { timestamp as legacyTimestamp };

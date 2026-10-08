import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { PoolClient } from "pg";
import { prepareImport } from "./import-local";
import { verifyLocalFiles } from "./verify-local-files";
import { localCommand, withOperation } from "../operations/local";
export async function verifyAndRegisterLocalFiles(
  db: PoolClient,
  input: unknown,
  options: unknown,
  directory: string,
  manifest: unknown,
) {
  const p = prepareImport(input, options),
    files = z
      .record(
        z.string(),
        z.object({
          path: z.string(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      )
      .parse(manifest);
  const verified = await verifyLocalFiles(input, options, directory, manifest);
  if (!verified.ready) throw Error("Content verification failed");
  return withOperation(
    db,
    p.o.ownerId,
    "legacy_verify_local_files",
    async () => {
      const imported = (
        await db.query(
          "select checksum from private.legacy_imports where source_key=$1 and owner_id=$2",
          [p.o.sourceKey, p.o.ownerId],
        )
      ).rows[0];
      if (imported?.checksum !== p.checksum)
        throw Error("Source checksum conflict");
      for (const c of p.report.chapters) {
        if (!c.fileId) continue;
        const updated = await db.query(
          "update public.drive_resources r set sync_status='synced',content_hash=$5 from public.chapters c where r.file_id=$1 and r.book_id=$2 and r.chapter_id=$3 and r.owner_subject=$4 and r.kind='CHAPTER' and c.id=r.chapter_id and c.file_id=r.file_id",
          [c.fileId, c.bookId, c.id, p.o.driveSubject, files[c.fileId].sha256],
        );
        if (updated.rowCount !== 1)
          throw Error("Resource changed during verification");
      }
      return {
        checked: verified.checked,
        remoteWrites: 0,
        localBackupOnly: true,
        liveDriveAccessVerified: false,
      };
    },
  );
}
async function main() {
  const [input, options, root, manifest, output] = process.argv.slice(2);
  if (!input || !options || !root || !manifest || !output)
    throw Error(
      "Usage: migration:verify-apply-local -- EXPORT OPTIONS BACKUP_ROOT MANIFEST REPORT",
    );
  await writeFile(output, "{}\n", { flag: "wx", mode: 0o600 });
  await localCommand(async (db) => {
    const report = await verifyAndRegisterLocalFiles(
      db,
      JSON.parse(await readFile(input, "utf8")),
      JSON.parse(await readFile(options, "utf8")),
      root,
      JSON.parse(await readFile(manifest, "utf8")),
    );
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(JSON.stringify(report));
  });
}
if (process.argv[1]?.endsWith("verify-apply-local.ts"))
  main().catch(() => {
    console.error("Local verification registration failed; no Drive writes");
    process.exitCode = 1;
  });

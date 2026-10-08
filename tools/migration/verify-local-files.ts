import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { prepareImport, sha256 } from "./import-local";
const Manifest = z.record(
  z.string(),
  z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
);
/** Hash every referenced chapter against a separately retained pre-migration manifest. */
export async function verifyLocalFiles(
  input: unknown,
  options: unknown,
  directory: string,
  manifest: unknown,
) {
  const p = prepareImport(input, options),
    mapping = Manifest.parse(manifest),
    root = await realpath(directory);
  const results: { id: string; ok: boolean; code: string; bytes?: number }[] =
    [];
  for (const c of p.report.chapters) {
    if (!c.fileId) continue;
    const id = c.fileId,
      entry = mapping[id];
    if (!entry) {
      results.push({ id, ok: false, code: "MISSING_MANIFEST" });
      continue;
    }
    try {
      const path = await realpath(resolve(root, entry.path)),
        rel = relative(root, path);
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
        throw Error("Outside backup root");
      const bytes = await readFile(path),
        size = p.data.files.find((f) => f.id === id)?.sizeBytes;
      const ok =
        sha256(bytes) === entry.sha256 &&
        (size === undefined || size === bytes.length);
      results.push({
        id,
        ok,
        code: ok ? "MATCH" : "HASH_OR_SIZE_MISMATCH",
        bytes: bytes.length,
      });
    } catch {
      results.push({ id, ok: false, code: "MISSING_OR_OUTSIDE_BACKUP" });
    }
  }
  return {
    ready: results.every((r) => r.ok),
    driveWrites: 0,
    checked: results.length,
    results,
  };
}
async function main() {
  const [input, options, directory, manifest, output] = process.argv.slice(2);
  if (!input || !options || !directory || !manifest || !output)
    throw Error(
      "Usage: migration:verify-files -- export.json options.json backup-dir manifest.json report.json",
    );
  try {
    const report = await verifyLocalFiles(
      JSON.parse(await readFile(input, "utf8")),
      JSON.parse(await readFile(options, "utf8")),
      directory,
      JSON.parse(await readFile(manifest, "utf8")),
    );
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        ready: report.ready,
        checked: report.checked,
        driveWrites: 0,
      }),
    );
    if (!report.ready) process.exitCode = 2;
  } catch {
    console.error("Local file verification failed");
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("verify-local-files.ts"))
  main().catch(() => {
    console.error("Local command failed; no credentials logged");
    process.exitCode = 1;
  });

import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { releaseContract } from "../../packages/contracts/src/release";
import { fileHash } from "../operations/backup";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function list(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = directory + "/" + item.name;
    if (item.isSymbolicLink()) throw Error("Artifact symlinks refused");
    if (item.isDirectory()) files.push(...(await list(path)));
    else files.push(path);
  }
  return files.sort();
}
export async function prepareRelease(output: string, allowDirty = false) {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    dirty =
      execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
      }).trim().length > 0;
  if (dirty && !allowDirty)
    throw Error("Commit changes before producing a release candidate");
  const build = JSON.parse(await readFile("dist/build-record.json", "utf8"));
  if (build.revision !== revision)
    throw Error(
      "Server artifacts are from another revision; rebuild after commit",
    );
  for (const path of ["dist/api.mjs", "dist/worker.mjs", "dist/library-worker-background.mjs", "dist/library-worker-schedule.mjs"])
    if ((await fileHash(path)) !== build.files[path])
      throw Error("Server build hash mismatch");
  const paths = [
      ...(await list("apps/web/dist")),
      "dist/api.mjs",
      "dist/worker.mjs",
      "dist/library-worker-background.mjs",
      "dist/library-worker-schedule.mjs",
      "dist/build-record.json",
    ],
    files: Record<string, string> = {};
  for (const p of paths) files[p] = await fileHash(p);
  const migrations = [];
  for (const name of (await readdir("supabase/migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    migrations.push({
      name,
      sha256: hash(await readFile("supabase/migrations/" + name, "utf8")),
    });
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  if (lock.version !== releaseContract.version)
    throw Error("Lockfile version mismatch");
  const manifest = {
    schemaVersion: 1,
    ...releaseContract,
    revision,
    dirty,
    createdAt: new Date().toISOString(),
    lockSha256: await fileHash("package-lock.json"),
    files,
    migrations,
    gates: {
      cloudTested: false,
      realMigrationAccepted: false,
      productionActivated: false,
    },
  };
  await mkdir(output, { recursive: true });
  await writeFile(
    resolve(output, "release-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return manifest;
}
async function main() {
  const output = process.argv[2];
  if (!output)
    throw Error("Usage: release:prepare -- NEW_OUTPUT_DIR [--allow-dirty]");
  const m = await prepareRelease(
    output,
    process.argv.includes("--allow-dirty"),
  );
  console.log(
    JSON.stringify({
      prepared: true,
      revision: m.revision,
      dirty: m.dirty,
      cloudActivated: false,
    }),
  );
}
if (process.argv[1]?.endsWith("prepare.ts"))
  main().catch(() => {
    console.error(
      "Release preparation failed; build and commit a clean candidate first",
    );
    process.exitCode = 1;
  });

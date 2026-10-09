import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";
export async function verifyArtifact(directory, expectedRevision) {
  const root = await realpath(directory),
    manifest = JSON.parse(
      await readFile(resolve(root, "release-manifest.json"), "utf8"),
    );
  if (
    !/^[a-f0-9]{40}$/.test(expectedRevision) ||
    manifest.schemaVersion !== 1 ||
    manifest.revision !== expectedRevision ||
    manifest.dirty ||
    manifest.contractVersion !== 1
  )
    throw Error("Release identity mismatch");
  if (
    !manifest.files?.["dist/api.mjs"] ||
    !manifest.files?.["dist/worker.mjs"] ||
    !manifest.files?.["dist/library-worker-background.mjs"] ||
    !manifest.files?.["dist/library-worker-schedule.mjs"] ||
    !manifest.files?.["dist/build-record.json"] ||
    !manifest.files?.["apps/web/dist/index.html"] ||
    !Object.keys(manifest.files).some((p) =>
      /^apps\/web\/dist\/assets\/.*\.js$/.test(p),
    )
  )
    throw Error("Incomplete artifact");
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (
      !/^[a-f0-9]{64}$/.test(hash) ||
      !/^(apps\/web\/dist\/|dist\/((api|worker|library-worker-background|library-worker-schedule)\.mjs|build-record\.json)$)/.test(
        path,
      )
    )
      throw Error("Invalid artifact manifest");
    const full = await realpath(resolve(root, path)),
      rel = relative(root, full);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
      throw Error("Artifact path escape");
    if (
      createHash("sha256")
        .update(await readFile(full))
        .digest("hex") !== hash
    )
      throw Error("Artifact checksum mismatch");
  }
  return manifest;
}
if (process.argv[1]?.endsWith("verify-artifact.mjs"))
  verifyArtifact(process.argv[2], process.argv[3])
    .then(() => console.log("Release artifact verified"))
    .catch(() => {
      console.error("Release artifact verification failed");
      process.exitCode = 1;
    });

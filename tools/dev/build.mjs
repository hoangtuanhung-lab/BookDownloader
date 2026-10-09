import { writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
const revision =
  process.env.RELEASE_REVISION ||
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(revision))
  throw Error("A full release revision is required");
const define = { __BOOK_RELEASE_REVISION__: JSON.stringify(revision) };
await build({
  define,
  entryPoints: ["apps/worker/src/main.ts"],
  outfile: "dist/worker.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
});
await build({
  define,
  entryPoints: ["netlify/functions/api.ts"],
  outfile: "dist/api.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
});

for (const name of ["library-worker-background", "library-worker-schedule"]) {
  await build({ define, entryPoints: ["netlify/functions/" + name + ".ts"], outfile: "dist/" + name + ".mjs", bundle: true, platform: "node", target: "node24", format: "esm", packages: "external" });
}
const hashes = {};
for (const name of ["api.mjs", "worker.mjs", "library-worker-background.mjs", "library-worker-schedule.mjs"])
  hashes["dist/" + name] = createHash("sha256")
    .update(await readFile("dist/" + name))
    .digest("hex");
await writeFile(
  "dist/build-record.json",
  JSON.stringify({ revision, files: hashes }) + "\n",
);

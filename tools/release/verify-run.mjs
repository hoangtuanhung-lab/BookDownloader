import { readFile } from "node:fs/promises";
export function verifyRun(run, repository, sha) {
  if (
    !/^[a-f0-9]{40}$/.test(sha) ||
    !/^\w[\w.-]*\/[\w.-]+$/.test(repository) ||
    run.conclusion !== "success" ||
    run.status !== "completed" ||
    run.event !== "push" ||
    run.head_branch !== "main" ||
    run.head_sha !== sha ||
    run.path !== ".github/workflows/phase-1.yml" ||
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository
  )
    throw Error(
      "Only a successful main push from this repository can be released",
    );
  return true;
}
if (process.argv[1]?.endsWith("verify-run.mjs")) {
  try {
    verifyRun(
      JSON.parse(await readFile(process.argv[2], "utf8")),
      process.env.GH_REPO,
      process.env.EXPECTED_SHA,
    );
    console.log("CI provenance verified");
  } catch {
    console.error("CI provenance rejected");
    process.exitCode = 1;
  }
}

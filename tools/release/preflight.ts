import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { localCommand } from "../operations/local";
import { releaseContract } from "../../packages/contracts/src/release";
export async function localPreflight(db: PoolClient, actor: string) {
  const applied = new Map(
    (
      await db.query("select name,checksum from public.schema_migrations")
    ).rows.map((r) => [r.name, r.checksum]),
  );
  const names = (await readdir("supabase/migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort();
  for (const name of names) {
    const hash = createHash("sha256")
      .update(await readFile("supabase/migrations/" + name, "utf8"))
      .digest("hex");
    if (applied.get(name) !== hash)
      throw Error("Schema revision/checksum mismatch");
  }
  if (applied.size !== names.length) throw Error("Unexpected schema revision");
  const status = (
    await db.query("select public.app_operations($1,'status') v", [actor])
  ).rows[0].v;
  const localReady =
    status.maintenance &&
    !!status.rootId &&
    Object.values(status.alerts).every((v) => v === 0);
  return {
    ...releaseContract,
    schemaVerified: true,
    localReady,
    status,
    gates: {
      cloudTested: false,
      realMigrationAccepted: false,
      productionActivated: false,
    },
  };
}
async function main() {
  const actor = z.uuid().parse(process.env.BOOTSTRAP_ADMIN_USER_ID);
  await localCommand(async (db) => {
    const result = await localPreflight(db, actor);
    console.log(JSON.stringify(result));
    if (!result.localReady) process.exitCode = 1;
  });
}
if (process.argv[1]?.endsWith("preflight.ts"))
  main().catch(() => {
    console.error(
      "Local preflight failed; inspect schema checksums, owner binding and operation alerts",
    );
    process.exitCode = 1;
  });

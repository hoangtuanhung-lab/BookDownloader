import { z } from "zod";
import { localCommand } from "./local";
async function main() {
  const actor = z.uuid().parse(process.env.BOOTSTRAP_ADMIN_USER_ID),
    mode = z.enum(["on", "off"]).parse(process.argv[2]);
  await localCommand(async (db) => {
    const value = (
      await db.query("select public.app_operations($1,'maintenance',$2) v", [
        actor,
        JSON.stringify({ enabled: mode === "on" }),
      ])
    ).rows[0].v;
    console.log(JSON.stringify(value));
  });
}
main().catch(() => {
  console.error(
    "Maintenance change refused; verify admin binding and wait for active writers",
  );
  process.exitCode = 1;
});

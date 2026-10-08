import { z } from "zod";
import { localCommand } from "./local";
async function main() {
  const actor = z.uuid().parse(process.env.BOOTSTRAP_ADMIN_USER_ID);
  await localCommand(async (db) => {
    console.log(
      JSON.stringify(
        (
          await db.query(
            "select public.app_operations($1,'status') as status",
            [actor],
          )
        ).rows[0].status,
      ),
    );
  });
}
main().catch(() => {
  console.error(
    "Local operations status unavailable; verify database and admin binding",
  );
  process.exitCode = 1;
});

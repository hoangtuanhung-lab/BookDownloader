import type { PoolClient } from "pg";
import { localPool } from "../../packages/infrastructure/src/database";
export const localUrl = () =>
  process.env.DATABASE_URL ||
  "postgresql://postgres:local-only-password@127.0.0.1:55432/bookdownloader";
export async function withOperation<T>(
  db: PoolClient,
  owner: string,
  action: string,
  run: () => Promise<T>,
) {
  await db.query("begin");
  try {
    await db.query("select pg_advisory_xact_lock(610090001)");
    await db.query("select private.require_permission($1,'admin')", [owner]);
    if (
      !(
        await db.query(
          "select maintenance from private.runtime_control where singleton",
        )
      ).rows[0].maintenance
    )
      throw Error("Maintenance required");
    if (
      !(
        await db.query(
          "select 1 from private.bootstrap_owner where user_id=$1",
          [owner],
        )
      ).rowCount
    )
      throw Error("Bootstrap owner required");
    await db.query(
      "insert into private.operation_transactions values(pg_current_xact_id())",
    );
    const result = await run();
    await db.query(
      "delete from private.operation_transactions where txid=pg_current_xact_id()",
    );
    await db.query(
      "insert into private.operation_events(actor_id,action) values($1,$2)",
      [owner, action],
    );
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}
export async function localCommand(run: (db: PoolClient) => Promise<void>) {
  const pool = localPool(localUrl()),
    db = await pool.connect();
  try {
    await run(db);
  } finally {
    db.release();
    await pool.end();
  }
}

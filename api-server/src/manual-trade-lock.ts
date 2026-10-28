import type { PoolClient } from "pg";
import { db } from "./database.js";

/** Serialize condition edits and closes across API instances without a long DB transaction. */
export async function withManualTradeLock<T>(id: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  const key = `manual-trade-action:${id}`;
  let locked = false;
  let discard = false;
  try {
    locked = Boolean((await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [key])).rows[0]?.locked);
    if (!locked) throw new Error("This trade is being updated. Try again shortly.");
    return await work(client);
  } finally {
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]); }
      catch { discard = true; }
    }
    client.release(discard);
  }
}

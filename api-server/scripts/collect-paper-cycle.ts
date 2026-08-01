import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

const { collectPaperCycle } = await import("../src/paper-cycle.js");
const { db, query } = await import("../src/database.js");

const result = await collectPaperCycle();
const [watch, batches, open] = await Promise.all([
  query<{ count: string }>("SELECT count(*)::text AS count FROM paper_watch_snapshots"),
  query<{ count: string }>("SELECT count(*)::text AS count FROM paper_strategy_batches"),
  query<{ count: string }>("SELECT count(*)::text AS count FROM paper_strategy_trades WHERE status='open'"),
]);
console.log(JSON.stringify({ ...result, watchSnapshots: Number(watch.rows[0]?.count ?? 0), batches: Number(batches.rows[0]?.count ?? 0), openTrades: Number(open.rows[0]?.count ?? 0) }));
await db().end();

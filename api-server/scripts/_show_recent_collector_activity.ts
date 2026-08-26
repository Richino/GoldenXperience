import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

// tables with a candidate "when was this written" column
const targets: { table: string; tsCol: string }[] = [
  { table: "paper_watch_snapshots", tsCol: "evaluated_at" },
  { table: "paper_strategy_evaluations", tsCol: "evaluated_at" },
  { table: "paper_strategy_trades", tsCol: "decision_time" },
  { table: "paper_trade_events", tsCol: "occurred_at" },
  { table: "practice_order_intents", tsCol: "created_at" },
  { table: "trade_candidates", tsCol: "created_at" },
  { table: "research_experiment_trades", tsCol: "decision_time" },
];

console.log("Recent write activity across data-collection tables:");
console.log("table                              rows total  max(ts)                     rows in last 6h  rows in last 24h");
for (const t of targets) {
  try {
    const r = await query<{ n: string; latest: string | null; last6h: string; last24h: string }>(
      `SELECT count(*)::text AS n, max(${t.tsCol})::text AS latest,
              count(*) FILTER (WHERE ${t.tsCol} > now() - interval '6 hours')::text AS last6h,
              count(*) FILTER (WHERE ${t.tsCol} > now() - interval '24 hours')::text AS last24h
         FROM ${t.table}`,
    );
    const row = r.rows[0]!;
    console.log(`  ${t.table.padEnd(34)} ${String(row.n).padStart(9)}  ${(row.latest ?? "—").padEnd(27)} ${String(row.last6h).padStart(15)}  ${String(row.last24h).padStart(15)}`);
  } catch (e) { console.log(`  ${t.table.padEnd(34)} (error) ${(e as Error).message}`); }
}

// Look at paper_watch_snapshots content — the 15-min setup evaluator
try {
  const wsCols = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name='paper_watch_snapshots' ORDER BY ordinal_position`);
  console.log(`\npaper_watch_snapshots columns: ${wsCols.rows.map((r) => r.column_name).join(", ")}`);
  const ws = await query<{ instrument: string; evaluated_at: string; setup_status: string | null; direction: string | null; strategy_version_id: string | null; batch_number: string | null }>(
    `SELECT instrument, evaluated_at, setup_status, direction, strategy_version_id, batch_number::text
       FROM paper_watch_snapshots ORDER BY evaluated_at DESC LIMIT 20`);
  console.log("\nlast 20 paper_watch_snapshots:");
  for (const r of ws.rows) {
    console.log(`  ${r.evaluated_at}  ${r.instrument.padEnd(8)}  ${(r.setup_status ?? "-").padEnd(10)}  dir=${r.direction ?? "-"}  ver=${(r.strategy_version_id ?? "-").slice(0, 8)}  batch=${r.batch_number ?? "-"}`);
  }
} catch (e) { console.log("paper_watch_snapshots read failed:", (e as Error).message); }

// paper_strategy_evaluations — schema + recent rows
try {
  const eCols = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name='paper_strategy_evaluations' ORDER BY ordinal_position`);
  console.log(`\npaper_strategy_evaluations columns: ${eCols.rows.map((r) => r.column_name).join(", ")}`);
  const perFamily = await query<{ strategy_family: string | null; n: string; latest: string | null; last24h: string }>(
    `SELECT strategy_family, count(*)::text AS n, max(evaluated_at)::text AS latest,
            count(*) FILTER (WHERE evaluated_at > now() - interval '24 hours')::text AS last24h
       FROM paper_strategy_evaluations GROUP BY strategy_family ORDER BY max(evaluated_at) DESC NULLS LAST`);
  console.log("\npaper_strategy_evaluations by family:");
  for (const r of perFamily.rows) console.log(`  ${(r.strategy_family ?? "(null)").padEnd(20)} rows=${r.n.padStart(6)}  latest=${(r.latest ?? "-").padEnd(27)}  last24h=${r.last24h}`);
} catch (e) { console.log("paper_strategy_evaluations read failed:", (e as Error).message); }

process.exit(0);

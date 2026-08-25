import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

const batches = await query<{
  batch_number: number;
  status: string;
  assigned_count: number;
  strategy_family: string | null;
  experiment_id: string | null;
  started_at: string;
  completed_at: string | null;
}>(`SELECT batch_number, status, assigned_count, strategy_family, experiment_id, started_at, completed_at
     FROM paper_strategy_batches WHERE batch_number <= 10 ORDER BY batch_number`);

console.log("=== BATCHES 1-10 ===");
for (const b of batches.rows) {
  console.log(`  #${b.batch_number} ${b.status} assigned=${b.assigned_count} family=${b.strategy_family ?? "—"} experiment=${b.experiment_id ?? "—"} started=${b.started_at} completed=${b.completed_at ?? "—"}`);
}

const perBatch = await query<{ batch_number: number; total: number; closed: number; resolved: number; open: number; families: string; experiments: string }>(
  `SELECT b.batch_number,
          count(*)::int AS total,
          count(*) FILTER (WHERE t.status='closed')::int AS closed,
          count(*) FILTER (WHERE t.status='closed' AND t.result_r IS NOT NULL)::int AS resolved,
          count(*) FILTER (WHERE t.status='open')::int AS open,
          COALESCE(string_agg(DISTINCT COALESCE(t.strategy_family,'(null)'), ','), '') AS families,
          COALESCE(string_agg(DISTINCT COALESCE(t.experiment_id::text,'(null)'), ','), '') AS experiments
     FROM paper_strategy_trades t
     JOIN paper_strategy_batches b ON b.id = t.batch_id
    WHERE b.batch_number BETWEEN 1 AND 6
    GROUP BY b.batch_number ORDER BY b.batch_number`);
console.log("\n=== BATCHES 1-6 trade breakdown ===");
for (const r of perBatch.rows) {
  console.log(`  #${r.batch_number} total=${r.total} closed=${r.closed} resolved=${r.resolved} open=${r.open}`);
  console.log(`     families: ${r.families}`);
  console.log(`     experiments: ${r.experiments}`);
}

process.exit(0);

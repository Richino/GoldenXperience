import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

const tables = await query<{ table_name: string }>(
  `SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND (table_name ILIKE '%trade%' OR table_name ILIKE '%paper%' OR table_name ILIKE '%practice%')
    ORDER BY table_name`);
console.log("trade-ish tables:");
for (const r of tables.rows) console.log("  ", r.table_name);

const bs = await query<{ batch_number: number; assigned_count: number }>(
  `SELECT batch_number, assigned_count FROM paper_strategy_batches WHERE batch_number BETWEEN 1 AND 6 ORDER BY batch_number`);
console.log("\npaper_strategy_batches assigned_count 1..6 (sum):");
let sum = 0;
for (const r of bs.rows) { console.log("  ", r.batch_number, r.assigned_count); sum += r.assigned_count; }
console.log("  TOTAL:", sum);

const st = await query<{ batch_number: number; status: string; n: number }>(
  `SELECT b.batch_number, t.status, count(*)::int AS n
     FROM paper_strategy_trades t JOIN paper_strategy_batches b ON b.id=t.batch_id
    WHERE b.batch_number BETWEEN 1 AND 6 GROUP BY 1,2 ORDER BY 1,2`);
console.log("\npaper_strategy_trades by batch/status:");
for (const r of st.rows) console.log(" ", r.batch_number, r.status, r.n);

// count each trade-ish table
for (const t of tables.rows) {
  try {
    const c = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t.table_name}`);
    console.log(`  ${t.table_name}: ${c.rows[0]!.n}`);
  } catch (e) { console.log(`  ${t.table_name}: (error) ${(e as Error).message}`); }
}

// look for other columns that might indicate 109
try {
  const c = await query<{ n: number }>(`SELECT count(*)::int AS n FROM paper_strategy_trades`);
  console.log(`\ntotal paper_strategy_trades rows: ${c.rows[0]!.n}`);
} catch {}

// closed by batch — maybe some are on batches>=7 that user considers "still under batch 6"?
const dist = await query<{ batch_number: number; n: number; closed: number; resolved: number }>(
  `SELECT b.batch_number, count(*)::int AS n,
          count(*) FILTER (WHERE t.status='closed')::int AS closed,
          count(*) FILTER (WHERE t.status='closed' AND t.result_r IS NOT NULL)::int AS resolved
     FROM paper_strategy_trades t JOIN paper_strategy_batches b ON b.id=t.batch_id
    GROUP BY b.batch_number ORDER BY b.batch_number`);
console.log("\nALL batches, trade counts:");
for (const r of dist.rows) console.log(" ", r.batch_number, `n=${r.n} closed=${r.closed} resolved=${r.resolved}`);

process.exit(0);

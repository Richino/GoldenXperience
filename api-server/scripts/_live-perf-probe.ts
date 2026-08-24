/**
 * Live multi-strategy paper + assignment performance probe.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

for (const table of ["paper_strategy_trades", "paper_strategy_evaluations", "paper_trades", "trade_candidates"]) {
  const cols = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`,
    [table],
  );
  console.log(`\n${table}:`, cols.rows.map((r) => r.column_name).join(", "));
}

const stratTrades = await query(
  `SELECT strategy_family, status, outcome,
          count(*)::int AS n,
          count(*) FILTER (WHERE result_r > 0)::int AS wins,
          count(*) FILTER (WHERE result_r < 0)::int AS losses,
          avg(result_r)::float AS avg_r,
          sum(result_r)::float AS net_r
     FROM paper_strategy_trades
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3`,
).catch(async (e: Error) => {
  console.log("paper_strategy_trades aggregate failed:", e.message);
  // try guessing column names
  return null;
});
if (stratTrades) {
  console.log("\n=== paper_strategy_trades ===");
  console.table(stratTrades.rows);
}

const evals = await query(
  `SELECT strategy_family, status,
          count(*)::int AS n
     FROM paper_strategy_evaluations
    GROUP BY 1, 2
    ORDER BY 1, 2`,
).catch((e: Error) => {
  console.log("evals failed", e.message);
  return null;
});
if (evals) {
  console.log("\n=== evaluations ===");
  console.table(evals.rows);
}

const legacy = await query(
  `SELECT status, result, count(*)::int AS n,
          avg(result_r)::float AS avg_r,
          sum(result_r)::float AS net_r,
          count(*) FILTER (WHERE result_r > 0)::int AS wins,
          count(*) FILTER (WHERE result_r < 0)::int AS losses
     FROM paper_trades
    GROUP BY 1, 2
    ORDER BY 1, 2`,
);
console.log("\n=== legacy paper_trades ===");
console.table(legacy.rows);

const recent = await query(
  `SELECT pair, direction, status, result, result_r, opened_at, closed_at, reason
     FROM paper_trades
    ORDER BY opened_at DESC NULLS LAST
    LIMIT 25`,
);
console.log("\n=== recent paper_trades ===");
console.table(recent.rows);

process.exit(0);

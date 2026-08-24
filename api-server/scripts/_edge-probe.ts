/**
 * One-shot probe: DB connectivity + live paper / shadow performance by family.
 * Writes nothing permanent.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

const tables = await query<{ table_name: string }>(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`,
);
console.log("tables:", tables.rows.map((r) => r.table_name).join(", "));

const candles = await query<{ n: number; instruments: number; min_t: string; max_t: string }>(
  `SELECT count(*)::int AS n,
          count(DISTINCT instrument)::int AS instruments,
          min(close_time)::text AS min_t,
          max(close_time)::text AS max_t
     FROM market_candles WHERE source='oanda' AND timeframe='M15'`,
);
console.log("m15 candles:", candles.rows[0]);

const paper = await query<{
  family: string | null;
  status: string;
  n: number;
  wins: number;
  losses: number;
  avg_r: number | null;
  net_r: number | null;
}>(
  `SELECT evaluation.strategy_family AS family,
          trade.status,
          count(*)::int AS n,
          count(*) FILTER (WHERE trade.result_r > 0)::int AS wins,
          count(*) FILTER (WHERE trade.result_r < 0)::int AS losses,
          avg(trade.result_r)::float AS avg_r,
          sum(trade.result_r)::float AS net_r
     FROM paper_trades trade
     LEFT JOIN paper_strategy_evaluations evaluation ON evaluation.id = trade.evaluation_id
    GROUP BY 1, 2
    ORDER BY 1, 2`,
).catch(async (error: Error) => {
  console.log("paper join failed:", error.message);
  const cols = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name='paper_trades' ORDER BY ordinal_position`,
  );
  console.log("paper_trades cols:", cols.rows.map((r) => r.column_name).join(", "));
  return null;
});
if (paper) {
  console.log("\n=== paper trades by family/status ===");
  console.table(paper.rows);
}

const shadow = await query<{
  family: string;
  n: number;
  wins: number;
  avg_r: number | null;
  net_r: number | null;
}>(
  `SELECT evaluation.strategy_family AS family,
          count(*)::int AS n,
          count(*) FILTER (WHERE shadow.result_r > 0)::int AS wins,
          avg(shadow.result_r)::float AS avg_r,
          sum(shadow.result_r)::float AS net_r
     FROM shadow_candidate_outcomes shadow
     JOIN paper_strategy_evaluations evaluation ON evaluation.id = shadow.evaluation_id
    WHERE shadow.result_r IS NOT NULL
      AND shadow.outcome IN ('target_first','stop_first','forced_close','timeout')
    GROUP BY 1
    ORDER BY 1`,
).catch((error: Error) => {
  console.log("shadow query failed:", error.message);
  return null;
});
if (shadow) {
  console.log("\n=== shadow outcomes by family ===");
  console.table(shadow.rows.map((r) => ({
    ...r,
    win_pct: r.n ? ((100 * r.wins) / r.n).toFixed(1) + "%" : "-",
  })));
}

process.exit(0);

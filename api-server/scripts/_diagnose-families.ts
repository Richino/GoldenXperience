/**
 * Diagnose live paper_strategy_trades: MFE/MAE, session, regime, stop geometry.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

const closed = await query<{
  strategy_family: string;
  n: number;
  wins: number;
  losses: number;
  avg_r: number;
  net_r: number;
  avg_mfe: number | null;
  avg_mae: number | null;
  avg_planned_r: number | null;
  avg_spread: number | null;
  avg_atr: number | null;
}>(
  `SELECT strategy_family,
          count(*)::int AS n,
          count(*) FILTER (WHERE result_r > 0)::int AS wins,
          count(*) FILTER (WHERE result_r < 0)::int AS losses,
          avg(result_r)::float AS avg_r,
          sum(result_r)::float AS net_r,
          avg(max_favorable_r)::float AS avg_mfe,
          avg(max_adverse_r)::float AS avg_mae,
          avg(planned_r)::float AS avg_planned_r,
          avg(spread_pips)::float AS avg_spread,
          avg(atr_pips)::float AS avg_atr
     FROM paper_strategy_trades
    WHERE status='closed' AND result_r IS NOT NULL AND strategy_family IS NOT NULL
    GROUP BY 1
    ORDER BY 1`,
);
console.log("=== closed by family ===");
console.table(closed.rows.map((r) => ({
  family: r.strategy_family,
  n: r.n,
  win_pct: ((100 * r.wins) / r.n).toFixed(0) + "%",
  avg_r: r.avg_r?.toFixed(3),
  net_r: r.net_r?.toFixed(1),
  avg_mfe: r.avg_mfe?.toFixed(2),
  avg_mae: r.avg_mae?.toFixed(2),
  planned_r: r.avg_planned_r?.toFixed(2),
  mfe_vs_mae: r.avg_mfe != null && r.avg_mae != null ? (r.avg_mfe - r.avg_mae).toFixed(2) : "-",
  edge_hint: r.avg_mfe != null && r.avg_mae != null
    ? (r.avg_mfe > r.avg_mae ? "paths favor" : "paths against")
    : "-",
})));

const byRegime = await query(
  `SELECT strategy_family, regime,
          count(*)::int AS n,
          avg(result_r)::float AS avg_r,
          sum(result_r)::float AS net_r,
          count(*) FILTER (WHERE result_r > 0)::int AS wins
     FROM paper_strategy_trades
    WHERE status='closed' AND result_r IS NOT NULL AND strategy_family IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 1, 2`,
);
console.log("\n=== by regime ===");
console.table(byRegime.rows);

const bySession = await query(
  `SELECT strategy_family, session,
          count(*)::int AS n,
          avg(result_r)::float AS avg_r,
          sum(result_r)::float AS net_r
     FROM paper_strategy_trades
    WHERE status='closed' AND result_r IS NOT NULL AND strategy_family IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 1, net_r`,
);
console.log("\n=== by session ===");
console.table(bySession.rows);

const shadowDetail = await query(
  `SELECT evaluation.strategy_family AS family,
          evaluation.regime,
          count(*)::int AS n,
          avg(shadow.result_r)::float AS avg_r,
          sum(shadow.result_r)::float AS net_r,
          avg(shadow.max_favorable_r)::float AS avg_mfe,
          avg(shadow.max_adverse_r)::float AS avg_mae,
          count(*) FILTER (WHERE shadow.result_r > 0)::int AS wins
     FROM shadow_candidate_outcomes shadow
     JOIN paper_strategy_evaluations evaluation ON evaluation.id = shadow.evaluation_id
    WHERE shadow.result_r IS NOT NULL
      AND shadow.outcome IN ('target_first','stop_first','forced_close','timeout')
    GROUP BY 1, 2
    ORDER BY 1, 2`,
);
console.log("\n=== shadow by family/regime ===");
console.table(shadowDetail.rows.map((r) => ({
  ...r,
  win_pct: r.n ? ((100 * Number(r.wins)) / Number(r.n)).toFixed(0) + "%" : "-",
  avg_r: Number(r.avg_r).toFixed(3),
  net_r: Number(r.net_r).toFixed(1),
  avg_mfe: r.avg_mfe == null ? "-" : Number(r.avg_mfe).toFixed(2),
  avg_mae: r.avg_mae == null ? "-" : Number(r.avg_mae).toFixed(2),
})));

process.exit(0);

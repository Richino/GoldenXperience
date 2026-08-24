/**
 * Mine stored research + live evidence for any pocket of positive expectancy:
 * per-pair, per-session, research candidates, liquidity version if present.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

function tone(n: number, avg: number, se: number) {
  if (n < 30) return "too few";
  const lo = avg - 1.96 * se; const hi = avg + 1.96 * se;
  return hi < 0 ? "LOSES" : lo > 0 ? "WINS" : "no edge";
}

const research = await query<{
  name: string; instrument: string; n: number; wins: number; avg_r: number; net_r: number; sd: number;
}>(`
  SELECT COALESCE(sv.name, 'unknown') AS name,
         se.instrument,
         count(*)::int AS n,
         count(*) FILTER (WHERE ol.result_r > 0)::int AS wins,
         avg(ol.result_r)::float AS avg_r,
         sum(ol.result_r)::float AS net_r,
         stddev_samp(ol.result_r)::float AS sd
    FROM outcome_labels ol
    JOIN trade_candidates tc ON tc.id = ol.candidate_id
    JOIN strategy_evaluations se ON se.id = tc.evaluation_id
    LEFT JOIN strategy_versions sv ON sv.id = se.strategy_version_id
   WHERE ol.result_r IS NOT NULL
     AND tc.execution_status = 'accepted'
   GROUP BY 1, 2
   HAVING count(*) >= 40
   ORDER BY avg(ol.result_r) DESC
   LIMIT 40
`).catch(async (e: Error) => {
  console.log("research query failed", e.message);
  return null;
});

if (research) {
  console.log("=== research accepted outcomes (top by avg R, n≥40) ===");
  console.table(research.rows.map((r) => ({
    ...r,
    win_pct: ((100 * r.wins) / r.n).toFixed(0) + "%",
    avg_r: r.avg_r.toFixed(3),
    net_r: r.net_r.toFixed(1),
    verdict: tone(r.n, r.avg_r, (r.sd || 0) / Math.sqrt(r.n)),
  })));
}

const experiments = await query(`
  SELECT re.label, re.status, count(rt.*)::int AS trades,
         avg(rt.result_r)::float AS avg_r,
         sum(rt.result_r)::float AS net_r
    FROM research_experiments re
    LEFT JOIN research_experiment_trades rt ON rt.experiment_id = re.id
   GROUP BY 1, 2
   ORDER BY avg(rt.result_r) DESC NULLS LAST
   LIMIT 30
`).catch((e: Error) => { console.log("experiments failed", e.message); return null; });
if (experiments) {
  console.log("\n=== research_experiments ===");
  console.table(experiments.rows);
}

const holdouts = await query(`
  SELECT rh.label, count(ht.*)::int AS trades,
         avg(ht.result_r)::float AS avg_r,
         sum(ht.result_r)::float AS net_r
    FROM research_holdouts rh
    LEFT JOIN research_holdout_trades ht ON ht.holdout_id = rh.id
   GROUP BY 1
   ORDER BY avg(ht.result_r) DESC NULLS LAST
   LIMIT 20
`).catch((e: Error) => { console.log("holdouts failed", e.message); return null; });
if (holdouts) {
  console.log("\n=== research_holdouts ===");
  console.table(holdouts.rows);
}

const candidates = await query(`
  SELECT rsc.name, count(t.*)::int AS trades,
         avg(t.result_r)::float AS avg_r,
         sum(t.result_r)::float AS net_r,
         count(*) FILTER (WHERE t.result_r > 0)::int AS wins
    FROM research_strategy_candidate_runs rsc
    LEFT JOIN research_strategy_candidate_trades t ON t.run_id = rsc.id
   GROUP BY 1
   ORDER BY avg(t.result_r) DESC NULLS LAST
   LIMIT 30
`).catch((e: Error) => { console.log("candidates failed", e.message); return null; });
if (candidates) {
  console.log("\n=== strategy candidate runs ===");
  console.table(candidates.rows);
}

const versions = await query(`SELECT name, version, created_at::text FROM strategy_versions ORDER BY created_at DESC LIMIT 30`);
console.log("\n=== strategy_versions ===");
console.table(versions.rows);

process.exit(0);

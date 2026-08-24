import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

const { query } = await import("../src/database.js");
const { evidenceIntegrityMetrics, integrityViolations } = await import("../src/evidence-integrity-checks.js");
const { loadAdaptiveEvidence, expectancy, grossExpectancy, DEFAULT_ADAPTIVE_CONFIG, contextKey, ANY } = await import("../src/adaptive-engine.js");

/**
 * Read-only verification of the adaptive evidence.
 *
 *     npm run research:verify-forex-adaptive-evidence
 *
 * Writes nothing. Prints the current integrity metrics, every invariant, the
 * net-versus-gross picture per family, and how far each context bucket is from
 * the thresholds the selector actually requires. Exits non-zero if any invariant
 * is violated, so it works as a check in a pipeline as well as a report.
 */

const log = (line = "") => console.log(line);
const section = (title: string) => { log(); log(`── ${title} ${"─".repeat(Math.max(0, 66 - title.length))}`); };
const pad = (label: string, width = 46) => label.padEnd(width, " ");

log("=".repeat(78));
log("FOREX ADAPTIVE EVIDENCE — VERIFICATION (read-only)");
log(`run at ${new Date().toISOString()}`);
log("=".repeat(78));

const metrics = await evidenceIntegrityMetrics();

section("EVIDENCE VOLUME");
log(`${pad("observations in the tables (no read guard)")} ${metrics.unguardedObservations}`);
log(`${pad("observations the loader counts")} ${metrics.adaptiveObservations}`);
log(`${pad("duplicate opportunities")} ${metrics.duplicateOpportunities} (tables: ${metrics.unguardedDuplicates})`);
log(`${pad("conflicting outcomes")} ${metrics.conflictingOutcomes} (tables: ${metrics.unguardedConflicts})`);
log(`${pad("closed trades")} ${metrics.closedTrades}`);
log(`${pad("live shadow outcomes")} ${metrics.liveShadowOutcomes}`);
log(`${pad("superseded shadow outcomes")} ${metrics.supersededShadowOutcomes}`);
log(`${pad("trades linked to their evaluation")} ${metrics.tradesLinkedToEvaluation} / ${metrics.trades}`);

section("NEWS CONTEXT");
log(`${pad("trades tagged")} ${metrics.newsTagged} / ${metrics.trades}`);
log(`${pad("evaluation state recorded")} ${metrics.newsEvaluationStateSet}`);
log(`${pad("INSUFFICIENT_CALENDAR_DATA")} ${metrics.newsInsufficientCalendarData}`);
log(`${pad("NO_NEWS without calendar coverage")} ${metrics.newsFalseNoNews}`);
log(`${pad("news_status still 'not_evaluated'")} ${metrics.newsNotEvaluatedStatus}`);
const tags = await query<{ tag: string | null; state: string | null; n: string }>(
  `SELECT news_impact_tag AS tag, news_evaluation_state AS state, count(*)::text AS n
     FROM paper_strategy_trades GROUP BY 1,2 ORDER BY 1 NULLS FIRST`);
for (const row of tags.rows) log(`${pad(`  ${row.tag ?? "(untagged)"} / ${row.state ?? "(no state)"}`)} ${row.n}`);

section("COST IN R");
log(`${pad("trades with spread_cost_r")} ${metrics.tradesWithSpreadCostR} / ${metrics.resolvedTrades}`);
log(`${pad("trades with net_result_r")} ${metrics.tradesWithNetResultR}`);
log(`${pad("trades with gross_result_r")} ${metrics.tradesWithGrossResultR}`);
log(`${pad("shadow outcomes with a cost decomposition")} ${metrics.shadowWithSpreadCostR}`);
log(`${pad("trades with cost_basis 'unknown'")} ${metrics.tradesWithUnknownCost}`);

const cost = await query<{ family: string | null; n: string; avg_cost: string; max_cost: string; net: string; gross: string }>(
  `SELECT COALESCE(strategy_family,'legacy') AS family, count(*)::text AS n,
          round(avg(spread_cost_r)::numeric,4)::text AS avg_cost,
          round(max(spread_cost_r)::numeric,4)::text AS max_cost,
          round(sum(net_result_r)::numeric,3)::text AS net,
          round(sum(gross_result_r)::numeric,3)::text AS gross
     FROM paper_strategy_trades WHERE spread_cost_r IS NOT NULL AND net_result_r IS NOT NULL
    GROUP BY 1 ORDER BY 1`);
log();
log(`${pad("family", 14)}${"n".padStart(6)}${"avg cost".padStart(11)}${"max cost".padStart(11)}${"gross R".padStart(11)}${"net R".padStart(11)}`);
for (const row of cost.rows) {
  log(`${pad(row.family ?? "-", 14)}${row.n.padStart(6)}${`${row.avg_cost}R`.padStart(11)}${`${row.max_cost}R`.padStart(11)}${row.gross.padStart(11)}${row.net.padStart(11)}`);
}

section("MOMENTUM ORIGINAL / INVERTED PAIRS");
log(`${pad("pairs recorded")} ${metrics.momentumPairs}`);
log(`${pad("pairs with both arms resolved")} ${metrics.momentumCompletePairs}`);
log(`${pad("pairs with one real execution")} ${metrics.momentumPairsWithExecution}`);
log(`${pad("pairs with >1 execution (must be 0)")} ${metrics.momentumPairsMultiExecuted}`);
const arms = await query<{ experiment_id: string; arm: string; n: string; resolved: string; executed: string; net: string | null }>(
  `SELECT experiment_id, arm, count(*)::text AS n,
          count(*) FILTER (WHERE status='resolved')::text AS resolved,
          count(*) FILTER (WHERE executed)::text AS executed,
          round(sum(net_result_r)::numeric,3)::text AS net
     FROM momentum_inversion_arms GROUP BY 1,2 ORDER BY 1,2`);
if (arms.rows.length) {
  log();
  log(`${pad("cohort", 38)}${"arm".padStart(10)}${"n".padStart(6)}${"resolved".padStart(10)}${"executed".padStart(10)}${"net R".padStart(10)}`);
  for (const row of arms.rows) {
    log(`${pad(row.experiment_id, 38)}${row.arm.padStart(10)}${row.n.padStart(6)}${row.resolved.padStart(10)}${row.executed.padStart(10)}${(row.net ?? "-").padStart(10)}`);
  }
  log();
  log("Both arms of a pair share one opportunity, one bar and one spread; only");
  log("direction differs. At most one is a real execution — the other is a");
  log("deterministic counterfactual. Neither feeds the adaptive engine.");
}

section("ADAPTIVE READINESS (thresholds NOT lowered)");
log(`minLearningSample ${DEFAULT_ADAPTIVE_CONFIG.minLearningSample}   minActiveSample ${DEFAULT_ADAPTIVE_CONFIG.minActiveSample}   confidenceZ ${DEFAULT_ADAPTIVE_CONFIG.confidenceZ}`);
const experiment = await query<{ id: string; label: string }>(
  "SELECT id, label FROM strategy_experiments ORDER BY created_at LIMIT 1");
if (experiment.rows[0]) {
  const evidence = await loadAdaptiveEvidence(experiment.rows[0].id);
  log(`experiment: ${experiment.rows[0].label}`);
  log(`${pad("total resolved observations")} ${evidence.totalResolved}`);
  log();
  log(`${pad("family bucket", 16)}${"resolved".padStart(10)}${"net E[R]".padStart(11)}${"gross E[R]".padStart(12)}   state`);
  for (const family of ["ema", "breakout", "momentum", "meanrev"]) {
    const stat = evidence.context.get(contextKey(family, ANY, ANY, ANY, ANY));
    if (!stat) { log(`${pad(family, 16)}${"0".padStart(10)}${"-".padStart(11)}${"-".padStart(12)}   collecting`); continue; }
    const state = stat.resolved >= DEFAULT_ADAPTIVE_CONFIG.minActiveSample ? "active_selection"
      : stat.resolved >= DEFAULT_ADAPTIVE_CONFIG.minLearningSample ? "learning" : "collecting";
    log(`${pad(family, 16)}${String(stat.resolved).padStart(10)}${(expectancy(stat)?.toFixed(4) ?? "-").padStart(11)}${(grossExpectancy(stat)?.toFixed(4) ?? "-").padStart(12)}   ${state}`);
  }
  const deepest = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM paper_strategy_trades
      WHERE strategy_family IS NOT NULL AND status='closed'
      GROUP BY strategy_family, instrument, session, regime, COALESCE(original_direction, direction)
      ORDER BY count(*) DESC LIMIT 1`);
  log();
  log(`deepest EXACT context bucket: ${deepest.rows[0]?.n ?? 0} observations (needs ${DEFAULT_ADAPTIVE_CONFIG.minActiveSample})`);
}

section("INVARIANTS");
const violations = await integrityViolations();
if (violations.length === 0) log("   ✓ every evidence invariant holds");
for (const v of violations) log(`   ✗ ${v.invariant} (${v.count}) — ${v.detail}`);

log();
log("=".repeat(78));
log(violations.length === 0 ? "EVIDENCE PIPELINE TRUSTWORTHY" : "EVIDENCE PIPELINE STILL COMPROMISED");
log("=".repeat(78));
process.exit(violations.length === 0 ? 0 : 1);

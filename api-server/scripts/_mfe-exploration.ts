/**
 * Reads the MFE/MAE already recorded on labelled candidates to size the
 * opportunity for stop management, before any trailing logic is written.
 *
 * This measures the ceiling, not a trailing result: max_favorable_r is the peak
 * excursion, and says nothing about the path taken to reach it. A trade that
 * ran to 1.2R, gave it all back, then reached 2.5R carries the same MFE as one
 * that went straight there, and a trail would exit those two very differently.
 * Treat every number here as an upper bound on what stop management could
 * recover.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

const { query } = await import("../src/database.js");

const ACCEPTED_ONLY = process.env.ACCEPTED_ONLY !== "0";
/**
 * The labelled history holds two exit rules under one strategy version: the
 * live fixed 1.5R target, and the legacy structural target reached through
 * `minimumRiskReward`, which plans a variable R averaging 2.0. Their outcome
 * distributions differ enough that pooling them describes a system nobody
 * trades, so this defaults to the live rule. TARGET_RULE=structural or =all.
 */
const TARGET_RULE = process.env.TARGET_RULE ?? "fixed";
/** Instruments are replayed independently, so a pair rebuilt under a newer
 *  entry window must not be pooled with pairs still holding older labels. */
const PAIRS = (process.env.PAIRS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const ruleFilter = TARGET_RULE === "all" ? ""
  : TARGET_RULE === "structural" ? "abs(evaluation.risk_reward - 1.5) >= 0.001"
    : "abs(evaluation.risk_reward - 1.5) < 0.001";

const rows = (await query<{
  instrument: string; direction: string; decision_time: string; session: string | null;
  execution_status: string; outcome: string; result_r: number | null; mfe: number | null; mae: number | null;
}>(`
  SELECT evaluation.instrument, evaluation.direction, evaluation.decision_time::text AS decision_time,
         (SELECT item->>'currentValue' FROM jsonb_array_elements(evaluation.conditions) item WHERE item->>'name' = 'Session') AS session,
         candidate.execution_status,
         label.outcome,
         label.result_r::float AS result_r,
         label.max_favorable_r::float AS mfe,
         label.max_adverse_r::float AS mae
  FROM trade_candidates candidate
  JOIN strategy_evaluations evaluation ON evaluation.id = candidate.evaluation_id
  JOIN outcome_labels label ON label.candidate_id = candidate.id
  ${(() => {
    const clauses = [ACCEPTED_ONLY ? "candidate.execution_status = 'accepted'" : "", ruleFilter, PAIRS.length ? "evaluation.instrument = ANY($1)" : ""].filter(Boolean);
    return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  })()}
  ORDER BY evaluation.decision_time
`, PAIRS.length ? [PAIRS] : [])).rows;

if (!rows.length) {
  console.log("No labelled candidates matched.");
  process.exit(0);
}

const pct = (part: number, whole: number) => (whole === 0 ? "—" : `${((part / whole) * 100).toFixed(1)}%`);
const avg = (values: number[]) => (values.length ? values.reduce((total, value) => total + value, 0) / values.length : null);
const show = (value: number | null, digits = 2) => (value === null ? "—" : value.toFixed(digits));
const withMfe = rows.filter((row) => row.mfe !== null);

console.log(`\nSample: ${rows.length} labelled candidates · target rule: ${TARGET_RULE}${ACCEPTED_ONLY ? " · position-aware accepted only (ACCEPTED_ONLY=0 for all)" : " · all, including overlapping"}`);
console.log(`Range: ${rows[0]!.decision_time.slice(0, 10)} to ${rows.at(-1)!.decision_time.slice(0, 10)}`);

console.log("\n== Outcome mix ==");
const outcomes = [...new Set(rows.map((row) => row.outcome))].sort();
console.table(outcomes.map((outcome) => {
  const group = rows.filter((row) => row.outcome === outcome);
  const resolved = group.map((row) => row.result_r).filter((value): value is number => value !== null);
  return {
    outcome,
    trades: group.length,
    share: pct(group.length, rows.length),
    "avg R": show(avg(resolved)),
    "avg MFE": show(avg(group.map((row) => row.mfe).filter((value): value is number => value !== null))),
    "avg MAE": show(avg(group.map((row) => row.mae).filter((value): value is number => value !== null))),
  };
}));

// A breakeven or trailing stop can only act on a trade that first moved far
// enough in favour. These are the losers that offered that chance.
console.log("\n== Losers that first reached a given profit (breakeven-stop ceiling) ==");
const losers = withMfe.filter((row) => row.outcome === "stop_first");
console.table([0.5, 0.75, 1, 1.25, 1.5].map((threshold) => {
  const reached = losers.filter((row) => row.mfe! >= threshold);
  return {
    "reached before stopping out": `${threshold}R`,
    trades: reached.length,
    "share of losers": pct(reached.length, losers.length),
    "share of sample": pct(reached.length, rows.length),
    "R saved if scratched": show(reached.length * 1),
  };
}));

// Winners cannot answer the let-it-run question from this data. labelOutcome
// returns as soon as the target trades, so a winner's MFE is the peak up to
// that bar and never below the target — the excess is overshoot inside the
// single M15 bar that filled it, not continuation afterwards. Measuring
// whether a trail beats the fixed target needs a replay past the exit.
console.log("\n== Winners: intrabar overshoot only, NOT room a trail could have captured ==");
const winners = withMfe.filter((row) => row.outcome === "target_first");
console.log(`${winners.length} winners · avg MFE ${show(avg(winners.map((row) => row.mfe!)))} · min ${show(Math.min(...winners.map((row) => row.mfe!)))}`);
console.log("Post-target continuation is not recorded. Treat this as unmeasured, not as zero.");

// Forced closes are the population a trail most plausibly improves: the trade
// was still open at 16:45 ET and got marked to whatever the market offered.
console.log("\n== Forced session closes ==");
const forced = rows.filter((row) => row.outcome === "forced_close");
const forcedResolved = forced.map((row) => row.result_r).filter((value): value is number => value !== null);
console.log(`${forced.length} trades (${pct(forced.length, rows.length)} of sample) · avg ${show(avg(forcedResolved))}R · positive ${forced.filter((row) => (row.result_r ?? 0) > 0).length} · negative ${forced.filter((row) => (row.result_r ?? 0) < 0).length}`);
console.table([0.5, 1, 1.5].map((threshold) => {
  const reached = forced.filter((row) => row.mfe !== null && row.mfe >= threshold);
  const gaveBack = reached.filter((row) => (row.result_r ?? 0) < threshold);
  return {
    "peaked at": `${threshold}R`,
    trades: reached.length,
    "closed below that peak": gaveBack.length,
    "R given back": show(gaveBack.reduce((total, row) => total + (threshold - (row.result_r ?? 0)), 0)),
  };
}));

console.log("\n== By session ==");
const sessions = [...new Set(rows.map((row) => row.session ?? "Unknown"))].sort();
console.table(sessions.map((session) => {
  const group = rows.filter((row) => (row.session ?? "Unknown") === session);
  const resolved = group.map((row) => row.result_r).filter((value): value is number => value !== null);
  return {
    session,
    trades: group.length,
    "avg R": show(avg(resolved)),
    "avg MFE": show(avg(group.map((row) => row.mfe).filter((value): value is number => value !== null))),
    "stopped after +1R": group.filter((row) => row.outcome === "stop_first" && (row.mfe ?? 0) >= 1).length,
    "forced closes": group.filter((row) => row.outcome === "forced_close").length,
  };
}));

process.exit(0);

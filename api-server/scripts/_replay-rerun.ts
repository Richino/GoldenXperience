/**
 * Re-runs the historical replay over candles already stored in Postgres,
 * skipping the OANDA collection phase.
 *
 * DESTRUCTIVE: prepare_replay deletes every historical strategy_evaluation for
 * the instrument and rebuilds it, which cascades to trade_candidates and
 * outcome_labels. The previous labelling is not recoverable.
 *
 * It seeds a durable job at the prepare_replay phase and then drives
 * processNextResearchJob, so every phase runs the same code the server worker
 * runs. Nothing about the strategy or the labelling is reimplemented here —
 * this only chooses the entry point.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

const { query } = await import("../src/database.js");
const { processNextResearchJob } = await import("../src/research.js");

const MONTHS = Number(process.env.MONTHS ?? 60);
const WARMUP_DAYS = 60;
const instruments = (process.env.PAIRS ?? "EUR_USD,GBP_USD,USD_JPY").split(",").map((value) => value.trim()).filter(Boolean);

if (![12, 36, 60].includes(MONTHS)) throw new Error("MONTHS must be 12, 36 or 60 to satisfy the durable job constraint.");

for (const instrument of instruments) {
  const stored = await query<{ bars: string; from_d: string; to_d: string }>(
    "SELECT count(*)::text AS bars, min(close_time)::date::text AS from_d, max(close_time)::date::text AS to_d FROM market_candles WHERE instrument=$1 AND timeframe='M15' AND source='oanda'",
    [instrument],
  );
  const row = stored.rows[0]!;
  if (Number(row.bars) === 0) throw new Error(`${instrument} has no stored M15 candles. Run the normal backfill so the collection phase fetches them.`);
  console.log(`${instrument}: ${row.bars} stored M15 bars, ${row.from_d} to ${row.to_d}`);
}

const rangeEnd = new Date();
const rangeStart = new Date(rangeEnd); rangeStart.setMonth(rangeStart.getMonth() - MONTHS);
const dataStart = new Date(rangeStart.getTime() - WARMUP_DAYS * 24 * 60 * 60_000);

for (const instrument of instruments) {
  await query("DELETE FROM durable_research_jobs WHERE instrument=$1 AND status IN ('queued','running')", [instrument]);
  const run = await query<{ id: string }>(
    "INSERT INTO research_runs(kind,details) VALUES('historical_backfill',$1::jsonb) RETURNING id",
    [JSON.stringify({ state: "running", durable: true, phase: "Replaying from stored candles", instrument, months: MONTHS, fetched: {}, timeframeProgress: { M15: 100, H1: 100, H4: 100 }, progressPercent: 50, note: "Replay-only re-run over stored candles. News is not evaluated." })],
  );
  const checkpoint = {
    rangeStart: rangeStart.toISOString(),
    dataStart: dataStart.toISOString(),
    rangeEnd: rangeEnd.toISOString(),
    // Past the last timeframe, so the collection phase is never entered.
    timeframeIndex: 3,
    cursor: rangeEnd.toISOString(),
    fetched: {},
    timeframeProgress: { M15: 100, H1: 100, H4: 100 },
  };
  await query(
    "INSERT INTO durable_research_jobs(run_id,instrument,months,phase,checkpoint) VALUES($1,$2,$3,'prepare_replay',$4::jsonb)",
    [run.rows[0]!.id, instrument, MONTHS, JSON.stringify(checkpoint)],
  );
  console.log(`queued replay-only job for ${instrument}`);
}

let units = 0;
let lastPhase = "";
const startedAt = Date.now();
for (;;) {
  const result = await processNextResearchJob();
  if (!result.processed) {
    if (result.error) throw result.error;
    // Each checkpoint sets available_at 750ms ahead, and a claimed job holds a
    // lease, so "nothing to process" usually means "not yet" rather than
    // "finished". Only an empty queue ends the run. A live api-server drains
    // the same queue, so this waits on its progress rather than competing.
    const pending = await query<{ count: string }>("SELECT count(*)::text FROM durable_research_jobs WHERE status IN ('queued','running')");
    if (Number(pending.rows[0]!.count) === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    continue;
  }
  units += 1;
  if (result.phase !== lastPhase) {
    lastPhase = result.phase ?? "";
    console.log(`[${Math.round((Date.now() - startedAt) / 1000)}s] phase: ${lastPhase}`);
  }
  if (units % 50 === 0) console.log(`[${Math.round((Date.now() - startedAt) / 1000)}s] ${units} units, phase ${lastPhase}`);
}

console.log(`\nDone in ${Math.round((Date.now() - startedAt) / 1000)}s over ${units} units.`);
const summary = await query(`
  SELECT e.instrument, count(*)::int AS candidates,
         count(*) FILTER (WHERE c.execution_status='accepted')::int AS accepted,
         count(l.candidate_id)::int AS labelled
  FROM trade_candidates c
  JOIN strategy_evaluations e ON e.id=c.evaluation_id
  LEFT JOIN outcome_labels l ON l.candidate_id=c.id
  WHERE e.source_kind='historical' GROUP BY 1 ORDER BY 1`);
console.table(summary.rows);
process.exit(0);

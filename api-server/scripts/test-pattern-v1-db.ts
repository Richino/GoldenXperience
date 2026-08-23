import assert from "node:assert/strict";
import { databaseConfigured, query } from "../src/database.js";
import { binaryJournal, binaryPerformance, BINARY_BASELINE_MODEL, BINARY_PATTERN_V1_MODEL } from "../src/binary-engine.js";
import { patternV1Status, patternV1Disagreement } from "../src/pattern-v1-engine.js";
import { PATTERN_V1_CONFIG_HASH, PATTERN_V1_STRATEGY_ID } from "../src/pattern-v1.js";

/**
 * Pattern V1 database-integration checks. READ-ONLY: every statement is a
 * SELECT, so this is safe to run against production.
 *
 * Covers the separation requirements that cannot be proved from pure logic:
 * the journal returns Pattern V1, the strategy filter works, and neither
 * strategy's statistics can absorb the other's rows.
 *
 * Requires migration 035. Skips cleanly without a database.
 */
if (!databaseConfigured()) {
  console.log("SKIPPED: no DATABASE_URL — set one to run the integration checks.");
  process.exit(0);
}

const migrated = await query<{ column_name: string }>(
  `SELECT column_name FROM information_schema.columns
   WHERE table_name='binary_predictions' AND column_name='signal_candle_time'`,
);
if (!migrated.rowCount) {
  console.log("SKIPPED: migration 035 has not been applied to this database yet.");
  console.log("  Pattern V1 columns are absent, so the journal query cannot run.");
  process.exit(0);
}

const owner = await query<{ id: string }>("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1");
const userId = owner.rows[0]?.id;
assert.ok(userId, "an owner account is required");

console.log("PATTERN V1 DATABASE INTEGRATION (read-only)\n");

// ---------------------------------------------------------------- model row
{
  const model = await query<{ configuration: { configHash?: string } }>(
    "SELECT configuration FROM binary_models WHERE name=$1", [PATTERN_V1_STRATEGY_ID]);
  assert.equal(model.rowCount, 1, "the Pattern V1 model must be registered");
  assert.equal(model.rows[0]!.configuration.configHash, PATTERN_V1_CONFIG_HASH,
    "the registered configuration must carry the frozen holdout hash");
  console.log("model registered with the frozen config hash: OK");
}

// ---------------------------------------------------------------- 20/21. journal + filter
{
  const all = await binaryJournal(userId, { limit: 50, strategy: "all" });
  const baseline = await binaryJournal(userId, { limit: 50, strategy: "baseline" });
  const pattern = await binaryJournal(userId, { limit: 50, strategy: "pattern-v1" });

  assert.ok(baseline.every((row) => row.modelName === BINARY_BASELINE_MODEL),
    "the baseline filter must return only baseline rows");
  assert.ok(pattern.every((row) => row.modelName === BINARY_PATTERN_V1_MODEL),
    "the Pattern V1 filter must return only Pattern V1 rows");
  assert.ok(all.every((row) => row.modelName === BINARY_BASELINE_MODEL || row.modelName === BINARY_PATTERN_V1_MODEL),
    "the 'all' filter must never include the logistic shadow");
  assert.ok(pattern.every((row) => row.strategySource === "pattern-v1-forward"),
    "every Pattern V1 row carries its experiment source");
  assert.ok(pattern.every((row) => row.direction === "up"), "Pattern V1 is UP only");
  assert.ok(pattern.every((row) => row.durationSeconds === 600), "Pattern V1 is a 10-minute horizon");
  console.log(`journal filter: all=${all.length}, baseline=${baseline.length}, pattern-v1=${pattern.length} — scoping correct: OK`);
}

// ---------------------------------------------------------------- 22/23. statistics separation
{
  const stats = await binaryPerformance(userId);
  const baselineRows = await query<{ n: string }>(
    "SELECT count(*)::text AS n FROM binary_predictions WHERE user_id=$1 AND is_authoritative=true AND model_name=$2",
    [userId, BINARY_BASELINE_MODEL]);
  assert.equal(stats.summary.total, Number(baselineRows.rows[0]!.n),
    "baseline statistics must count baseline rows and nothing else");

  const patternCount = await query<{ n: string }>(
    "SELECT count(*)::text AS n FROM binary_predictions WHERE user_id=$1 AND model_name=$2",
    [userId, BINARY_PATTERN_V1_MODEL]);
  const status = await patternV1Status(userId);
  assert.equal(status.total, Number(patternCount.rows[0]!.n),
    "Pattern V1 status must count Pattern V1 rows and nothing else");

  // The decisive check: the two totals must not overlap.
  const overlap = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM binary_predictions
     WHERE model_name=$1 AND is_authoritative=true`, [BINARY_PATTERN_V1_MODEL]);
  assert.equal(Number(overlap.rows[0]!.n), 0,
    "no Pattern V1 row may be marked authoritative — that is what keeps it out of baseline stats");
  console.log(`baseline total=${stats.summary.total}, pattern total=${status.total}, overlap=0: OK`);
}

// ---------------------------------------------------------------- status shape
{
  const status = await patternV1Status(userId);
  assert.equal(status.strategy, PATTERN_V1_STRATEGY_ID);
  assert.equal(status.configHash, PATTERN_V1_CONFIG_HASH);
  assert.equal(status.total, status.pending + status.resolved,
    "every prediction is either pending or resolved");
  assert.equal(status.resolved, status.wins + status.losses + status.ties,
    "resolved splits exactly into wins, losses and ties");
  if (status.wins + status.losses === 0) {
    assert.equal(status.winRate, null, "no decided predictions -> no win rate, not 0%");
    assert.equal(status.ev80, null);
  }
  console.log(`status: total=${status.total} pending=${status.pending} resolved=${status.resolved} `
    + `W/L/T=${status.wins}/${status.losses}/${status.ties} next=${status.nextCheckpoint}: OK`);
}

// ---------------------------------------------------------------- dedup constraint
{
  const index = await query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE indexname='binary_predictions_signal_candle_idx'`);
  assert.equal(index.rowCount, 1, "the signal-candle dedup index must exist");
  assert.match(index.rows[0]!.indexdef, /UNIQUE/, "it must be UNIQUE, not merely an index");
  assert.match(index.rows[0]!.indexdef, /model_name/, "scoped per model");
  assert.match(index.rows[0]!.indexdef, /signal_candle_time/);

  const dupes = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM (
       SELECT model_name, instrument, signal_candle_time, duration_seconds
       FROM binary_predictions WHERE signal_candle_time IS NOT NULL
       GROUP BY 1,2,3,4 HAVING count(*) > 1) d`);
  assert.equal(Number(dupes.rows[0]!.n), 0, "no duplicate signal-candle predictions exist");
  console.log("dedup: unique index present and no duplicates on record: OK");
}

// ---------------------------------------------------------------- coexistence
{
  const disagreement = await patternV1Disagreement(userId);
  console.log("baseline vs Pattern V1 overlap:", JSON.stringify(disagreement));
  const coexist = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM binary_predictions a
     JOIN binary_predictions b
       ON a.instrument=b.instrument
      AND date_trunc('minute', a.start_at)=date_trunc('minute', b.start_at)
      AND a.model_name='binary-baseline-v1' AND b.model_name='binary-pattern-v1'`);
  console.log(`same symbol+minute in both strategies: ${coexist.rows[0]!.n} (both are kept, neither suppresses the other)`);
}

console.log("\nAll Pattern V1 database-integration checks passed.");
process.exit(0);

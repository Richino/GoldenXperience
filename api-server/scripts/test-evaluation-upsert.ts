import assert from "node:assert/strict";
import { Client } from "pg";
import { EXECUTION_STATUS_CONFLICT_RULE } from "../src/paper-cycle.js";

/**
 * Regression cover for the two attribution bugs that made every executed
 * multi-strategy trade unreadable in the research data:
 *
 *   1. openPaperTrade stamps trade_created/paper_trade_id/rejection_reason onto
 *      the evaluation row by UPDATE. The multi-strategy cycle used to open the
 *      trade BEFORE inserting that row, so those updates matched zero rows and
 *      were lost without an error. 50 executed trades, 4 flagged.
 *   2. Later ticks inside the same M15 bar rewrite the same decision_time row.
 *      Once the trade is open the instrument reads as busy, so the candidate
 *      re-evaluates as 'blocked' and used to overwrite the 'selected' written
 *      moments earlier. 0 rows said 'selected' while 50 trades existed.
 *
 * Both are orderings and SQL semantics rather than pure functions, so this
 * exercises real Postgres. Everything happens in a TEMP table inside one
 * transaction (ON COMMIT DROP): no production table is read or written.
 *
 * The conflict rule is imported from the module under test, so this cannot
 * silently drift from the statement the collector actually runs.
 */

const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL (or DATABASE_PUBLIC_URL) is required; this check exercises real Postgres semantics.");
  process.exit(1);
}

const TABLE = "tmp_paper_strategy_evaluations";
// The rule names its own table for the "value already stored" side of the CASE,
// which on a temp copy has to point at the temp copy.
const conflictRule = EXECUTION_STATUS_CONFLICT_RULE.replaceAll("paper_strategy_evaluations", TABLE);

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

const DECISION = "2026-08-21T14:00:00Z";
const INSTRUMENT = "EUR_USD";

/** The collector writing one candidate's evaluation for this bar. */
const persistEvaluation = (versionId: string, executionStatus: string, rejectionReason: string | null = null) => client.query(
  `INSERT INTO ${TABLE}(strategy_version_id,instrument,decision_time,setup_status,rejection_reason,trade_created,execution_status)
   VALUES($1,$2,$3,'valid',$4,false,$5)
   ON CONFLICT(strategy_version_id,instrument,decision_time) DO UPDATE SET
     setup_status=EXCLUDED.setup_status,rejection_reason=EXCLUDED.rejection_reason,${conflictRule},updated_at=now()`,
  [versionId, INSTRUMENT, DECISION, rejectionReason, executionStatus]);

/** openPaperTrade's success path. */
const markTraded = (versionId: string, tradeId: string) => client.query(
  `UPDATE ${TABLE} SET trade_created=true,paper_trade_id=$1,execution_status='selected',rejection_reason=NULL,updated_at=now()
    WHERE strategy_version_id=$2 AND instrument=$3 AND decision_time=$4`, [tradeId, versionId, INSTRUMENT, DECISION]);

/** openPaperTrade's reject() path. */
const markRejected = (versionId: string, reason: string) => client.query(
  `UPDATE ${TABLE} SET rejection_reason=$1,updated_at=now()
    WHERE strategy_version_id=$2 AND instrument=$3 AND decision_time=$4 AND trade_created=false`, [reason, versionId, INSTRUMENT, DECISION]);

const rowFor = async (versionId: string) =>
  (await client.query(`SELECT * FROM ${TABLE} WHERE strategy_version_id=$1`, [versionId])).rows[0];

try {
  await client.query("BEGIN");
  await client.query(`CREATE TEMP TABLE ${TABLE}(
    strategy_version_id text, instrument text, decision_time timestamptz,
    setup_status text, execution_status text,
    trade_created boolean NOT NULL DEFAULT false,
    paper_trade_id text, rejection_reason text, updated_at timestamptz DEFAULT now(),
    UNIQUE(strategy_version_id, instrument, decision_time)) ON COMMIT DROP`);

  // A candidate that executes, then the rest of the bar's ticks re-evaluating it.
  await persistEvaluation("ema-version", "blocked");
  const promoted = await markTraded("ema-version", "trade-123");
  assert.equal(promoted.rowCount, 1, "the evaluation row must exist before openPaperTrade updates it");
  for (let tick = 0; tick < 14; tick += 1) await persistEvaluation("ema-version", "blocked");
  const executed = await rowFor("ema-version");
  assert.equal(executed.execution_status, "selected", "a later tick in the same bar must not overwrite 'selected'");
  assert.equal(executed.trade_created, true, "trade_created must survive later ticks");
  assert.equal(executed.paper_trade_id, "trade-123", "the trade id must survive later ticks");

  // A candidate the engine chose but the risk gates turned away.
  await persistEvaluation("momentum-version", "blocked");
  const rejected = await markRejected("momentum-version", "Risk blocked: the daily trade limit was reached.");
  assert.equal(rejected.rowCount, 1, "reject() must find the row so its reason is recorded");
  await persistEvaluation("momentum-version", "blocked");
  const blocked = await rowFor("momentum-version");
  assert.equal(blocked.execution_status, "blocked", "a selection that never traded must not be frozen as 'selected'");
  assert.equal(blocked.trade_created, false, "no trade means trade_created stays false");

  // Blocked earlier in the bar, then unblocked and executed: upgrades still apply.
  await persistEvaluation("breakout-version", "blocked");
  await markTraded("breakout-version", "trade-456");
  assert.equal((await rowFor("breakout-version")).execution_status, "selected", "an upgrade to 'selected' is still allowed");

  // An unsettled row may still be restated by a later tick.
  await persistEvaluation("meanrev-version", "suppressed");
  await persistEvaluation("meanrev-version", "blocked");
  assert.equal((await rowFor("meanrev-version")).execution_status, "blocked", "a row that never executed stays restatable");

  // Each family carries its own strategy_version_id, so one family's execution
  // must never flag another's row for the same instrument and decision_time.
  const flagged = await client.query(`SELECT count(*)::int AS n FROM ${TABLE} WHERE trade_created`);
  assert.equal(flagged.rows[0].n, 2, "only the candidates that actually traded are flagged");

  await client.query("COMMIT");
  console.log("Evaluation upsert checks passed.");
} catch (error) {
  await client.query("ROLLBACK");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

const { query } = await import("../src/database.js");
const { evidenceIntegrityMetrics, integrityViolations } = await import("../src/evidence-integrity-checks.js");
const { backfillNewsTags, calendarCoverage } = await import("../src/news-tagging.js");
const { spreadCostR, buildMomentumArms, momentumPairKey } = await import("../src/evidence-integrity.js");
const { resolveMomentumInversionArms } = await import("../src/momentum-arms.js");
const { newsStatusFromConditions } = await import("../../frontend/src/lib/strategy/strategy-common.js");
const { getResearchCandles } = await import("../../frontend/src/lib/oanda/client.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

/**
 * Forex adaptive evidence repair.
 *
 *     npm run research:repair-forex-adaptive-evidence
 *     npm run research:repair-forex-adaptive-evidence -- --dry-run
 *     npm run research:repair-forex-adaptive-evidence -- --skip-momentum-backfill
 *
 * IDEMPOTENT BY CONSTRUCTION. Every phase is either an UPDATE guarded by "is it
 * already right?" or an INSERT with ON CONFLICT DO NOTHING against a natural
 * key. A second run reports zero rows repaired and changes nothing. That is
 * checked by a test, not just asserted here.
 *
 * NOTHING IS GUESSED. The executed-link repair matches on
 * (strategy_version_id, instrument, decision_time), which carries a UNIQUE
 * constraint on BOTH paper_strategy_trades and paper_strategy_evaluations — so
 * the association is a proven 1:1, not a heuristic. Anything that cannot be
 * matched that way is counted, reported, and left exactly as it is.
 *
 * NOTHING IS FABRICATED. Costs the broker never reported stay NULL rather than
 * becoming zero. A news verdict that was never computed stays NOT_EVALUATED
 * rather than becoming NO_NEWS. Missing calendar coverage becomes
 * INSUFFICIENT_CALENDAR_DATA, never confirmed quiet.
 *
 * THIS DOES NOT ENABLE ADAPTATION. No threshold, confidence bound or sample
 * requirement is touched anywhere in this command.
 */

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const SKIP_MOMENTUM_BACKFILL = argv.includes("--skip-momentum-backfill");

/**
 * The cohort historical Momentum pairs are filed under.
 *
 * NOT `momentum-inversion-v1`. That experiment activated on 2026-08-23 and the
 * last Momentum trade opened on 2026-08-21, so every historical trade predates
 * it. Back-filling them into the forward cohort would let the sample that
 * generated the inversion hypothesis also appear to confirm it — the exact
 * contamination `momentum_short_inversion_pairs` was built to avoid. They get
 * their own clearly-named cohort instead: available for research, structurally
 * incapable of being pooled with the forward test.
 */
const BACKFILL_COHORT = "momentum-inversion-backfill-v1";

const log = (line = "") => console.log(line);
const section = (title: string) => { log(); log(`── ${title} ${"─".repeat(Math.max(0, 66 - title.length))}`); };
const pad = (label: string, width = 46) => label.padEnd(width, " ");

interface PhaseResult {
  name: string;
  repaired: number;
  unchanged: number;
  ambiguous: number;
  notes: string[];
}

const phases: PhaseResult[] = [];
const phase = (name: string): PhaseResult => {
  const result: PhaseResult = { name, repaired: 0, unchanged: 0, ambiguous: 0, notes: [] };
  phases.push(result);
  return result;
};

/** Runs a mutation unless --dry-run, and always returns the affected count. */
async function mutate(sql: string, params: unknown[] = []): Promise<number> {
  if (DRY_RUN) {
    // Count what WOULD change without changing it. Only safe for the
    // count-shaped probes below, which each phase supplies explicitly.
    return 0;
  }
  const result = await query(sql, params);
  return result.rowCount ?? 0;
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const result = await query<{ count: string }>(sql, params);
  return Number(result.rows[0]?.count ?? 0);
}

// ===========================================================================

log("=".repeat(78));
log("FOREX ADAPTIVE EVIDENCE — DATA INTEGRITY REPAIR");
log(`run at ${new Date().toISOString()}${DRY_RUN ? "   [DRY RUN — nothing is written]" : ""}`);
log("=".repeat(78));

const before = await evidenceIntegrityMetrics();
const violationsBefore = await integrityViolations();

// ---------------------------------------------------------------------------
// PHASE 1 — executed trades filed as blocked shadow candidates
// ---------------------------------------------------------------------------
section("PHASE 1  executed / shadow conflicts");
{
  const p = phase("executed-shadow conflict");

  // 1a. Attach the canonical evaluation link.
  //
  // The match is on (strategy_version_id, instrument, decision_time). Both
  // tables carry a UNIQUE constraint on exactly that triple, so at most one row
  // on each side can satisfy it: the association is proven, not inferred.
  const linkable = await count(
    `SELECT count(*)::text AS count FROM paper_strategy_trades t
      WHERE t.evaluation_id IS NULL
        AND EXISTS (SELECT 1 FROM paper_strategy_evaluations e
                     WHERE e.strategy_version_id = t.strategy_version_id
                       AND e.instrument = t.instrument AND e.decision_time = t.decision_time)`);
  const linked = await mutate(
    `UPDATE paper_strategy_trades t
        SET evaluation_id = e.id, updated_at = now()
       FROM paper_strategy_evaluations e
      WHERE t.evaluation_id IS NULL
        AND e.strategy_version_id = t.strategy_version_id
        AND e.instrument = t.instrument
        AND e.decision_time = t.decision_time`);
  p.repaired += DRY_RUN ? linkable : linked;
  log(`${pad("trades linked to their evaluation row")} ${DRY_RUN ? linkable : linked}`);

  // 1b. Trades for which NO evaluation row exists on the natural key. Expected
  // for the pre-evaluations legacy strategy. Probed by the key rather than by
  // `evaluation_id IS NULL` so the number means the same thing in a dry run as
  // in a real one.
  const noEvaluationSql = `FROM paper_strategy_trades t
     WHERE NOT EXISTS (SELECT 1 FROM paper_strategy_evaluations e
                        WHERE e.strategy_version_id = t.strategy_version_id
                          AND e.instrument = t.instrument AND e.decision_time = t.decision_time)`;
  const orphans = await count(`SELECT count(*)::text AS count ${noEvaluationSql}`);
  p.ambiguous += orphans;
  if (orphans) {
    const legacy = await count(`SELECT count(*)::text AS count ${noEvaluationSql} AND t.strategy_family IS NULL`);
    p.notes.push(`${orphans} trades have no matching evaluation row (${legacy} legacy, ${orphans - legacy} multi-strategy) — left untouched, no association could be proven`);
    log(`${pad("trades with NO evaluation row (left alone)")} ${orphans}`);
  }

  // 1c. Stamp the evaluation side from the proven link. execution_status is only
  // set where the column has meaning — the multi-strategy pipeline. Legacy rows
  // predate it and keep their NULL rather than being retro-labelled.
  const stampable = await count(
    `SELECT count(*)::text AS count FROM paper_strategy_evaluations e
      JOIN paper_strategy_trades t ON t.evaluation_id = e.id
     WHERE e.paper_trade_id IS DISTINCT FROM t.id
        OR e.trade_created = false
        OR (e.strategy_family IS NOT NULL AND e.execution_status IS DISTINCT FROM 'selected')`);
  const stamped = await mutate(
    `UPDATE paper_strategy_evaluations e
        SET paper_trade_id = t.id,
            trade_created = true,
            execution_status = CASE WHEN e.strategy_family IS NOT NULL THEN 'selected' ELSE e.execution_status END,
            -- A rejection reason on a row that demonstrably executed is a
            -- leftover from the pre-execution write, not a fact about the trade.
            rejection_reason = CASE WHEN e.strategy_family IS NOT NULL THEN NULL ELSE e.rejection_reason END,
            updated_at = now()
       FROM paper_strategy_trades t
      WHERE t.evaluation_id = e.id
        AND (e.paper_trade_id IS DISTINCT FROM t.id
             OR e.trade_created = false
             OR (e.strategy_family IS NOT NULL AND e.execution_status IS DISTINCT FROM 'selected'))`);
  p.repaired += DRY_RUN ? stampable : stamped;
  log(`${pad("evaluations restamped as executed")} ${DRY_RUN ? stampable : stamped}`);

  // 1d. Supersede the hypothetical outcomes that belong to real trades.
  //
  // Marked, never deleted. The row is the evidence that the defect existed and
  // that it was repaired; a DELETE would make this command unauditable.
  const supersedable = await count(
    `SELECT count(*)::text AS count FROM shadow_candidate_outcomes s
      JOIN paper_strategy_evaluations e ON e.id = s.evaluation_id
     WHERE s.superseded_by_trade_id IS NULL
       AND EXISTS (SELECT 1 FROM paper_strategy_trades t
                    WHERE t.evaluation_id = e.id
                       OR (t.instrument = e.instrument AND t.decision_time = e.decision_time
                           AND t.strategy_family = e.strategy_family))`);
  const superseded = await mutate(
    `UPDATE shadow_candidate_outcomes s
        SET superseded_by_trade_id = t.id,
            superseded_at = now(),
            superseded_reason = 'This opportunity produced a real paper trade; its hypothetical outcome must not be counted beside the actual one.'
       FROM paper_strategy_evaluations e, paper_strategy_trades t
      WHERE s.evaluation_id = e.id
        AND s.superseded_by_trade_id IS NULL
        AND (t.evaluation_id = e.id
             OR (t.instrument = e.instrument AND t.decision_time = e.decision_time
                 AND t.strategy_family = e.strategy_family))`);
  p.repaired += DRY_RUN ? supersedable : superseded;
  log(`${pad("shadow outcomes superseded by a real trade")} ${DRY_RUN ? supersedable : superseded}`);

  p.unchanged = before.shadowOutcomes - (DRY_RUN ? supersedable : superseded);
}

// ---------------------------------------------------------------------------
// PHASE 2 — news gate verdict
// ---------------------------------------------------------------------------
section("PHASE 2  news gate verdict");
{
  const p = phase("news gate verdict");

  // The gate ran on every one of these trades and its verdict survived inside
  // the conditions array; only the structured column was lost. Recovering it
  // from conditions[] means the two can never disagree — the column is derived
  // from the same fact rather than written independently.
  const candidates = await query<{ id: string; conditions: unknown; news_status: string }>(
    `SELECT id, conditions, news_status FROM paper_strategy_trades
      WHERE news_status = 'not_evaluated' AND jsonb_array_length(conditions) > 0`);

  let repaired = 0; let unchanged = 0; let unrecoverable = 0;
  for (const row of candidates.rows) {
    const conditions = Array.isArray(row.conditions) ? row.conditions as never[] : [];
    const derived = newsStatusFromConditions(conditions);
    if (derived === null) { unrecoverable += 1; continue; }
    if (derived === row.news_status) { unchanged += 1; continue; }
    if (!DRY_RUN) {
      await query("UPDATE paper_strategy_trades SET news_status=$2, updated_at=now() WHERE id=$1 AND news_status='not_evaluated'", [row.id, derived]);
    }
    repaired += 1;
  }
  p.repaired = repaired; p.unchanged = unchanged; p.ambiguous = unrecoverable;
  if (unrecoverable) p.notes.push(`${unrecoverable} trades carry no recoverable News condition — genuinely not evaluated, left as not_evaluated`);
  log(`${pad("news_status recovered from conditions[]")} ${repaired}`);
  log(`${pad("already correct")} ${unchanged}`);
  log(`${pad("no recoverable verdict (left alone)")} ${unrecoverable}`);
}

// ---------------------------------------------------------------------------
// PHASE 3 — legacy NO_NEWS that is really "no calendar"
// ---------------------------------------------------------------------------
section("PHASE 3  news classification vs calendar coverage");
{
  const p = phase("news classification");
  const coverage = await calendarCoverage();
  log(`${pad("calendar events stored")} ${coverage.events}`);
  log(`${pad("calendar span")} ${coverage.first_event ?? "-"} .. ${coverage.last_event ?? "-"}`);
  log(`${pad("trades with calendar coverage")} ${coverage.tradesWithCalendarNearby} / ${coverage.trades}`);

  const falseBefore = await count(
    `SELECT count(*)::text AS count FROM paper_strategy_trades t
      WHERE t.news_impact_tag = 'NO_NEWS' AND NOT EXISTS (
        SELECT 1 FROM economic_calendar_events c
         WHERE c.event_time BETWEEN COALESCE(t.opened_at,t.decision_time) - interval '1 day'
                                AND COALESCE(t.opened_at,t.decision_time) + interval '1 day')`);
  log(`${pad("NO_NEWS with no calendar coverage (before)")} ${falseBefore}`);

  if (!DRY_RUN) {
    // force:true recomputes every trade against the CURRENT stored calendar.
    // Deterministic and pure, so a re-run rewrites identical values — and a
    // trade whose calendar later fills in is upgraded rather than frozen.
    const result = await backfillNewsTags({ force: true });
    log(`${pad("trades re-classified")} ${result.tagged}`);
    for (const [tag, n] of Object.entries(result.counts)) log(`${pad(`  → ${tag}`)} ${n}`);
    const falseAfter = await count(
      `SELECT count(*)::text AS count FROM paper_strategy_trades t
        WHERE t.news_impact_tag = 'NO_NEWS' AND NOT EXISTS (
          SELECT 1 FROM economic_calendar_events c
           WHERE c.event_time BETWEEN COALESCE(t.opened_at,t.decision_time) - interval '1 day'
                                  AND COALESCE(t.opened_at,t.decision_time) + interval '1 day')`);
    // Repaired counts what genuinely CHANGED, not what was rewritten. The
    // classifier is deterministic, so a second run re-derives identical values
    // for every row — reporting those as repairs would hide whether the command
    // is actually idempotent.
    p.repaired = falseBefore - falseAfter;
    p.unchanged = result.tagged - p.repaired;
    log(`${pad("NO_NEWS with no calendar coverage (after)")} ${falseAfter}`);
  } else {
    p.repaired = falseBefore;
  }
  p.notes.push("A NO_NEWS verdict computed against a calendar that does not cover the trade is stored as INSUFFICIENT_CALENDAR_DATA. It is not evidence of quiet markets and must never be counted as such.");
}

// ---------------------------------------------------------------------------
// PHASE 4 — cost in R
// ---------------------------------------------------------------------------
section("PHASE 4  transaction cost in R");
{
  const p = phase("cost in R");

  const trades = await query<{ id: string; instrument: string; entry: string; stop: string; spread_pips: string | null; result_r: string | null; spread_cost_r: string | null; net_result_r: string | null; gross_result_r: string | null }>(
    `SELECT id, instrument, entry::text, stop::text, spread_pips::text, result_r::text,
            spread_cost_r::text, net_result_r::text, gross_result_r::text
       FROM paper_strategy_trades`);

  const same = (stored: string | null, computed: number | null) =>
    stored === null ? computed === null : computed !== null && Math.abs(Number(stored) - computed) < 1e-12;

  let repaired = 0; let unchanged = 0; let uncalculable = 0;
  for (const row of trades.rows) {
    const cost = spreadCostR({
      instrument: row.instrument,
      entry: row.entry === null ? null : Number(row.entry),
      stop: row.stop === null ? null : Number(row.stop),
      spreadPips: row.spread_pips === null ? null : Number(row.spread_pips),
    });
    if (cost === null) { uncalculable += 1; continue; }
    const netR = row.result_r === null ? null : Number(row.result_r);
    const grossR = netR === null ? null : netR + cost;
    // Already correct on every derived column: nothing to do. Counting a
    // rewrite of identical values as a repair would mask whether this command
    // is genuinely idempotent.
    if (same(row.spread_cost_r, cost) && same(row.net_result_r, netR) && same(row.gross_result_r, grossR)) {
      unchanged += 1; continue;
    }
    if (!DRY_RUN) {
      // commission_cost_r and slippage_cost_r are deliberately NOT written.
      // OANDA's trade endpoint reports neither, and nothing in this repository
      // stores a modelled-vs-filled pair, so any number here would be invented.
      // They stay NULL — explicitly unknown — and cost_basis says 'spread_only'.
      await query(
        `UPDATE paper_strategy_trades
            SET spread_cost_r=$2, total_cost_r=$2,
                net_result_r=$3, gross_result_r=$4,
                cost_basis='spread_only',
                result_basis=COALESCE(result_basis, CASE
                  WHEN EXISTS (SELECT 1 FROM practice_order_intents i
                                WHERE i.paper_trade_id = paper_strategy_trades.id
                                  AND i.status='submitted' AND i.broker_trade_id IS NOT NULL)
                  THEN 'broker' ELSE 'model' END),
                updated_at=now()
          WHERE id=$1`,
        [row.id, cost, netR, grossR]);
    }
    repaired += 1;
  }
  p.repaired = repaired; p.unchanged = unchanged; p.ambiguous = uncalculable;
  log(`${pad("trades with spread_cost_r / net / gross written")} ${repaired}`);
  log(`${pad("not calculable (left explicitly unknown)")} ${uncalculable}`);
  p.notes.push("commission_cost_r and slippage_cost_r are left NULL on every row: OANDA's trade endpoint reports neither, and no modelled-vs-filled pair is stored. NULL means unknown, not zero.");

  // The same decomposition for the counterfactual arm, from the evaluation the
  // shadow was labelled on.
  const shadows = await query<{ evaluation_id: string; instrument: string; entry: string; stop: string; spread_pips: string | null; result_r: string | null; spread_cost_r: string | null; gross_result_r: string | null }>(
    `SELECT s.evaluation_id, e.instrument, e.entry::text, e.stop::text, e.spread_pips::text, s.result_r::text,
            s.spread_cost_r::text, s.gross_result_r::text
       FROM shadow_candidate_outcomes s
       JOIN paper_strategy_evaluations e ON e.id = s.evaluation_id`);
  let shadowRepaired = 0; let shadowUnchanged = 0; let shadowUncalculable = 0;
  for (const row of shadows.rows) {
    const cost = spreadCostR({
      instrument: row.instrument,
      entry: row.entry === null ? null : Number(row.entry),
      stop: row.stop === null ? null : Number(row.stop),
      spreadPips: row.spread_pips === null ? null : Number(row.spread_pips),
    });
    if (cost === null) { shadowUncalculable += 1; continue; }
    const netR = row.result_r === null ? null : Number(row.result_r);
    const grossR = netR === null ? null : netR + cost;
    if (same(row.spread_cost_r, cost) && same(row.gross_result_r, grossR)) { shadowUnchanged += 1; continue; }
    if (!DRY_RUN) {
      await query(
        `UPDATE shadow_candidate_outcomes
            SET spread_cost_r=$2, total_cost_r=$2, net_result_r=$3, gross_result_r=$4, cost_basis='spread_only'
          WHERE evaluation_id=$1`,
        [row.evaluation_id, cost, netR, grossR]);
    }
    shadowRepaired += 1;
  }
  log(`${pad("shadow outcomes given a cost decomposition")} ${shadowRepaired}`);
  log(`${pad("shadow outcomes already correct")} ${shadowUnchanged}`);
  log(`${pad("shadow outcomes not calculable")} ${shadowUncalculable}`);
  p.repaired += shadowRepaired; p.unchanged += shadowUnchanged; p.ambiguous += shadowUncalculable;
}

// ---------------------------------------------------------------------------
// PHASE 5 — paired original / inverted Momentum arms
// ---------------------------------------------------------------------------
section("PHASE 5  momentum original/inverted pairing");
{
  const p = phase("momentum pairing");

  if (SKIP_MOMENTUM_BACKFILL) {
    log("skipped (--skip-momentum-backfill)");
    p.notes.push("historical pairing skipped by flag");
  } else {
    // Every executed Momentum trade becomes a pair: the arm that traded, plus
    // its exact opposite as a counterfactual.
    //
    // Reconstructing the opposite side is arithmetic, not a guess. `entry` is by
    // construction the executable side of the book (ask for a long, bid for a
    // short) and spread_pips is the spread at that same instant, so the other
    // side is entry ∓ spread — exact, from two stored values.
    const momentum = await query<{ id: string; instrument: string; decision_time: string | Date; direction: "long" | "short"; original_direction: string | null; entry: string; stop: string; target: string; spread_pips: string; session: string; regime: string | null; trend_strength: string | null; volatility_bucket: string | null; config_version: string | null; atr_pips: string | null; features: { regime?: { atr?: number } } | null }>(
      `SELECT id, instrument, decision_time, direction, original_direction, entry::text, stop::text, target::text,
              spread_pips::text, session, regime, trend_strength::text, volatility_bucket, config_version,
              atr_pips::text, features
         FROM paper_strategy_trades
        WHERE strategy_family = 'momentum'
        ORDER BY decision_time`);

    let pairsWritten = 0; let pairsSkipped = 0; let pairsExcluded = 0;
    for (const trade of momentum.rows) {
      const decisionTime = new Date(trade.decision_time).toISOString();
      const entry = Number(trade.entry); const stop = Number(trade.stop); const target = Number(trade.target);
      const spreadPips = Number(trade.spread_pips);
      // What MOMENTUM concluded. Null original_direction means the inversion
      // policy was not active, so the executed direction is the strategy's own.
      const originalDirection = (trade.original_direction ?? trade.direction) as "long" | "short";
      const executedDirection = trade.direction;

      if (![entry, stop, target, spreadPips].every((v) => Number.isFinite(v))) { pairsExcluded += 1; continue; }

      // Rebuild the book at the decision from the executed side and the spread.
      const pip = pipSizeFor(trade.instrument);
      const spreadPrice = spreadPips * pip;
      const ask = executedDirection === "long" ? entry : entry + spreadPrice;
      const bid = executedDirection === "long" ? entry - spreadPrice : entry;

      // The ORIGINAL arm's geometry. When the trade was not inverted this is
      // exactly the trade; when it was, the original plan is rebuilt on its own
      // side with the same distances.
      const stopDistance = Math.abs(entry - stop);
      const targetDistance = Math.abs(target - entry);
      const originalEntry = originalDirection === "long" ? ask : bid;
      const originalStop = originalDirection === "long" ? originalEntry - stopDistance : originalEntry + stopDistance;
      const originalTarget = originalDirection === "long" ? originalEntry + targetDistance : originalEntry - targetDistance;

      const arms = buildMomentumArms({
        direction: originalDirection, entry: originalEntry, stop: originalStop, target: originalTarget,
        quote: { bid, ask },
      });
      if (!arms) { pairsExcluded += 1; continue; }

      const pairKey = momentumPairKey(BACKFILL_COHORT, trade.instrument, decisionTime);
      const atr = trade.features?.regime?.atr ?? null;

      let wrote = false;
      for (const [arm, geometry] of [["original", arms.original], ["inverted", arms.inverted]] as const) {
        const executed = geometry.direction === executedDirection;
        const cost = spreadCostR({ instrument: trade.instrument, entry: geometry.entry, stop: geometry.stop, spreadPips });
        if (DRY_RUN) { wrote = true; continue; }
        const inserted = await query(
          `INSERT INTO momentum_inversion_arms
             (pair_id, arm, experiment_id, instrument, decision_time, strategy_family, strategy_version,
              config_version, session, regime, trend_strength, volatility_bucket, atr, atr_pips, spread_pips,
              direction, entry, stop, target, stop_distance, target_distance, spread_cost_r,
              executed, paper_trade_id, outcome_source, status)
           VALUES (md5($1)::uuid, $2, $3, $4, $5, 'momentum', 'momentum-v1',
                   $6, $7, $8, $9, $10, $11, $12, $13,
                   $14, $15, $16, $17, $18, $19, $20,
                   $21, $22, CASE WHEN $21 THEN 'executed' ELSE NULL END, 'pending')
           ON CONFLICT (experiment_id, instrument, decision_time, arm) DO NOTHING`,
          [pairKey, arm, BACKFILL_COHORT, trade.instrument, decisionTime,
           trade.config_version ?? "momentum-cfg-v1", trade.session, trade.regime,
           trade.trend_strength, trade.volatility_bucket, atr, trade.atr_pips, spreadPips,
           geometry.direction, geometry.entry, geometry.stop, geometry.target,
           geometry.stopDistance, geometry.targetDistance, cost,
           executed, executed ? trade.id : null]);
        if ((inserted.rowCount ?? 0) > 0) wrote = true;
      }
      if (wrote) pairsWritten += 1; else pairsSkipped += 1;
    }

    log(`${pad("momentum opportunities paired")} ${pairsWritten}`);
    log(`${pad("already paired (idempotent no-op)")} ${pairsSkipped}`);
    log(`${pad("excluded: geometry not reconstructible")} ${pairsExcluded}`);
    p.repaired = pairsWritten; p.unchanged = pairsSkipped; p.ambiguous = pairsExcluded;
    p.notes.push(`Historical pairs are filed under cohort '${BACKFILL_COHORT}', NOT 'momentum-inversion-v1'. The forward experiment activated 2026-08-23 and every Momentum trade predates it; pooling them would let the sample that generated the hypothesis also appear to confirm it.`);

    // Resolve both arms: the executed one copies the real trade's outcome, the
    // other is labelled by the same pure shadow resolver the candidates use.
    if (!DRY_RUN) {
      try {
        const resolved = await resolveMomentumInversionArms(async (instrument) => {
          const candles = (await getResearchCandles(instrument, "M15", 500)).filter((candle) => candle.complete);
          return candles.map((candle) => ({
            closeTime: new Date(new Date(candle.time).getTime() + 15 * 60_000).toISOString(),
            bidOpen: candle.bid.open, bidHigh: candle.bid.high, bidLow: candle.bid.low, bidClose: candle.bid.close,
            askOpen: candle.ask.open, askHigh: candle.ask.high, askLow: candle.ask.low, askClose: candle.ask.close,
          }));
        });
        log(`${pad("arms resolved")} ${resolved}`);
      } catch (error) {
        log(`${pad("arm resolution unavailable")} ${(error as Error).message}`);
        p.notes.push("Arm resolution needs OANDA candles; arms remain 'pending' and the next collector cycle will finish them.");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// VERIFICATION
// ---------------------------------------------------------------------------
const after = await evidenceIntegrityMetrics();
const violationsAfter = await integrityViolations();

section("BEFORE / AFTER");
const rows: Array<[string, number, number]> = [
  ["observations IN THE TABLES (no read guard)", before.unguardedObservations, after.unguardedObservations],
  ["  duplicate opportunities", before.unguardedDuplicates, after.unguardedDuplicates],
  ["  conflicting outcomes", before.unguardedConflicts, after.unguardedConflicts],
  ["observations the loader COUNTS", before.adaptiveObservations, after.adaptiveObservations],
  ["  duplicate opportunities", before.duplicateOpportunities, after.duplicateOpportunities],
  ["  conflicting outcomes", before.conflictingOutcomes, after.conflictingOutcomes],
  ["closed trades (all strategies)", before.closedTrades, after.closedTrades],
  ["live (countable) shadow outcomes", before.liveShadowOutcomes, after.liveShadowOutcomes],
  ["superseded shadow outcomes", before.supersededShadowOutcomes, after.supersededShadowOutcomes],
  ["blocked/suppressed valid evaluations", before.validNonExecutedCandidates, after.validNonExecutedCandidates],
  ["trades linked to their evaluation", before.tradesLinkedToEvaluation, after.tradesLinkedToEvaluation],
  ["evaluations flagged trade_created", before.evaluationsFlaggedCreated, after.evaluationsFlaggedCreated],
  ["evaluations marked selected", before.evaluationsMarkedSelected, after.evaluationsMarkedSelected],
  ["news_status = not_evaluated", before.newsNotEvaluatedStatus, after.newsNotEvaluatedStatus],
  ["news evaluation state recorded", before.newsEvaluationStateSet, after.newsEvaluationStateSet],
  ["false NO_NEWS (no calendar coverage)", before.newsFalseNoNews, after.newsFalseNoNews],
  ["tagged INSUFFICIENT_CALENDAR_DATA", before.newsInsufficientCalendarData, after.newsInsufficientCalendarData],
  ["trades with spread_cost_r", before.tradesWithSpreadCostR, after.tradesWithSpreadCostR],
  ["trades with net_result_r", before.tradesWithNetResultR, after.tradesWithNetResultR],
  ["trades with gross_result_r", before.tradesWithGrossResultR, after.tradesWithGrossResultR],
  ["shadow outcomes with spread_cost_r", before.shadowWithSpreadCostR, after.shadowWithSpreadCostR],
  ["momentum pairs", before.momentumPairs, after.momentumPairs],
  ["momentum pairs fully resolved", before.momentumCompletePairs, after.momentumCompletePairs],
  ["momentum pairs with a real execution", before.momentumPairsWithExecution, after.momentumPairsWithExecution],
];
log(`${pad("metric", 44)} ${"before".padStart(8)} ${"after".padStart(8)}   change`);
log("-".repeat(78));
for (const [label, b, a] of rows) {
  const delta = a - b;
  log(`${pad(label, 44)} ${String(b).padStart(8)} ${String(a).padStart(8)}   ${delta === 0 ? "-" : delta > 0 ? `+${delta}` : String(delta)}`);
}

section("PHASE SUMMARY");
for (const p of phases) {
  log(`${pad(p.name, 30)} repaired ${String(p.repaired).padStart(5)}   unchanged ${String(p.unchanged).padStart(5)}   ambiguous ${String(p.ambiguous).padStart(5)}`);
  for (const note of p.notes) log(`    · ${note}`);
}

section("INVARIANTS");
log(`before: ${violationsBefore.length} violated`);
for (const v of violationsBefore) log(`   ✗ ${v.invariant} (${v.count}) — ${v.detail}`);
log(`after:  ${violationsAfter.length} violated`);
for (const v of violationsAfter) log(`   ✗ ${v.invariant} (${v.count}) — ${v.detail}`);
if (violationsAfter.length === 0) log("   ✓ every evidence invariant holds");

section("ADAPTIVE THRESHOLDS");
log("Unchanged by this command. Nothing here lowers minLearningSample (50),");
log("minActiveSample (100) or confidenceZ (1.64), and no selector state was");
log("advanced. The pipeline is being made trustworthy, not more permissive.");

log();
log("=".repeat(78));
if (DRY_RUN) log("DRY RUN — no rows were written. Re-run without --dry-run to apply.");
else log(violationsAfter.length === 0 ? "REPAIR COMPLETE — evidence invariants hold." : "REPAIR INCOMPLETE — invariants still violated (see above).");
log("=".repeat(78));

process.exit(violationsAfter.length === 0 || DRY_RUN ? 0 : 1);

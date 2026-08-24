import { query } from "./database.js";
import { resolveShadowOutcome } from "./shadow-outcomes.js";
import { buildMomentumArms, momentumPairKey, oppositeDirection, spreadCostR, type MomentumArm } from "./evidence-integrity.js";
import { MOMENTUM_INVERSION_EXPERIMENT } from "./momentum-inversion.js";
import type { NormalizedQuote } from "./research.js";
import type { StrategyCandidate } from "../../frontend/src/lib/strategy/strategy.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";

/**
 * Paired original / inverted Momentum arms.
 *
 * THE PROBLEM THIS SOLVES. `applyMomentumInversion` REPLACES the direction, so
 * exactly one arm is ever traded. The arm that was not traded gets no result at
 * all: `resolveShadowCandidates` only labels candidates whose execution_status
 * is 'suppressed' or 'blocked', and the executing path promotes the evaluation
 * row to 'selected'. So the counterfactual — the whole point of the experiment —
 * was never being recorded.
 *
 * WHAT THIS DOES. For every eligible Momentum opportunity it writes TWO research
 * rows under one stable pair id: the direction Momentum concluded and its exact
 * opposite. At most one of them is marked executed and takes its outcome from
 * the real paper trade; the other is resolved deterministically as a shadow.
 * Neither being executed is a normal state — the candidate may have been
 * suppressed, blocked by an open position, or the instrument busy — and then
 * both arms are shadows.
 *
 * WHAT THIS DOES NOT DO. It places no order, opens no position, and touches
 * neither risk nor exposure. Critically, `loadAdaptiveEvidence` reads
 * `paper_strategy_trades` and `shadow_candidate_outcomes` — this table is
 * deliberately neither, exactly like `momentum_short_inversion_pairs`. So
 * recording a pair cannot change what the engine selects, and cannot
 * double-count the executed arm that already appears in the trade ledger.
 */

const ELIGIBLE_FAMILY = "momentum";

/** Same horizon the executed resolver and shadow resolver already use. */
export type MomentumArmRecordResult = "recorded" | "excluded" | "skipped";

export interface RecordArmsInput {
  /** The candidate as MOMENTUM produced it, before any inversion policy. */
  candidate: StrategyCandidate;
  quote: { bid: number; ask: number } | undefined;
  spreadPips: number | null;
  session: string;
}

/**
 * The deterministic pair id, computed the same way on both sides.
 *
 * `md5(key)::uuid` in SQL over the identical string the TypeScript helper
 * builds, so a repair, a re-record and a test all land on one pair rather than
 * three. Generating a random uuid here would break idempotency: the second run
 * would create a duplicate pair instead of updating the first.
 */
const PAIR_ID_SQL = "md5($1)::uuid";

/**
 * Record both arms of one Momentum opportunity.
 *
 * Idempotent by construction: the pair id is derived, and the write is an
 * ON CONFLICT DO NOTHING against UNIQUE(experiment, instrument, decision_time,
 * arm). Re-running over the same bar changes nothing.
 *
 * An opportunity that cannot be priced on both sides of the book is stored as
 * `excluded` with a reason rather than dropped, so the denominator stays honest
 * — a pair with one guessed arm would be worse than no pair at all.
 */
export async function recordMomentumInversionArms(input: RecordArmsInput): Promise<MomentumArmRecordResult> {
  const candidate = input.candidate;
  if (candidate.family !== ELIGIBLE_FAMILY) return "skipped";
  if (candidate.status !== "valid" || candidate.direction === null) return "skipped";

  const pairKey = momentumPairKey(MOMENTUM_INVERSION_EXPERIMENT, candidate.instrument, candidate.evaluatedAt);

  const exclude = async (reason: string) => {
    // Both arms are written as excluded so the pair is still visibly a pair.
    for (const arm of ["original", "inverted"] as const) {
      await query(
        `INSERT INTO momentum_inversion_arms
           (pair_id, arm, experiment_id, instrument, decision_time, strategy_family, strategy_version,
            config_version, session, regime, trend_strength, volatility_bucket, atr, atr_pips, spread_pips,
            direction, entry, stop, target, stop_distance, target_distance, status, excluded_reason)
         VALUES (${PAIR_ID_SQL}, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                 $16, 0, 0, 0, 0, 0, 'excluded', $17)
         ON CONFLICT (experiment_id, instrument, decision_time, arm) DO NOTHING`,
        [pairKey, arm, MOMENTUM_INVERSION_EXPERIMENT, candidate.instrument, candidate.evaluatedAt,
         candidate.family, candidate.version, candidate.configVersion, input.session,
         candidate.regime?.regime ?? null, candidate.regime?.trendStrength ?? null,
         candidate.regime?.volatility ?? null, candidate.regime?.atr ?? null, candidate.regime?.atrPips ?? null,
         input.spreadPips,
         arm === "original" ? candidate.direction : oppositeDirection(candidate.direction!), reason],
      );
    }
    return "excluded" as const;
  };

  if (!input.quote) return exclude("no live quote at signal time");
  if (candidate.entry === null || candidate.stop === null || candidate.target === null) return exclude("incomplete trade plan");

  const arms = buildMomentumArms({
    direction: candidate.direction, entry: candidate.entry, stop: candidate.stop, target: candidate.target,
    quote: input.quote,
  });
  if (!arms) return exclude("degenerate geometry or unusable quote");

  for (const [arm, geometry] of [["original", arms.original], ["inverted", arms.inverted]] as const) {
    const cost = spreadCostR({
      instrument: candidate.instrument, entry: geometry.entry, stop: geometry.stop, spreadPips: input.spreadPips,
    });
    await query(
      `INSERT INTO momentum_inversion_arms
         (pair_id, arm, experiment_id, instrument, decision_time, strategy_family, strategy_version,
          config_version, session, regime, trend_strength, volatility_bucket, atr, atr_pips, spread_pips,
          direction, entry, stop, target, stop_distance, target_distance, spread_cost_r, status)
       VALUES (${PAIR_ID_SQL}, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16, $17, $18, $19, $20, $21, $22, 'pending')
       ON CONFLICT (experiment_id, instrument, decision_time, arm) DO NOTHING`,
      [pairKey, arm, MOMENTUM_INVERSION_EXPERIMENT, candidate.instrument, candidate.evaluatedAt,
       candidate.family, candidate.version, candidate.configVersion, input.session,
       candidate.regime?.regime ?? null, candidate.regime?.trendStrength ?? null,
       candidate.regime?.volatility ?? null, candidate.regime?.atr ?? null, candidate.regime?.atrPips ?? null,
       input.spreadPips,
       geometry.direction, geometry.entry, geometry.stop, geometry.target,
       geometry.stopDistance, geometry.targetDistance, cost],
    );
  }
  return "recorded";
}

/**
 * Mark which arm was actually executed, once a paper trade exists for it.
 *
 * The partial unique index `momentum_inversion_arms_one_execution_idx` enforces
 * the "at most one real execution per pair" rule at the database, so a bug that
 * tried to mark both arms executed would fail loudly rather than corrupt the
 * pair. The guard `WHERE NOT executed` keeps the call idempotent.
 */
export async function attachMomentumExecution(input: {
  instrument: string;
  decisionTime: string;
  arm: MomentumArm;
  paperTradeId: string;
}): Promise<boolean> {
  const updated = await query(
    `UPDATE momentum_inversion_arms
        SET executed = true, paper_trade_id = $4, outcome_source = 'executed', updated_at = now()
      WHERE experiment_id = $1 AND instrument = $2 AND decision_time = $3 AND arm = $5
        AND NOT executed`,
    [MOMENTUM_INVERSION_EXPERIMENT, input.instrument, input.decisionTime, input.paperTradeId, input.arm],
  );
  return (updated.rowCount ?? 0) > 0;
}

/**
 * Resolve outcomes for every pending arm.
 *
 * An EXECUTED arm copies the real trade's outcome verbatim — it is not
 * re-simulated, because the actual result is the better evidence and mixing a
 * modelled figure into an executed arm is exactly the confusion this whole
 * repair exists to remove.
 *
 * An UNEXECUTED arm is resolved by `resolveShadowOutcome`, the same pure
 * labeller the shadow candidates use, against completed M15 candles. It returns
 * null while the outcome is not yet known in real time, so an arm cannot be
 * resolved before its result would genuinely have existed.
 */
export async function resolveMomentumInversionArms(
  candlesFor: (instrument: MajorInstrument) => Promise<NormalizedQuote[]>,
  now = new Date(),
): Promise<number> {
  // Executed arms first: a direct copy, no candles needed.
  const executed = await query<{ id: string; outcome: string; result_r: string | null; net_result_r: string | null; gross_result_r: string | null; max_favorable_r: string | null; max_adverse_r: string | null; exit: string | null; closed_at: string | Date | null; exit_reason: string | null; spread_cost_r: string | null }>(
    `SELECT arm.id, trade.outcome, trade.result_r::text, trade.net_result_r::text, trade.gross_result_r::text,
            trade.max_favorable_r::text, trade.max_adverse_r::text, trade.exit::text,
            trade.closed_at, trade.exit_reason, trade.spread_cost_r::text
       FROM momentum_inversion_arms arm
       JOIN paper_strategy_trades trade ON trade.id = arm.paper_trade_id
      WHERE arm.status = 'pending' AND arm.executed
        AND trade.status = 'closed' AND trade.result_r IS NOT NULL`,
  );
  let resolved = 0;
  for (const row of executed.rows) {
    // Every parameter is cast explicitly. Without the casts Postgres has to
    // infer a type for a placeholder used in two positions (a bare column
    // assignment and a COALESCE argument) and refuses with "inconsistent types
    // deduced for parameter".
    await query(
      `UPDATE momentum_inversion_arms
          SET status='resolved', outcome=$2::text, outcome_source='executed',
              result_r=$3::numeric, net_result_r=COALESCE($4::numeric,$3::numeric), gross_result_r=$5::numeric,
              spread_cost_r=COALESCE($10::numeric, spread_cost_r),
              max_favorable_r=$6::numeric, max_adverse_r=$7::numeric, exit=$8::numeric, resolved_at=$9::timestamptz,
              exit_reason=COALESCE($11::text, $2::text), updated_at=now()
        WHERE id=$1 AND status='pending'`,
      [row.id, row.outcome, row.result_r, row.net_result_r, row.gross_result_r,
       row.max_favorable_r, row.max_adverse_r, row.exit, row.closed_at, row.spread_cost_r, row.exit_reason],
    );
    resolved += 1;
  }

  // Unexecuted arms: deterministic shadow resolution, one candle fetch per pair.
  const pending = await query<{ id: string; instrument: MajorInstrument; direction: "long" | "short"; entry: string; stop: string; target: string; decision_time: string | Date; spread_cost_r: string | null }>(
    `SELECT id, instrument, direction, entry::text, stop::text, target::text, decision_time, spread_cost_r::text
       FROM momentum_inversion_arms
      WHERE status = 'pending' AND NOT executed
      ORDER BY instrument, decision_time
      LIMIT 300`,
  );
  const byInstrument = new Map<MajorInstrument, typeof pending.rows>();
  for (const row of pending.rows) byInstrument.set(row.instrument, [...(byInstrument.get(row.instrument) ?? []), row]);

  for (const [instrument, rows] of byInstrument) {
    let quotes: NormalizedQuote[];
    try { quotes = await candlesFor(instrument); }
    catch (error) { console.error("[momentum-arms] candles unavailable", instrument, error); continue; }
    if (!quotes.length) continue;

    for (const row of rows) {
      const decisionTime = new Date(row.decision_time).toISOString();
      const entry = Number(row.entry); const stop = Number(row.stop); const target = Number(row.target);
      if (![entry, stop, target].every(Number.isFinite)) continue;
      const outcome = resolveShadowOutcome(row.direction, entry, stop, target, decisionTime, quotes, now);
      // Null means the horizon has not elapsed and no level was touched: the
      // result is genuinely not known yet, so the arm stays pending.
      if (!outcome) continue;

      const netR = outcome.resultR;
      const spread = row.spread_cost_r === null ? null : Number(row.spread_cost_r);
      const grossR = netR === null || spread === null ? null : netR + spread;
      await query(
        `UPDATE momentum_inversion_arms
            SET status='resolved', outcome=$2::text, outcome_source='shadow',
                result_r=$3::numeric, net_result_r=$3::numeric, gross_result_r=$4::numeric,
                max_favorable_r=$5::numeric, max_adverse_r=$6::numeric, exit=$7::numeric,
                resolved_at=$8::timestamptz, horizon_ends_at=$9::timestamptz, exit_reason=$10::text, updated_at=now()
          WHERE id=$1 AND status='pending'`,
        [row.id, outcome.outcome, netR, grossR, outcome.maxFavorableR, outcome.maxAdverseR,
         outcome.exit, outcome.resolvedAt, outcome.horizonEndsAt, outcome.exitReason],
      );
      resolved += 1;
    }
  }
  return resolved;
}

/**
 * Pair-level view for research and the integrity report.
 *
 * A pair is only comparable once BOTH arms have a result, which is why the
 * report counts complete pairs separately from recorded ones.
 */
export async function momentumPairSummary() {
  const rows = await query<{ pairs: string; complete: string; executed_pairs: string; both_shadow: string; excluded: string; orphan_arms: string; multi_executed: string }>(
    `WITH pair AS (
       SELECT pair_id,
              count(*) FILTER (WHERE status <> 'excluded') AS arms,
              count(*) FILTER (WHERE status = 'resolved') AS resolved_arms,
              count(*) FILTER (WHERE executed) AS executed_arms,
              count(*) FILTER (WHERE status = 'excluded') AS excluded_arms
         FROM momentum_inversion_arms GROUP BY pair_id)
     SELECT count(*)::text AS pairs,
            count(*) FILTER (WHERE resolved_arms = 2)::text AS complete,
            count(*) FILTER (WHERE executed_arms = 1)::text AS executed_pairs,
            count(*) FILTER (WHERE executed_arms = 0 AND excluded_arms = 0)::text AS both_shadow,
            count(*) FILTER (WHERE excluded_arms > 0)::text AS excluded,
            count(*) FILTER (WHERE arms = 1)::text AS orphan_arms,
            count(*) FILTER (WHERE executed_arms > 1)::text AS multi_executed
       FROM pair`,
  );
  return rows.rows[0] ?? { pairs: "0", complete: "0", executed_pairs: "0", both_shadow: "0", excluded: "0", orphan_arms: "0", multi_executed: "0" };
}

import { query } from "./database.js";

/**
 * Database-level evidence integrity: the metrics the repair report prints, and
 * the invariants that must hold once it has run.
 *
 * Every check here is a READ. Nothing in this module writes, repairs, or
 * deletes — the repair command owns all mutation, so an invariant can never
 * quietly fix the thing it is supposed to be measuring.
 *
 * The invariants are deliberately expressed against the TRADE LEDGER rather
 * than against status columns. `execution_status` is what drifted in the first
 * place: it is written before execution is attempted and promoted afterwards,
 * and when the promoting UPDATE silently matched zero rows, 48 real trades stayed
 * filed as 'blocked' and were handed a hypothetical outcome on top of the real
 * one. A check that trusted that column would have reported everything fine.
 */

export interface IntegrityMetrics {
  // Trades
  trades: number;
  multiStrategyTrades: number;
  closedTrades: number;
  tradesLinkedToEvaluation: number;
  // Evaluations
  evaluations: number;
  validNonExecutedCandidates: number;
  evaluationsFlaggedCreated: number;
  evaluationsMarkedSelected: number;
  // Shadow
  shadowOutcomes: number;
  liveShadowOutcomes: number;
  supersededShadowOutcomes: number;
  // Evidence, as the loader actually reads it (guards applied)
  adaptiveObservations: number;
  duplicateOpportunities: number;
  conflictingOutcomes: number;
  // Evidence as it sits in the TABLES, with no read-time guard.
  //
  // This is the honest measure of whether the DATA is clean, as opposed to
  // whether a query is compensating for it. The loader's exclusions and the
  // repair fix the same defect from two ends: the guard stops a corrupt row
  // being counted, the repair stops it being corrupt. Only this number falling
  // proves the second one happened.
  unguardedObservations: number;
  unguardedDuplicates: number;
  unguardedConflicts: number;
  // News
  newsTagged: number;
  newsNotEvaluatedStatus: number;
  newsFalseNoNews: number;
  newsEvaluationStateSet: number;
  newsInsufficientCalendarData: number;
  // Cost
  resolvedTrades: number;
  tradesWithSpreadCostR: number;
  tradesWithNetResultR: number;
  tradesWithGrossResultR: number;
  tradesWithUnknownCost: number;
  shadowWithSpreadCostR: number;
  // Momentum pairing
  momentumPairs: number;
  momentumCompletePairs: number;
  momentumPairsWithExecution: number;
  momentumPairsMultiExecuted: number;
}

const number = (value: unknown) => Number(value ?? 0);

/**
 * ONE ADAPTIVE OBSERVATION = one strategy ARM at one OPPORTUNITY.
 *
 *     experiment . family . config_version . instrument . decision_time . strategy_direction
 *
 * strategy_direction is COALESCE(original_direction, direction) — what the
 * STRATEGY concluded, not what an execution policy traded — because that is the
 * key the engine looks a candidate up by on the next bar. config_version is part
 * of the identity because a parameter change is a different strategy and must
 * not be averaged into the same bucket.
 *
 * This view is the single definition, shared by the metrics, the duplicate
 * check, the conflict check and the tests, so "what counts as one observation"
 * is answered in exactly one place.
 */
const OBSERVATIONS_SQL = `
  WITH observation AS (
    SELECT 'executed' AS source,
           t.experiment_id, t.strategy_family, t.config_version, t.instrument, t.decision_time,
           COALESCE(t.original_direction, t.direction) AS strategy_direction,
           t.outcome,
           COALESCE(t.net_result_r, t.result_r) AS net_result_r,
           t.id AS trade_id, NULL::uuid AS evaluation_id
      FROM paper_strategy_trades t
     WHERE t.experiment_id IS NOT NULL AND t.strategy_family IS NOT NULL
       AND t.status = 'closed' AND t.result_r IS NOT NULL
    UNION ALL
    SELECT 'shadow' AS source,
           e.experiment_id, e.strategy_family, e.config_version, e.instrument, e.decision_time,
           COALESCE(e.original_direction, e.direction) AS strategy_direction,
           s.outcome,
           COALESCE(s.net_result_r, s.result_r) AS net_result_r,
           NULL::uuid AS trade_id, e.id AS evaluation_id
      FROM shadow_candidate_outcomes s
      JOIN paper_strategy_evaluations e ON e.id = s.evaluation_id
     WHERE e.experiment_id IS NOT NULL AND e.strategy_family IS NOT NULL AND e.direction IS NOT NULL
       AND s.result_r IS NOT NULL AND s.outcome IN ('target_first','stop_first','forced_close','timeout')
       -- Exactly the exclusions loadAdaptiveEvidence applies, so this view
       -- measures what the engine actually reads rather than what the table holds.
       AND s.superseded_by_trade_id IS NULL
       AND e.paper_trade_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM paper_strategy_trades l WHERE l.evaluation_id = e.id)
       AND NOT EXISTS (
         SELECT 1 FROM paper_strategy_trades d
          WHERE d.instrument = e.instrument AND d.decision_time = e.decision_time
            AND d.strategy_family = e.strategy_family)
  )`;

/**
 * The same union WITHOUT the read-time reconstruction — every executed trade and
 * every shadow outcome the ROWS THEMSELVES still claim is evidence.
 *
 * Kept deliberately: a guard in the SELECT and a repair in the rows are two
 * different fixes, and reporting only the guarded number would let a corrupt
 * table look clean behind a careful query. This is the one that has to fall on
 * its own, and it does so only because the repair stamped the rows.
 *
 * `superseded_by_trade_id` IS honoured here, because it is a stored fact written
 * onto the row — "this hypothetical belongs to an opportunity that really
 * traded" — not a relationship re-derived at read time. What this view does NOT
 * use is the cross-table NOT EXISTS reconstruction the loader falls back on;
 * that is the compensating logic whose help is being measured.
 */
const UNGUARDED_OBSERVATIONS_SQL = `
  WITH observation AS (
    SELECT 'executed' AS source,
           t.experiment_id, t.strategy_family, t.config_version, t.instrument, t.decision_time,
           COALESCE(t.original_direction, t.direction) AS strategy_direction, t.outcome
      FROM paper_strategy_trades t
     WHERE t.experiment_id IS NOT NULL AND t.strategy_family IS NOT NULL
       AND t.status = 'closed' AND t.result_r IS NOT NULL
    UNION ALL
    SELECT 'shadow' AS source,
           e.experiment_id, e.strategy_family, e.config_version, e.instrument, e.decision_time,
           COALESCE(e.original_direction, e.direction) AS strategy_direction, s.outcome
      FROM shadow_candidate_outcomes s
      JOIN paper_strategy_evaluations e ON e.id = s.evaluation_id
     WHERE e.experiment_id IS NOT NULL AND e.strategy_family IS NOT NULL AND e.direction IS NOT NULL
       AND s.result_r IS NOT NULL AND s.outcome IN ('target_first','stop_first','forced_close','timeout')
       AND s.superseded_by_trade_id IS NULL
  )`;

/** The observation key, spelled once. */
const OBSERVATION_KEY = "experiment_id, strategy_family, config_version, instrument, decision_time, strategy_direction";

export async function evidenceIntegrityMetrics(): Promise<IntegrityMetrics> {
  const trades = await query(`
    SELECT count(*)::text AS trades,
           count(*) FILTER (WHERE strategy_family IS NOT NULL)::text AS multi,
           count(*) FILTER (WHERE status='closed')::text AS closed,
           count(evaluation_id)::text AS linked,
           count(*) FILTER (WHERE result_r IS NOT NULL)::text AS resolved,
           count(spread_cost_r)::text AS with_spread_cost,
           count(net_result_r)::text AS with_net,
           count(gross_result_r)::text AS with_gross,
           count(*) FILTER (WHERE cost_basis = 'unknown')::text AS unknown_cost,
           count(news_impact_tag)::text AS news_tagged,
           count(*) FILTER (WHERE news_status = 'not_evaluated')::text AS news_not_evaluated,
           count(news_evaluation_state)::text AS news_state_set,
           count(*) FILTER (WHERE news_impact_tag = 'INSUFFICIENT_CALENDAR_DATA')::text AS news_insufficient,
           -- The dishonest case: a confirmed-quiet tag on a trade the stored
           -- calendar never covered. Recomputed from the calendar itself rather
           -- than trusting the stored coverage count.
           count(*) FILTER (WHERE news_impact_tag = 'NO_NEWS' AND NOT EXISTS (
             SELECT 1 FROM economic_calendar_events c
              WHERE c.event_time BETWEEN COALESCE(t.opened_at, t.decision_time) - interval '1 day'
                                     AND COALESCE(t.opened_at, t.decision_time) + interval '1 day'))::text AS false_no_news
      FROM paper_strategy_trades t`);
  const t = trades.rows[0]!;

  const evaluations = await query(`
    SELECT count(*)::text AS evaluations,
           count(*) FILTER (WHERE strategy_family IS NOT NULL AND setup_status='valid'
                              AND execution_status IN ('suppressed','blocked'))::text AS valid_non_executed,
           count(*) FILTER (WHERE trade_created)::text AS flagged_created,
           count(*) FILTER (WHERE execution_status='selected')::text AS marked_selected
      FROM paper_strategy_evaluations`);
  const e = evaluations.rows[0]!;

  const shadow = await query(`
    SELECT count(*)::text AS total,
           count(*) FILTER (WHERE superseded_by_trade_id IS NULL)::text AS live,
           count(*) FILTER (WHERE superseded_by_trade_id IS NOT NULL)::text AS superseded,
           count(spread_cost_r)::text AS with_spread_cost
      FROM shadow_candidate_outcomes`);
  const s = shadow.rows[0]!;

  const observations = await query(`${OBSERVATIONS_SQL}
    SELECT count(*)::text AS total,
           (SELECT count(*)::text FROM (
              SELECT ${OBSERVATION_KEY} FROM observation
               GROUP BY ${OBSERVATION_KEY} HAVING count(*) > 1) dup) AS duplicates,
           (SELECT count(*)::text FROM (
              SELECT ${OBSERVATION_KEY} FROM observation
               GROUP BY ${OBSERVATION_KEY}
              HAVING count(*) > 1 AND count(DISTINCT outcome) > 1) conflict) AS conflicts
      FROM observation`);
  const o = observations.rows[0]!;

  const unguarded = await query(`${UNGUARDED_OBSERVATIONS_SQL}
    SELECT count(*)::text AS total,
           (SELECT count(*)::text FROM (
              SELECT ${OBSERVATION_KEY} FROM observation
               GROUP BY ${OBSERVATION_KEY} HAVING count(*) > 1) dup) AS duplicates,
           (SELECT count(*)::text FROM (
              SELECT ${OBSERVATION_KEY} FROM observation
               GROUP BY ${OBSERVATION_KEY}
              HAVING count(*) > 1 AND count(DISTINCT outcome) > 1) conflict) AS conflicts
      FROM observation`);
  const u = unguarded.rows[0]!;

  const pairs = await query(`
    WITH pair AS (
      SELECT pair_id,
             count(*) FILTER (WHERE status='resolved') AS resolved_arms,
             count(*) FILTER (WHERE executed) AS executed_arms
        FROM momentum_inversion_arms GROUP BY pair_id)
    SELECT count(*)::text AS pairs,
           count(*) FILTER (WHERE resolved_arms = 2)::text AS complete,
           count(*) FILTER (WHERE executed_arms = 1)::text AS with_execution,
           count(*) FILTER (WHERE executed_arms > 1)::text AS multi_executed
      FROM pair`);
  const p = pairs.rows[0]!;

  return {
    trades: number(t.trades),
    multiStrategyTrades: number(t.multi),
    closedTrades: number(t.closed),
    tradesLinkedToEvaluation: number(t.linked),
    evaluations: number(e.evaluations),
    validNonExecutedCandidates: number(e.valid_non_executed),
    evaluationsFlaggedCreated: number(e.flagged_created),
    evaluationsMarkedSelected: number(e.marked_selected),
    shadowOutcomes: number(s.total),
    liveShadowOutcomes: number(s.live),
    supersededShadowOutcomes: number(s.superseded),
    adaptiveObservations: number(o.total),
    duplicateOpportunities: number(o.duplicates),
    conflictingOutcomes: number(o.conflicts),
    unguardedObservations: number(u.total),
    unguardedDuplicates: number(u.duplicates),
    unguardedConflicts: number(u.conflicts),
    newsTagged: number(t.news_tagged),
    newsNotEvaluatedStatus: number(t.news_not_evaluated),
    newsFalseNoNews: number(t.false_no_news),
    newsEvaluationStateSet: number(t.news_state_set),
    newsInsufficientCalendarData: number(t.news_insufficient),
    resolvedTrades: number(t.resolved),
    tradesWithSpreadCostR: number(t.with_spread_cost),
    tradesWithNetResultR: number(t.with_net),
    tradesWithGrossResultR: number(t.with_gross),
    tradesWithUnknownCost: number(t.unknown_cost),
    shadowWithSpreadCostR: number(s.with_spread_cost),
    momentumPairs: number(p.pairs),
    momentumCompletePairs: number(p.complete),
    momentumPairsWithExecution: number(p.with_execution),
    momentumPairsMultiExecuted: number(p.multi_executed),
  };
}

export interface IntegrityViolation {
  invariant: string;
  count: number;
  detail: string;
}

/**
 * Every evidence invariant, checked against the live database.
 *
 * An empty array is the system being trustworthy. Each entry names the
 * invariant, how many rows break it, and what that means — so a failure is
 * actionable rather than just red.
 */
export async function integrityViolations(): Promise<IntegrityViolation[]> {
  const violations: IntegrityViolation[] = [];
  const add = async (invariant: string, detail: string, sql: string) => {
    const rows = await query<{ count: string }>(sql);
    const count = number(rows.rows[0]?.count);
    if (count > 0) violations.push({ invariant, count, detail });
  };

  // EXECUTED CANDIDATE INVARIANT.
  // An opportunity that produced a real trade must not also be sitting in the
  // evidence as a hypothetical. Checked against the trade ledger, not against
  // execution_status, because that column is what drifted.
  await add(
    "executed_candidate",
    "evaluations that produced a real trade but are still filed as suppressed/blocked",
    `SELECT count(*)::text AS count FROM paper_strategy_evaluations e
      WHERE e.execution_status IN ('suppressed','blocked')
        AND EXISTS (SELECT 1 FROM paper_strategy_trades t
                     WHERE t.evaluation_id = e.id
                        OR (t.instrument = e.instrument AND t.decision_time = e.decision_time
                            AND t.strategy_family = e.strategy_family))`);

  await add(
    "executed_candidate_shadow",
    "live (non-superseded) shadow outcomes belonging to an opportunity that really traded",
    `SELECT count(*)::text AS count FROM shadow_candidate_outcomes s
      JOIN paper_strategy_evaluations e ON e.id = s.evaluation_id
     WHERE s.superseded_by_trade_id IS NULL
       AND EXISTS (SELECT 1 FROM paper_strategy_trades t
                    WHERE t.evaluation_id = e.id
                       OR (t.instrument = e.instrument AND t.decision_time = e.decision_time
                           AND t.strategy_family = e.strategy_family))`);

  // UNIQUE OBSERVATION INVARIANT.
  await add(
    "unique_observation",
    "opportunity+arm keys appearing more than once in the evidence the engine reads",
    `${OBSERVATIONS_SQL}
     SELECT count(*)::text AS count FROM (
       SELECT ${OBSERVATION_KEY} FROM observation
        GROUP BY ${OBSERVATION_KEY} HAVING count(*) > 1) duplicates`);

  // The same invariant with NO read-time guard. The loader's exclusions and the
  // repair fix the same defect from two ends; only this check proves the ROWS
  // are clean rather than the query being careful on their behalf.
  await add(
    "unique_observation_unguarded",
    "opportunity+arm keys duplicated in the underlying tables, before any read-time guard",
    `${UNGUARDED_OBSERVATIONS_SQL}
     SELECT count(*)::text AS count FROM (
       SELECT ${OBSERVATION_KEY} FROM observation
        GROUP BY ${OBSERVATION_KEY} HAVING count(*) > 1) duplicates`);

  // OUTCOME INVARIANT.
  await add(
    "outcome_conflict",
    "opportunity+arm keys whose duplicate observations disagree on the outcome",
    `${OBSERVATIONS_SQL}
     SELECT count(*)::text AS count FROM (
       SELECT ${OBSERVATION_KEY} FROM observation
        GROUP BY ${OBSERVATION_KEY}
       HAVING count(*) > 1 AND count(DISTINCT outcome) > 1) conflicts`);

  await add(
    "outcome_source_purity",
    "momentum arms whose outcome_source contradicts whether they were executed",
    `SELECT count(*)::text AS count FROM momentum_inversion_arms
      WHERE status = 'resolved'
        AND ((executed AND outcome_source <> 'executed') OR (NOT executed AND outcome_source <> 'shadow'))`);

  // MOMENTUM PAIRING INVARIANT.
  await add(
    "momentum_pair_arms",
    "momentum pairs that do not hold exactly one original and one inverted arm",
    `SELECT count(*)::text AS count FROM (
       SELECT pair_id FROM momentum_inversion_arms
        GROUP BY pair_id
       HAVING count(*) <> 2 OR count(DISTINCT arm) <> 2) bad`);

  await add(
    "momentum_single_execution",
    "momentum pairs with more than one arm marked executed",
    `SELECT count(*)::text AS count FROM (
       SELECT pair_id FROM momentum_inversion_arms
        GROUP BY pair_id HAVING count(*) FILTER (WHERE executed) > 1) bad`);

  await add(
    "momentum_pair_identity",
    "momentum pairs whose two arms disagree about the opportunity they came from",
    `SELECT count(*)::text AS count FROM (
       SELECT pair_id FROM momentum_inversion_arms
        GROUP BY pair_id
       HAVING count(DISTINCT instrument) > 1
           OR count(DISTINCT decision_time) > 1
           OR count(DISTINCT config_version) > 1
           OR count(DISTINCT direction) <> count(*)) bad`);

  // NEWS INVARIANT.
  await add(
    "news_no_data_is_not_no_news",
    "trades tagged NO_NEWS with no stored calendar event within a day of the trade",
    `SELECT count(*)::text AS count FROM paper_strategy_trades t
      WHERE t.news_impact_tag = 'NO_NEWS'
        AND NOT EXISTS (SELECT 1 FROM economic_calendar_events c
                         WHERE c.event_time BETWEEN COALESCE(t.opened_at, t.decision_time) - interval '1 day'
                                                AND COALESCE(t.opened_at, t.decision_time) + interval '1 day')`);

  await add(
    "news_gate_recorded",
    "multi-strategy trades whose news_status contradicts the News condition stored beside it",
    `SELECT count(*)::text AS count FROM paper_strategy_trades t
      WHERE t.strategy_family IS NOT NULL
        AND t.news_status = 'not_evaluated'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.conditions) c
                     WHERE c->>'name' = 'News' AND c->>'currentValue' NOT IN ('not evaluated','not_evaluated'))`);

  // COST INVARIANT.
  await add(
    "cost_identity",
    "resolved trades where net_result_r <> gross_result_r - total_cost_r",
    `SELECT count(*)::text AS count FROM paper_strategy_trades
      WHERE net_result_r IS NOT NULL AND gross_result_r IS NOT NULL AND total_cost_r IS NOT NULL
        AND abs(net_result_r - (gross_result_r - total_cost_r)) > 1e-9`);

  await add(
    "cost_net_matches_result",
    "resolved trades whose net_result_r has drifted from the result_r it is derived from",
    `SELECT count(*)::text AS count FROM paper_strategy_trades
      WHERE result_r IS NOT NULL AND net_result_r IS NOT NULL
        AND abs(net_result_r - result_r) > 1e-9`);

  await add(
    "cost_coverage",
    "resolved trades with a usable spread that still carry no spread_cost_r",
    `SELECT count(*)::text AS count FROM paper_strategy_trades
      WHERE result_r IS NOT NULL AND spread_cost_r IS NULL
        AND spread_pips IS NOT NULL AND entry IS NOT NULL AND stop IS NOT NULL AND entry <> stop`);

  await add(
    "cost_sign",
    "trades with a negative transaction cost (friction can only ever be paid)",
    `SELECT count(*)::text AS count FROM paper_strategy_trades
      WHERE spread_cost_r < 0 OR total_cost_r < 0`);

  // LINKAGE INVARIANT.
  await add(
    "evaluation_link_unique",
    "evaluations claimed by more than one trade",
    `SELECT count(*)::text AS count FROM (
       SELECT evaluation_id FROM paper_strategy_trades
        WHERE evaluation_id IS NOT NULL GROUP BY evaluation_id HAVING count(*) > 1) bad`);

  await add(
    "evaluation_link_consistent",
    "trades whose evaluation_id points at a different instrument, bar or strategy version",
    `SELECT count(*)::text AS count FROM paper_strategy_trades t
      JOIN paper_strategy_evaluations e ON e.id = t.evaluation_id
     WHERE e.instrument <> t.instrument
        OR e.decision_time <> t.decision_time
        OR e.strategy_version_id <> t.strategy_version_id`);

  // TIMEZONE INVARIANT.
  await add(
    "timestamp_order",
    "trades whose close precedes their open, or whose open precedes their decision",
    `SELECT count(*)::text AS count FROM paper_strategy_trades
      WHERE (closed_at IS NOT NULL AND closed_at < opened_at) OR opened_at < decision_time`);

  // RESOLUTION INVARIANT.
  await add(
    "resolved_stays_resolved",
    "trades marked closed that have lost their result",
    `SELECT count(*)::text AS count FROM paper_strategy_trades
      WHERE status = 'closed' AND (result_r IS NULL OR closed_at IS NULL OR exit IS NULL)`);

  return violations;
}

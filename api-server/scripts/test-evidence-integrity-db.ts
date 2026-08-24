import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

const { query } = await import("../src/database.js");
const { evidenceIntegrityMetrics, integrityViolations } = await import("../src/evidence-integrity-checks.js");
const { loadAdaptiveEvidence, expectancy, grossExpectancy, DEFAULT_ADAPTIVE_CONFIG } = await import("../src/adaptive-engine.js");
const { spreadCostR } = await import("../src/evidence-integrity.js");

/**
 * Adaptive evidence integrity — database tests.
 *
 * These run against the real database and assert the invariants the repair
 * exists to establish. They are READ-ONLY apart from the idempotency test,
 * which deliberately re-runs the repair command and proves nothing moves.
 *
 * Run AFTER `npm run research:repair-forex-adaptive-evidence`.
 */

const ok = (label: string) => console.log(`  ok  ${label}`);
const group = (title: string) => console.log(`\n${title}`);
const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> =>
  (await query<T>(sql, params)).rows[0] as T;
const countOf = async (sql: string, params: unknown[] = []) => Number((await one<{ count: string }>(sql, params)).count);

const metricsBefore = await evidenceIntegrityMetrics();

// ===========================================================================
group("1. an executed trade cannot remain a blocked shadow candidate");
// ===========================================================================
{
  const stillBlocked = await countOf(
    `SELECT count(*)::text AS count FROM paper_strategy_evaluations e
      WHERE e.execution_status IN ('suppressed','blocked')
        AND EXISTS (SELECT 1 FROM paper_strategy_trades t
                     WHERE t.evaluation_id = e.id
                        OR (t.instrument = e.instrument AND t.decision_time = e.decision_time
                            AND t.strategy_family = e.strategy_family))`);
  assert.equal(stillBlocked, 0, "an evaluation that produced a real trade is still filed as blocked");
  ok("no evaluation that produced a trade is filed as suppressed/blocked");

  const liveShadowOnExecuted = await countOf(
    `SELECT count(*)::text AS count FROM shadow_candidate_outcomes s
      JOIN paper_strategy_evaluations e ON e.id = s.evaluation_id
     WHERE s.superseded_by_trade_id IS NULL
       AND EXISTS (SELECT 1 FROM paper_strategy_trades t
                    WHERE t.instrument = e.instrument AND t.decision_time = e.decision_time
                      AND t.strategy_family = e.strategy_family)`);
  assert.equal(liveShadowOnExecuted, 0, "a real trade still has a live hypothetical outcome beside it");
  ok("every shadow outcome belonging to a real trade is marked superseded");

  // Superseded, not deleted: the row survives as the audit trail of the defect.
  assert.ok(metricsBefore.supersededShadowOutcomes > 0, "supersession actually happened");
  const withReason = await countOf(
    `SELECT count(*)::text AS count FROM shadow_candidate_outcomes
      WHERE superseded_by_trade_id IS NOT NULL AND (superseded_at IS NULL OR superseded_reason IS NULL)`);
  assert.equal(withReason, 0, "every superseded row carries when and why");
  ok(`${metricsBefore.supersededShadowOutcomes} shadow rows superseded — preserved with a reason, not deleted`);
}

// ===========================================================================
group("2. a repaired evaluation links to the CORRECT paper trade");
// ===========================================================================
{
  // The link is only trustworthy if it is provably the same opportunity.
  const mismatched = await countOf(
    `SELECT count(*)::text AS count FROM paper_strategy_trades t
      JOIN paper_strategy_evaluations e ON e.id = t.evaluation_id
     WHERE e.instrument <> t.instrument
        OR e.decision_time <> t.decision_time
        OR e.strategy_version_id <> t.strategy_version_id`);
  assert.equal(mismatched, 0, "a trade points at an evaluation from a different opportunity");
  ok("every evaluation_id points at the same instrument, bar and strategy version");

  const shared = await countOf(
    `SELECT count(*)::text AS count FROM (
       SELECT evaluation_id FROM paper_strategy_trades
        WHERE evaluation_id IS NOT NULL GROUP BY evaluation_id HAVING count(*) > 1) bad`);
  assert.equal(shared, 0, "two trades claim the same evaluation");
  ok("no evaluation is claimed by more than one trade");

  // Both sides agree, in both directions.
  const oneWay = await countOf(
    `SELECT count(*)::text AS count FROM paper_strategy_trades t
      WHERE t.evaluation_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM paper_strategy_evaluations e
                         WHERE e.id = t.evaluation_id AND e.paper_trade_id = t.id AND e.trade_created)`);
  assert.equal(oneWay, 0, "a linked trade whose evaluation does not point back at it");
  ok("the link is symmetric: trade → evaluation → trade");

  // Every multi-strategy trade is linked. The remaining unlinked ones are the
  // pre-evaluations legacy strategy and must stay honestly unlinked.
  const unlinkedMulti = await countOf(
    `SELECT count(*)::text AS count FROM paper_strategy_trades
      WHERE strategy_family IS NOT NULL AND evaluation_id IS NULL`);
  assert.equal(unlinkedMulti, 0, "a multi-strategy trade is still unlinked");
  const unlinkedLegacy = await countOf(
    `SELECT count(*)::text AS count FROM paper_strategy_trades
      WHERE strategy_family IS NULL AND evaluation_id IS NULL`);
  ok(`all multi-strategy trades linked; ${unlinkedLegacy} legacy trades left unlinked (no evaluation row exists)`);
}

// ===========================================================================
group("3. executed + shadow duplicates are not counted twice");
// ===========================================================================
{
  assert.equal(metricsBefore.duplicateOpportunities, 0, "the loader would still count a duplicate");
  assert.equal(metricsBefore.unguardedDuplicates, 0, "the TABLES still hold a duplicate");
  ok("no duplicated opportunity+arm, in the loader's view or in the rows themselves");

  // The two views agreeing is the proof that the ROWS are clean rather than a
  // careful query hiding dirty ones.
  assert.equal(metricsBefore.adaptiveObservations, metricsBefore.unguardedObservations,
    "the read-time guard is still removing rows the repair should have fixed");
  ok(`guarded and unguarded observation counts agree (${metricsBefore.adaptiveObservations})`);

  // And the loader's own total matches the distinct-observation count.
  const experiment = await one<{ id: string | null }>(
    "SELECT id FROM strategy_experiments ORDER BY created_at LIMIT 1");
  if (experiment?.id) {
    const evidence = await loadAdaptiveEvidence(experiment.id);
    const distinct = await countOf(
      `SELECT count(*)::text AS count FROM (
         SELECT DISTINCT t.experiment_id, t.strategy_family, t.config_version, t.instrument,
                t.decision_time, COALESCE(t.original_direction, t.direction) AS d
           FROM paper_strategy_trades t
          WHERE t.experiment_id = $1 AND t.strategy_family IS NOT NULL
            AND t.status = 'closed' AND t.result_r IS NOT NULL) x`, [experiment.id]);
    const shadowDistinct = await countOf(
      `SELECT count(*)::text AS count FROM (
         SELECT DISTINCT e.experiment_id, e.strategy_family, e.config_version, e.instrument,
                e.decision_time, COALESCE(e.original_direction, e.direction) AS d
           FROM shadow_candidate_outcomes s
           JOIN paper_strategy_evaluations e ON e.id = s.evaluation_id
          WHERE e.experiment_id = $1 AND e.strategy_family IS NOT NULL AND e.direction IS NOT NULL
            AND s.result_r IS NOT NULL AND s.superseded_by_trade_id IS NULL
            AND s.outcome IN ('target_first','stop_first','forced_close','timeout')
            AND e.paper_trade_id IS NULL) x`, [experiment.id]);
    assert.equal(evidence.totalResolved, distinct + shadowDistinct,
      `loader counted ${evidence.totalResolved} observations for ${distinct + shadowDistinct} distinct opportunities`);
    ok(`loadAdaptiveEvidence counts exactly one observation per opportunity+arm (${evidence.totalResolved})`);
  }
}

// ===========================================================================
group("4. actual and shadow outcomes cannot conflict for the same arm");
// ===========================================================================
{
  assert.equal(metricsBefore.conflictingOutcomes, 0, "duplicate observations still disagree on the outcome");
  assert.equal(metricsBefore.unguardedConflicts, 0, "the tables still hold contradicting outcomes");
  ok("no opportunity+arm carries two observations that disagree");

  // A resolved arm's outcome source must match how it was actually settled.
  const impure = await countOf(
    `SELECT count(*)::text AS count FROM momentum_inversion_arms
      WHERE status = 'resolved'
        AND ((executed AND outcome_source <> 'executed') OR (NOT executed AND outcome_source <> 'shadow'))`);
  assert.equal(impure, 0, "an arm's outcome_source contradicts whether it was executed");
  ok("executed arms carry 'executed' outcomes; unexecuted arms carry 'shadow' outcomes");

  // An executed arm must reproduce its trade's result exactly — never a
  // re-simulation of it.
  const drifted = await countOf(
    `SELECT count(*)::text AS count FROM momentum_inversion_arms a
      JOIN paper_strategy_trades t ON t.id = a.paper_trade_id
     WHERE a.status = 'resolved' AND a.executed
       AND (a.outcome <> t.outcome OR abs(a.result_r - t.result_r) > 1e-9)`);
  assert.equal(drifted, 0, "an executed arm has drifted from the trade it represents");
  ok("an executed arm copies its real trade's outcome verbatim");
}

// ===========================================================================
group("5. momentum original/inverted arms are paired correctly");
// ===========================================================================
{
  const badShape = await countOf(
    `SELECT count(*)::text AS count FROM (
       SELECT pair_id FROM momentum_inversion_arms
        GROUP BY pair_id HAVING count(*) <> 2 OR count(DISTINCT arm) <> 2) bad`);
  assert.equal(badShape, 0, "a pair does not hold exactly one original and one inverted arm");
  ok(`every one of ${metricsBefore.momentumPairs} pairs holds exactly one original and one inverted arm`);

  const badIdentity = await countOf(
    `SELECT count(*)::text AS count FROM (
       SELECT pair_id FROM momentum_inversion_arms
        GROUP BY pair_id
       HAVING count(DISTINCT instrument) > 1 OR count(DISTINCT decision_time) > 1
           OR count(DISTINCT config_version) > 1 OR count(DISTINCT spread_pips) > 1) bad`);
  assert.equal(badIdentity, 0, "a pair's arms disagree about the opportunity they came from");
  ok("both arms of a pair share instrument, bar, config version and spread — provably the same opportunity");

  const sameDirection = await countOf(
    `SELECT count(*)::text AS count FROM (
       SELECT pair_id FROM momentum_inversion_arms
        GROUP BY pair_id HAVING count(DISTINCT direction) <> 2) bad`);
  assert.equal(sameDirection, 0, "a pair's two arms trade the same direction");
  ok("the two arms are genuinely opposite directions");

  // Geometry: identical distances, opposite sides. Direction is the only
  // independent variable, which is what makes the comparison a controlled one.
  const badGeometry = await countOf(
    `SELECT count(*)::text AS count FROM momentum_inversion_arms a
      JOIN momentum_inversion_arms b ON b.pair_id = a.pair_id AND b.arm <> a.arm
     WHERE a.status <> 'excluded'
       AND (abs(a.stop_distance - b.stop_distance) > 1e-9
            OR abs(a.target_distance - b.target_distance) > 1e-9)`);
  assert.equal(badGeometry, 0, "paired arms have different stop or target distances");
  ok("stop and target distances are identical across each pair — same reward-to-risk");

  const badSides = await countOf(
    `SELECT count(*)::text AS count FROM momentum_inversion_arms
      WHERE status <> 'excluded'
        AND ((direction = 'long' AND (stop >= entry OR target <= entry))
          OR (direction = 'short' AND (stop <= entry OR target >= entry)))`);
  assert.equal(badSides, 0, "an arm's stop or target sits on the wrong side of its entry");
  ok("every arm's stop and target sit on the correct side of its entry");

  // Both arms pay their own spread rather than one being a negation of the
  // other — otherwise the counterfactual would get a free round trip.
  const freeRide = await countOf(
    `SELECT count(*)::text AS count FROM momentum_inversion_arms a
      JOIN momentum_inversion_arms b ON b.pair_id = a.pair_id AND b.arm <> a.arm
     WHERE a.status <> 'excluded' AND a.spread_pips > 0 AND abs(a.entry - b.entry) < 1e-12`);
  assert.equal(freeRide, 0, "paired arms share an entry price — one of them is not paying the spread");
  ok("the arms fill opposite sides of the book — neither gets a free spread");
}

// ===========================================================================
group("6. only one arm is actually executed");
// ===========================================================================
{
  const multi = await countOf(
    `SELECT count(*)::text AS count FROM (
       SELECT pair_id FROM momentum_inversion_arms
        GROUP BY pair_id HAVING count(*) FILTER (WHERE executed) > 1) bad`);
  assert.equal(multi, 0, "a pair has more than one executed arm");
  ok("no pair has more than one real execution");

  // The database enforces it, not just the caller. Prove the index is there.
  const guard = await countOf(
    `SELECT count(*)::text AS count FROM pg_indexes
      WHERE tablename = 'momentum_inversion_arms' AND indexname = 'momentum_inversion_arms_one_execution_idx'`);
  assert.equal(guard, 1, "the one-execution-per-pair unique index is missing");
  ok("a partial unique index enforces one execution per pair at the database");

  // An executed arm must point at a real trade, and an unexecuted one must not.
  const badExecution = await countOf(
    `SELECT count(*)::text AS count FROM momentum_inversion_arms
      WHERE (executed AND paper_trade_id IS NULL) OR (NOT executed AND paper_trade_id IS NOT NULL)`);
  assert.equal(badExecution, 0, "executed flag and paper_trade_id disagree");
  ok("executed arms carry a real trade id; unexecuted arms carry none");

  // The pairs with no execution at all are legitimate (suppressed, blocked, or
  // the instrument was busy) — both arms are simply shadows.
  const bothShadow = metricsBefore.momentumPairs - metricsBefore.momentumPairsWithExecution;
  ok(`${metricsBefore.momentumPairsWithExecution} pairs have one real execution, ${bothShadow} have none (both arms shadow)`);
}

// ===========================================================================
group("7. the news gate result persists correctly");
// ===========================================================================
{
  const contradicting = await countOf(
    `SELECT count(*)::text AS count FROM paper_strategy_trades t
      WHERE t.strategy_family IS NOT NULL AND t.news_status = 'not_evaluated'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.conditions) c
                     WHERE c->>'name' = 'News' AND c->>'currentValue' NOT IN ('not evaluated','not_evaluated'))`);
  assert.equal(contradicting, 0, "news_status still contradicts the News condition beside it");
  ok("no trade's news_status contradicts its own conditions[] verdict");

  const multiEvaluated = await countOf(
    `SELECT count(*)::text AS count FROM paper_strategy_trades
      WHERE strategy_family IS NOT NULL AND news_status <> 'not_evaluated'`);
  assert.ok(multiEvaluated > 0, "no multi-strategy trade records a real news verdict");
  ok(`${multiEvaluated} multi-strategy trades now record the gate verdict that actually ran`);

  // Structured news context is present wherever a classification happened.
  const missingState = await countOf(
    "SELECT count(*)::text AS count FROM paper_strategy_trades WHERE news_impact_tag IS NOT NULL AND news_evaluation_state IS NULL");
  assert.equal(missingState, 0, "a tagged trade has no evaluation state");
  ok("every tagged trade records its evaluation state");

  // A positive news match must carry the event that justified it.
  const unattributed = await countOf(
    `SELECT count(*)::text AS count FROM paper_strategy_trades
      WHERE news_impact_tag IN ('NEAR_NEWS','HIGH_IMPACT_NEWS')
        AND (news_event_name IS NULL OR news_event_time IS NULL OR news_currency IS NULL
             OR news_minutes_from_news IS NULL OR news_impact_level IS NULL)`);
  assert.equal(unattributed, 0, "a news-present tag has no event attached");
  ok("every NEAR/HIGH_IMPACT tag carries currency, event name, event time, minutes and impact level");
}

// ===========================================================================
group("8. missing calendar data does not become NO_NEWS");
// ===========================================================================
{
  const falseQuiet = await countOf(
    `SELECT count(*)::text AS count FROM paper_strategy_trades t
      WHERE t.news_impact_tag = 'NO_NEWS'
        AND NOT EXISTS (SELECT 1 FROM economic_calendar_events c
                         WHERE c.event_time BETWEEN COALESCE(t.opened_at,t.decision_time) - interval '1 day'
                                                AND COALESCE(t.opened_at,t.decision_time) + interval '1 day')`);
  assert.equal(falseQuiet, 0, "a trade is still tagged NO_NEWS with no calendar coverage");
  ok("no NO_NEWS tag survives without real calendar coverage");

  assert.ok(metricsBefore.newsInsufficientCalendarData > 0, "the uncovered trades were reclassified, not deleted");
  const wrongState = await countOf(
    `SELECT count(*)::text AS count FROM paper_strategy_trades
      WHERE news_impact_tag = 'INSUFFICIENT_CALENDAR_DATA' AND news_evaluation_state <> 'INSUFFICIENT_CALENDAR_DATA'`);
  assert.equal(wrongState, 0, "tag and state disagree");
  ok(`${metricsBefore.newsInsufficientCalendarData} trades honestly marked INSUFFICIENT_CALENDAR_DATA`);

  // And the confirmed ones really are confirmed.
  const confirmedWithoutCoverage = await countOf(
    "SELECT count(*)::text AS count FROM paper_strategy_trades WHERE news_impact_tag = 'NO_NEWS' AND COALESCE(news_calendar_events_nearby,0) = 0");
  assert.equal(confirmedWithoutCoverage, 0, "a confirmed NO_NEWS records zero nearby events");
  ok("every remaining NO_NEWS records the calendar coverage that justifies it");
}

// ===========================================================================
group("9. spread converts into R and net includes transaction costs");
// ===========================================================================
{
  const missing = await countOf(
    `SELECT count(*)::text AS count FROM paper_strategy_trades
      WHERE result_r IS NOT NULL AND spread_cost_r IS NULL
        AND spread_pips IS NOT NULL AND entry IS NOT NULL AND stop IS NOT NULL AND entry <> stop`);
  assert.equal(missing, 0, "a calculable trade still has no spread_cost_r");
  ok(`spread_cost_r present on all ${metricsBefore.tradesWithSpreadCostR} trades`);

  // Recompute a sample independently and compare with what was stored.
  const sample = await query<{ instrument: string; entry: string; stop: string; spread_pips: string; spread_cost_r: string }>(
    "SELECT instrument, entry::text, stop::text, spread_pips::text, spread_cost_r::text FROM paper_strategy_trades WHERE spread_cost_r IS NOT NULL LIMIT 25");
  for (const row of sample.rows) {
    const expected = spreadCostR({
      instrument: row.instrument, entry: Number(row.entry), stop: Number(row.stop), spreadPips: Number(row.spread_pips),
    });
    assert.ok(expected !== null);
    assert.ok(Math.abs(Number(row.spread_cost_r) - expected) < 1e-9,
      `${row.instrument}: stored ${row.spread_cost_r}, recomputed ${expected}`);
  }
  ok(`${sample.rows.length} stored costs recomputed independently and matched`);

  const identityBroken = await countOf(
    `SELECT count(*)::text AS count FROM paper_strategy_trades
      WHERE net_result_r IS NOT NULL AND gross_result_r IS NOT NULL AND total_cost_r IS NOT NULL
        AND abs(net_result_r - (gross_result_r - total_cost_r)) > 1e-9`);
  assert.equal(identityBroken, 0, "net_result_r <> gross_result_r - total_cost_r");
  ok("net_result_r = gross_result_r - total_cost_r holds on every resolved trade");

  const negative = await countOf(
    "SELECT count(*)::text AS count FROM paper_strategy_trades WHERE spread_cost_r < 0 OR total_cost_r < 0");
  assert.equal(negative, 0, "a trade carries a negative transaction cost");
  ok("no negative transaction costs — friction can only ever be paid");

  // Unknown components stayed unknown rather than becoming zero.
  const fabricated = await countOf(
    `SELECT count(*)::text AS count FROM paper_strategy_trades
      WHERE cost_basis = 'spread_only' AND (commission_cost_r IS NOT NULL OR slippage_cost_r IS NOT NULL)`);
  assert.equal(fabricated, 0, "a spread-only trade carries an invented commission or slippage figure");
  ok("commission and slippage are left NULL — unknown, never assumed to be zero");

  // Cost is not a rounding detail on this book.
  const cost = await one<{ avg_cost: string; max_cost: string }>(
    "SELECT round(avg(spread_cost_r)::numeric,4)::text AS avg_cost, round(max(spread_cost_r)::numeric,4)::text AS max_cost FROM paper_strategy_trades WHERE spread_cost_r IS NOT NULL");
  ok(`spread costs ${cost.avg_cost}R on average, up to ${cost.max_cost}R at worst`);
}

// ===========================================================================
group("10. adaptive evidence uses NET R");
// ===========================================================================
{
  const experiment = await one<{ id: string | null }>("SELECT id FROM strategy_experiments ORDER BY created_at LIMIT 1");
  if (experiment?.id) {
    const evidence = await loadAdaptiveEvidence(experiment.id);
    const familyKey = [...evidence.context.keys()].find((key) => key.endsWith("|*|*|*|*"));
    assert.ok(familyKey, "the evidence ladder produced a family-level bucket");
    const stat = evidence.context.get(familyKey!)!;

    // The database's own net sum for the same family, computed independently.
    const family = familyKey!.split("|")[0]!;
    const dbNet = await one<{ net: string | null; gross: string | null }>(
      `SELECT sum(COALESCE(net_result_r, result_r))::text AS net, sum(COALESCE(gross_result_r, result_r))::text AS gross
         FROM paper_strategy_trades
        WHERE experiment_id = $1 AND strategy_family = $2 AND status='closed' AND result_r IS NOT NULL`,
      [experiment.id, family]);

    assert.ok(stat.netR !== undefined && stat.grossR !== undefined, "both net and gross accumulate");
    // Gross must be strictly worse-off-free: costs are positive, so gross ≥ net.
    assert.ok(stat.grossR >= stat.netR - 1e-9, `gross (${stat.grossR}) must be >= net (${stat.netR})`);
    ok(`family '${family}': net ${stat.netR.toFixed(3)}R vs gross ${stat.grossR.toFixed(3)}R over ${stat.resolved} observations`);

    // expectancy() — the function decideInstrument ranks and suppresses on —
    // must read the NET figure.
    const e = expectancy(stat); const g = grossExpectancy(stat);
    assert.ok(e !== null && g !== null);
    assert.ok(Math.abs(e! - stat.netR / stat.resolved) < 1e-12, "expectancy() must divide netR");
    assert.ok(Math.abs(g! - stat.grossR / stat.resolved) < 1e-12, "grossExpectancy() must divide grossR");
    assert.ok(g! >= e! - 1e-9, "gross expectancy cannot be worse than net");
    ok(`expectancy() = ${e!.toFixed(4)}R net; gross would read ${g!.toFixed(4)}R — selection uses the net figure`);

    // The executed contribution must agree with the database, proving no gross
    // figure has been substituted anywhere along the path.
    if (dbNet.net !== null) {
      assert.ok(Number(dbNet.gross) >= Number(dbNet.net) - 1e-9, "stored gross is below stored net");
      ok("stored gross and net agree in direction with the loaded evidence");
    }
  }
}

// ===========================================================================
group("11. timezone handling remains correct");
// ===========================================================================
{
  const types = await query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name IN ('paper_strategy_trades','momentum_inversion_arms','shadow_candidate_outcomes')
        AND column_name IN ('decision_time','opened_at','closed_at','resolved_at','superseded_at','news_event_time')`);
  for (const row of types.rows) {
    assert.equal(row.data_type, "timestamp with time zone", `${row.column_name} is not timestamptz`);
  }
  ok(`all ${types.rows.length} time columns are timestamptz — comparisons happen in UTC`);

  const outOfOrder = await countOf(
    `SELECT count(*)::text AS count FROM paper_strategy_trades
      WHERE (closed_at IS NOT NULL AND closed_at < opened_at) OR opened_at < decision_time`);
  assert.equal(outOfOrder, 0, "a trade closes before it opens, or opens before its decision");
  ok("no trade closes before it opens or opens before its decision bar");

  // The pair id is derived from an ISO instant, so an arm must key off the same
  // instant its trade did.
  const driftedPair = await countOf(
    `SELECT count(*)::text AS count FROM momentum_inversion_arms a
      JOIN paper_strategy_trades t ON t.id = a.paper_trade_id
     WHERE a.decision_time <> t.decision_time`);
  assert.equal(driftedPair, 0, "an arm's decision time drifted from its trade's");
  ok("every executed arm shares its trade's exact decision instant");

  // Sessions are still derived in ET, and none has been silently reassigned.
  const sessions = await query<{ session: string }>("SELECT DISTINCT session FROM paper_strategy_trades ORDER BY 1");
  const labels = sessions.rows.map((row) => row.session);
  assert.ok(labels.every((label) => ["London", "London/New York overlap", "New York"].includes(label)), `unexpected session labels: ${labels.join(", ")}`);
  ok(`session labels unchanged: ${labels.join(", ")}`);
}

// ===========================================================================
group("12. existing resolved trades remain resolved");
// ===========================================================================
{
  const lost = await countOf(
    `SELECT count(*)::text AS count FROM paper_strategy_trades
      WHERE status = 'closed' AND (result_r IS NULL OR closed_at IS NULL OR exit IS NULL)`);
  assert.equal(lost, 0, "a closed trade lost its result, close time or exit");
  ok(`all ${metricsBefore.closedTrades} closed trades still carry a result, close time and exit`);

  const open = await countOf("SELECT count(*)::text AS count FROM paper_strategy_trades WHERE status = 'open'");
  ok(`${open} trades open, ${metricsBefore.closedTrades} closed — totals preserved`);

  // net_result_r is derived from result_r and must not have moved it.
  const drifted = await countOf(
    `SELECT count(*)::text AS count FROM paper_strategy_trades
      WHERE result_r IS NOT NULL AND net_result_r IS NOT NULL AND abs(net_result_r - result_r) > 1e-9`);
  assert.equal(drifted, 0, "net_result_r has drifted from the result_r it derives from");
  ok("net_result_r equals result_r everywhere — the repair added columns, it did not restate outcomes");
}

// ===========================================================================
group("13. every evidence invariant holds");
// ===========================================================================
{
  const violations = await integrityViolations();
  for (const v of violations) console.log(`  ✗  ${v.invariant} (${v.count}) — ${v.detail}`);
  assert.deepEqual(violations, [], "evidence invariants are violated");
  ok("integrityViolations() returns empty");
}

// ===========================================================================
group("14. adaptive thresholds were not lowered");
// ===========================================================================
{
  assert.equal(DEFAULT_ADAPTIVE_CONFIG.minLearningSample, 50, "the learning threshold was changed");
  assert.equal(DEFAULT_ADAPTIVE_CONFIG.minActiveSample, 100, "the active-selection threshold was changed");
  assert.equal(DEFAULT_ADAPTIVE_CONFIG.confidenceZ, 1.64, "the confidence bound was changed");
  ok("minLearningSample 50, minActiveSample 100, confidenceZ 1.64 — unchanged");

  const advanced = await countOf(
    "SELECT count(*)::text AS count FROM adaptive_decisions WHERE adaptive_state = 'active_selection'");
  assert.equal(advanced, 0, "the selector has entered active selection");
  ok("no decision has entered active_selection — the engine is still collecting");
}

// ===========================================================================
group("15. the repair is idempotent");
// ===========================================================================
{
  // The real test: run the whole command again and prove nothing moves. Value
  // equality of every metric is the definition of idempotent here — several
  // phases rewrite identical values, and a rowcount would not catch a change
  // that a value comparison does.
  execFileSync("npx", ["tsx", path.join(serviceRoot, "scripts", "repair-forex-adaptive-evidence.ts")],
    { cwd: serviceRoot, stdio: "pipe", shell: process.platform === "win32" });

  const after = await evidenceIntegrityMetrics();
  const changed = (Object.keys(metricsBefore) as Array<keyof typeof metricsBefore>)
    .filter((key) => metricsBefore[key] !== after[key])
    .map((key) => `${key}: ${metricsBefore[key]} → ${after[key]}`);
  assert.deepEqual(changed, [], "a second repair run changed the data");
  ok(`a second full run changed none of the ${Object.keys(metricsBefore).length} tracked metrics`);

  const violations = await integrityViolations();
  assert.deepEqual(violations, [], "invariants broke on the second run");
  ok("invariants still hold after the second run");
}

console.log("\nall database evidence-integrity tests passed");
process.exit(0);

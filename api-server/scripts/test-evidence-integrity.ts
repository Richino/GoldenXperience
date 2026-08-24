import assert from "node:assert/strict";
import {
  buildMomentumArms, classifyNewsPersistence, costIdentityHolds, decomposeCost,
  findDuplicateObservations, momentumPairKey, newsTagIsHonest, observationKey,
  oppositeDirection, armForExecutedDirection, spreadCostR,
} from "../src/evidence-integrity.js";
import { expectancy, grossExpectancy, type BucketStat } from "../src/adaptive-engine.js";
import { applyMomentumInversion } from "../src/momentum-inversion.js";
import { newsStatusFromConditions, evaluateHardGates } from "../../frontend/src/lib/strategy/strategy-common.js";
import type { StrategyCandidate } from "../../frontend/src/lib/strategy/strategy.js";
import type { StrategyCondition } from "../../frontend/src/lib/strategy/types.js";

/**
 * Adaptive evidence integrity — pure tests. No database, no network, no clock.
 *
 * These cover the parts of the repair that are decidable from inputs alone:
 * the cost arithmetic, the news classification rules, what counts as one
 * observation, and the Momentum pairing construction. The invariants that can
 * only be checked against real rows live in test-evidence-integrity-db.ts.
 */

const ok = (label: string) => console.log(`  ok  ${label}`);
const group = (title: string) => console.log(`\n${title}`);

// ===========================================================================
group("spread converts correctly into R");
// ===========================================================================
{
  // EUR_USD, pip 0.0001. A 20-pip stop with a 1.4-pip spread costs 0.07R.
  const cost = spreadCostR({ instrument: "EUR_USD", entry: 1.10014, stop: 1.09814, spreadPips: 1.4 });
  assert.ok(cost !== null);
  assert.ok(Math.abs(cost - 0.07) < 1e-9, `expected 0.07R, got ${cost}`);
  ok("EUR_USD 1.4 pips over a 20-pip stop = 0.07R");

  // The same spread on a 7-pip stop is nearly three times the cost. This is the
  // whole reason cost has to be expressed in R and not in pips: a tight stop
  // makes an identical spread a far larger share of the trade's risk.
  const tight = spreadCostR({ instrument: "EUR_USD", entry: 1.10014, stop: 1.09944, spreadPips: 1.4 });
  assert.ok(tight !== null && Math.abs(tight - 0.2) < 1e-9, `expected 0.20R, got ${tight}`);
  ok("the same 1.4 pips over a 7-pip stop = 0.20R — cost is relative to risk");

  // USD_JPY uses a 0.01 pip. A 20-pip stop is 0.20 in price.
  const jpy = spreadCostR({ instrument: "USD_JPY", entry: 150.014, stop: 149.814, spreadPips: 1.4 });
  assert.ok(jpy !== null && Math.abs(jpy - 0.07) < 1e-9, `expected 0.07R on JPY, got ${jpy}`);
  ok("JPY pip size is honoured (0.01, not 0.0001)");

  // Degenerate inputs return null rather than a plausible-looking number.
  assert.equal(spreadCostR({ instrument: "EUR_USD", entry: 1.1, stop: 1.1, spreadPips: 1.4 }), null, "zero stop distance");
  assert.equal(spreadCostR({ instrument: "EUR_USD", entry: 1.1, stop: 1.09, spreadPips: null }), null, "missing spread");
  assert.equal(spreadCostR({ instrument: "EUR_USD", entry: null, stop: 1.09, spreadPips: 1.4 }), null, "missing entry");
  assert.equal(spreadCostR({ instrument: "EUR_USD", entry: 1.1, stop: 1.09, spreadPips: -1 }), null, "negative spread");
  ok("degenerate inputs return null, never a guess");
}

// ===========================================================================
group("net result includes transaction costs");
// ===========================================================================
{
  const d = decomposeCost({ instrument: "EUR_USD", entry: 1.10014, stop: 1.09814, spreadPips: 1.4, resultR: -1 });
  assert.equal(d.netResultR, -1, "the stored result is already the NET figure");
  assert.ok(Math.abs(d.spreadCostR! - 0.07) < 1e-9);
  assert.ok(Math.abs(d.totalCostR! - 0.07) < 1e-9);
  // Gross is the reconstruction: a -1R stop cost 0.07R of that to friction, so
  // mid-to-mid the same move was -0.93R.
  assert.ok(Math.abs(d.grossResultR! - -0.93) < 1e-9, `expected -0.93 gross, got ${d.grossResultR}`);
  assert.ok(costIdentityHolds(d), "net = gross - total must hold");
  ok("net = gross - total, and gross is reconstructed by adding friction back");

  // A winner: +2R net means +2.07R before the spread was paid.
  const win = decomposeCost({ instrument: "EUR_USD", entry: 1.10014, stop: 1.09814, spreadPips: 1.4, resultR: 2 });
  assert.ok(Math.abs(win.grossResultR! - 2.07) < 1e-9);
  assert.ok(costIdentityHolds(win));
  ok("the identity holds on winners as well as losers");

  // Unknown components stay unknown. Nothing becomes zero by default.
  assert.equal(d.commissionCostR, null, "commission is unknown, not zero");
  assert.equal(d.slippageCostR, null, "slippage is unknown, not zero");
  assert.equal(d.costBasis, "spread_only", "the basis names exactly what is included");
  assert.ok(d.unknownReasons.some((r) => r.startsWith("commission_cost_r")));
  ok("unknown cost components stay NULL and are named, never silently zeroed");

  // When the broker DOES report a component, the basis widens and the total grows.
  const full = decomposeCost({ instrument: "EUR_USD", entry: 1.10014, stop: 1.09814, spreadPips: 1.4, resultR: -1, commissionCostR: 0.01 });
  assert.equal(full.costBasis, "spread_and_broker");
  assert.ok(Math.abs(full.totalCostR! - 0.08) < 1e-9);
  assert.ok(costIdentityHolds(full));
  ok("a reported commission widens cost_basis and the total");

  // An unresolved trade decomposes without inventing a result.
  const open = decomposeCost({ instrument: "EUR_USD", entry: 1.10014, stop: 1.09814, spreadPips: 1.4, resultR: null });
  assert.equal(open.netResultR, null);
  assert.equal(open.grossResultR, null);
  assert.ok(open.spreadCostR !== null, "the cost is known even before the outcome is");
  ok("an unresolved trade has a known cost and an unknown result");
}

// ===========================================================================
group("adaptive evidence ranks on NET R");
// ===========================================================================
{
  // Two families with identical GROSS edge but different friction. Ranking on
  // gross would call them equal; ranking on net prefers the cheaper one — which
  // is the only one that actually keeps money.
  const cheap: BucketStat = { resolved: 100, wins: 50, netR: 10, sumSqR: 400, grossR: 17, mfe: null, mae: null };
  const dear: BucketStat = { resolved: 100, wins: 50, netR: -5, sumSqR: 400, grossR: 17, mfe: null, mae: null };

  assert.equal(grossExpectancy(cheap), grossExpectancy(dear), "identical gross edge");
  assert.ok(expectancy(cheap)! > expectancy(dear)!, "net expectancy separates them");
  assert.ok(expectancy(dear)! < 0, "the expensive one is a net loser despite a positive gross edge");
  ok("expectancy() reads netR; a positive gross edge can still be a net loss");

  // expectancy() is the function decideInstrument ranks and suppresses on, so
  // this is the guarantee that selection is net-of-cost.
  assert.equal(expectancy(cheap), 0.1);
  assert.equal(grossExpectancy(cheap), 0.17);
  assert.notEqual(expectancy(cheap), grossExpectancy(cheap), "gross must never stand in for net");
  ok("gross and net are separately reportable and cannot be confused");
}

// ===========================================================================
group("missing calendar data does not become NO_NEWS");
// ===========================================================================
{
  // The core rule. A NO_NEWS verdict from a calendar that covers nothing is an
  // absence of DATA, and must not be stored as confirmed quiet.
  const noData = classifyNewsPersistence({ classifiedTag: "NO_NEWS", calendarEventsNearby: 0 });
  assert.equal(noData.tag, "INSUFFICIENT_CALENDAR_DATA");
  assert.equal(noData.state, "INSUFFICIENT_CALENDAR_DATA");
  ok("NO_NEWS with zero calendar coverage becomes INSUFFICIENT_CALENDAR_DATA");

  const covered = classifyNewsPersistence({ classifiedTag: "NO_NEWS", calendarEventsNearby: 12 });
  assert.equal(covered.tag, "NO_NEWS");
  assert.equal(covered.state, "EVALUATED");
  ok("NO_NEWS with real coverage stays confirmed NO_NEWS");

  // A positive match proves coverage by itself and is never downgraded.
  for (const tag of ["NEAR_NEWS", "HIGH_IMPACT_NEWS"] as const) {
    const hit = classifyNewsPersistence({ classifiedTag: tag, calendarEventsNearby: 0 });
    assert.equal(hit.tag, tag, `${tag} must never be downgraded`);
    assert.equal(hit.state, "EVALUATED");
  }
  ok("a positive news match is never downgraded — the match itself proves coverage");

  const never = classifyNewsPersistence({ classifiedTag: null, calendarEventsNearby: 40 });
  assert.equal(never.tag, "NOT_EVALUATED");
  assert.equal(never.state, "NOT_EVALUATED");
  ok("a trade that was never classified stays NOT_EVALUATED, not NO_NEWS");

  // Unknown coverage is treated as absent coverage: fail towards honesty.
  assert.equal(classifyNewsPersistence({ classifiedTag: "NO_NEWS", calendarEventsNearby: null }).tag, "INSUFFICIENT_CALENDAR_DATA");
  ok("unknown coverage fails towards INSUFFICIENT_CALENDAR_DATA");

  assert.equal(newsTagIsHonest("NO_NEWS", 0), false, "the invariant catches the dishonest case");
  assert.equal(newsTagIsHonest("NO_NEWS", 3), true);
  assert.equal(newsTagIsHonest("INSUFFICIENT_CALENDAR_DATA", 0), true, "an honest 'no data' tag is fine with no data");
  assert.equal(newsTagIsHonest("HIGH_IMPACT_NEWS", 0), true);
  ok("newsTagIsHonest() flags exactly the NO_NEWS-without-coverage case");
}

// ===========================================================================
group("news gate result persists correctly");
// ===========================================================================
{
  const candles = Array.from({ length: 250 }, (_, i) => ({
    time: new Date(Date.UTC(2026, 7, 20, 0, i)).toISOString(),
    open: 1.1, high: 1.1005, low: 1.0995, close: 1.1, complete: true,
    bid: { open: 1.1, high: 1.1005, low: 1.0995, close: 1.1 },
    ask: { open: 1.1001, high: 1.1006, low: 1.0996, close: 1.1001 },
  })) as never[];

  // 13:15 UTC is inside the London session, so the session gate passes and the
  // News condition is reached rather than short-circuited.
  const at = "2026-08-20T13:15:00.000Z";
  const base = {
    instrument: "EUR_USD", accountBalance: 100_000, accountCurrency: "USD", dataSource: "oanda",
    candles15m: candles, candles1h: candles, candles4h: candles,
    bid: 1.1, ask: 1.10014, spreadPips: 1.4, marketOpen: true,
    evaluatedAt: at,
  } as never as Parameters<typeof evaluateHardGates>[0];

  const clear = evaluateHardGates({ ...base, calendarConnected: true, highImpactNewsWithinMinutes: null }, at, candles, candles, candles);
  assert.equal(clear.newsStatus, "clear");
  assert.equal(newsStatusFromConditions(clear.conditions), "clear", "conditions[] and the structured verdict agree");
  ok("a clear calendar records newsStatus 'clear'");

  const inBuffer = evaluateHardGates({ ...base, calendarConnected: true, highImpactNewsWithinMinutes: 10 }, at, candles, candles, candles);
  assert.equal(inBuffer.newsStatus, "high_impact");
  assert.equal(newsStatusFromConditions(inBuffer.conditions), "high_impact");
  ok("a release inside the buffer records 'high_impact'");

  // The distinction that used to be lost entirely: an unusable calendar and an
  // actual release both made newsClear false, so both were written as
  // "high impact". They are different facts and are now recorded as such.
  const noCalendar = evaluateHardGates({ ...base, calendarConnected: false, highImpactNewsWithinMinutes: null }, at, candles, candles, candles);
  assert.equal(noCalendar.newsStatus, "calendar_unavailable");
  assert.equal(newsStatusFromConditions(noCalendar.conditions), "calendar_unavailable");
  assert.notEqual(noCalendar.newsStatus, inBuffer.newsStatus, "'no calendar' is not the same fact as 'high impact'");
  ok("an unusable calendar is recorded as 'calendar_unavailable', not 'high_impact'");

  // The GATE behaviour must be untouched: it still fails closed on both.
  const newsCondition = (r: ReturnType<typeof evaluateHardGates>) => r.conditions.find((c) => c.name === "News")!;
  assert.equal(newsCondition(clear).passed, true);
  assert.equal(newsCondition(inBuffer).passed, false, "still blocks on a release");
  assert.equal(newsCondition(noCalendar).passed, false, "still fails closed with no calendar");
  assert.equal(newsCondition(noCalendar).required, true);
  ok("the gate still fails closed — only what gets written down improved");

  // Historical rows spelled these differently; the recovery reads them all.
  const legacy = (currentValue: string, reason = ""): StrategyCondition[] =>
    [{ name: "News", passed: true, required: true, reason, currentValue }];
  assert.equal(newsStatusFromConditions(legacy("clear")), "clear");
  assert.equal(newsStatusFromConditions(legacy("high impact", "High-impact release inside the buffer.")), "high_impact");
  assert.equal(newsStatusFromConditions(legacy("high impact", "Economic calendar is unavailable or stale; entries pause.")), "calendar_unavailable");
  assert.equal(newsStatusFromConditions(legacy("not evaluated")), "not_evaluated");
  assert.equal(newsStatusFromConditions([]), null, "no News condition means nothing to recover");
  ok("the recovery reads both the new and the historical spellings");
}

// ===========================================================================
group("one strategy arm + one opportunity = one observation");
// ===========================================================================
{
  const identity = {
    experimentId: "exp", family: "momentum", configVersion: "momentum-cfg-v1",
    instrument: "EUR_USD", decisionTime: "2026-08-20T13:15:00.000Z", strategyDirection: "long",
  };

  // Two spellings of the same instant are the SAME opportunity. A raw string
  // key would have treated them as two and quietly doubled the sample.
  const utc = observationKey(identity);
  const offset = observationKey({ ...identity, decisionTime: "2026-08-20T09:15:00.000-04:00" });
  assert.equal(utc, offset, "the same instant in two timezones is one opportunity");
  ok("timezone handling: identical instants collapse to one observation key");

  // Anything that genuinely differs makes a different observation.
  for (const field of ["experimentId", "family", "configVersion", "instrument", "strategyDirection"] as const) {
    assert.notEqual(observationKey({ ...identity, [field]: "other" }), utc, `${field} must be part of the identity`);
  }
  assert.notEqual(observationKey({ ...identity, decisionTime: "2026-08-20T13:30:00.000Z" }), utc, "a different bar is a different opportunity");
  ok("experiment, family, config, instrument, bar and direction all key the observation");

  // config_version is load-bearing: a parameter change is a different strategy
  // and must not be averaged into the same bucket.
  assert.notEqual(observationKey({ ...identity, configVersion: "momentum-cfg-v2" }), utc);
  ok("a config change starts a new bucket rather than pooling two experiments");
}

// ===========================================================================
group("executed + shadow duplicate is not counted twice");
// ===========================================================================
{
  const opportunity = {
    experimentId: "exp", family: "breakout", configVersion: "breakout-cfg-v1",
    instrument: "GBP_USD", decisionTime: "2026-08-20T13:15:00.000Z", strategyDirection: "short",
  };

  // Exactly the pre-repair shape: the same opportunity present as a real trade
  // AND as a hypothetical, because the evaluation stayed filed as 'blocked'.
  const corrupted = [
    { ...opportunity, source: "executed" },
    { ...opportunity, source: "shadow" },
  ];
  const duplicates = findDuplicateObservations(corrupted);
  assert.equal(duplicates.length, 1, "the collision is detected");
  assert.deepEqual(duplicates[0]!.sources, ["executed", "shadow"]);
  assert.equal(duplicates[0]!.count, 2);
  ok("an executed trade and its own shadow are detected as one duplicated opportunity");

  // After the repair only one arm survives, so there is nothing to collide.
  assert.deepEqual(findDuplicateObservations([{ ...opportunity, source: "executed" }]), []);
  ok("once the shadow is superseded the duplicate disappears");

  // Different arms of the same bar are NOT duplicates — a long and a short are
  // two genuinely different observations.
  assert.deepEqual(findDuplicateObservations([
    { ...opportunity, source: "executed" },
    { ...opportunity, strategyDirection: "long", source: "shadow" },
  ]), [], "opposite directions are different arms, not a duplicate");
  // Nor are two families at the same instrument and bar.
  assert.deepEqual(findDuplicateObservations([
    { ...opportunity, source: "shadow" },
    { ...opportunity, family: "ema", source: "shadow" },
  ]), [], "different families are different observations");
  ok("distinct arms and families are not mistaken for duplicates");
}

// ===========================================================================
group("momentum original / inverted arms are paired correctly");
// ===========================================================================
{
  const BID = 1.10000; const ASK = 1.10014;   // 1.4 pip spread
  const STOP_D = 0.00200; const TGT_D = 0.00400;

  // Momentum concluded LONG, so the original arm fills at the ask.
  const arms = buildMomentumArms({
    direction: "long", entry: ASK, stop: ASK - STOP_D, target: ASK + TGT_D, quote: { bid: BID, ask: ASK },
  })!;
  assert.ok(arms, "both arms are constructible");

  assert.equal(arms.original.direction, "long");
  assert.equal(arms.inverted.direction, "short");
  ok("the pair holds exactly one original and one inverted arm");

  // Each arm pays its OWN spread: a long fills at the ask, a short at the bid.
  // Negating the original instead would hand the inverted arm a free round trip
  // and manufacture an edge that does not exist.
  assert.ok(Math.abs(arms.original.entry - ASK) < 1e-12, "the long arm fills at the ask");
  assert.ok(Math.abs(arms.inverted.entry - BID) < 1e-12, "the short arm fills at the bid");
  assert.notEqual(arms.original.entry, arms.inverted.entry, "the arms are priced independently, not negated");
  ok("each arm fills its own side of the book and pays its own spread");

  // Distances are preserved exactly, so reward-to-risk is identical and the only
  // independent variable across the pair is direction.
  assert.ok(Math.abs(arms.original.stopDistance - arms.inverted.stopDistance) < 1e-12);
  assert.ok(Math.abs(arms.original.targetDistance - arms.inverted.targetDistance) < 1e-12);
  const rr = (a: typeof arms.original) => a.targetDistance / a.stopDistance;
  assert.ok(Math.abs(rr(arms.original) - rr(arms.inverted)) < 1e-12, "identical reward-to-risk");
  ok("stop and target distances are preserved — direction is the only variable");

  // Geometry sits on the correct side of each entry.
  assert.ok(arms.original.stop < arms.original.entry && arms.original.target > arms.original.entry);
  assert.ok(arms.inverted.stop > arms.inverted.entry && arms.inverted.target < arms.inverted.entry);
  ok("stop and target sit on the correct side of each arm's entry");

  // And it works starting from a SHORT signal too.
  const fromShort = buildMomentumArms({
    direction: "short", entry: BID, stop: BID + STOP_D, target: BID - TGT_D, quote: { bid: BID, ask: ASK },
  })!;
  assert.equal(fromShort.original.direction, "short");
  assert.equal(fromShort.inverted.direction, "long");
  assert.ok(Math.abs(fromShort.inverted.entry - ASK) < 1e-12, "the inverted long fills at the ask");
  ok("a SHORT signal pairs to a LONG arm on the other side of the book");

  // Degenerate input yields no pair at all, rather than a pair with one guess.
  assert.equal(buildMomentumArms({ direction: "long", entry: ASK, stop: ASK, target: ASK + TGT_D, quote: { bid: BID, ask: ASK } }), null);
  ok("a pair with an unguessable arm is not created");

  // The pair id is derived, so re-recording the same bar lands on one pair.
  const key = momentumPairKey("momentum-inversion-v1", "EUR_USD", "2026-08-20T13:15:00.000Z");
  assert.equal(key, momentumPairKey("momentum-inversion-v1", "EUR_USD", new Date("2026-08-20T13:15:00.000Z")));
  assert.equal(key, momentumPairKey("momentum-inversion-v1", "EUR_USD", "2026-08-20T09:15:00.000-04:00"));
  assert.notEqual(key, momentumPairKey("momentum-inversion-v1", "EUR_USD", "2026-08-20T13:30:00.000Z"));
  assert.notEqual(key, momentumPairKey("momentum-inversion-backfill-v1", "EUR_USD", "2026-08-20T13:15:00.000Z"));
  ok("the pair id is deterministic, timezone-stable and cohort-scoped");

  assert.equal(oppositeDirection("long"), "short");
  assert.equal(oppositeDirection("short"), "long");
}

// ===========================================================================
group("only one arm is actually executed");
// ===========================================================================
{
  // Case 1 — inversion active: Momentum said LONG, the engine traded SHORT, so
  // the INVERTED arm is the executed one and the original stays a shadow.
  assert.equal(armForExecutedDirection("long", "short"), "inverted");
  assert.equal(armForExecutedDirection("short", "long"), "inverted");
  ok("inverted selected → the inverted arm is executed, the original is shadow");

  // Case 2 — inversion off (or not eligible): what traded is what Momentum said.
  assert.equal(armForExecutedDirection("long", "long"), "original");
  assert.equal(armForExecutedDirection("short", "short"), "original");
  ok("original selected → the original arm is executed, the inverted is shadow");

  // Case 3 — neither selected. Nothing marks an arm executed, so both remain
  // shadows. That is expressed by simply never calling the attach step; the
  // arms are written pending at record time and resolved as shadows.
  ok("neither selected → both arms stay shadows (no execution is ever attached)");

  // The live policy and the pairing construction must agree on geometry, or the
  // research record would describe a trade that was never placed.
  const BID = 1.10000; const ASK = 1.10014;
  const candidate = {
    family: "momentum", version: "momentum-v1", configVersion: "momentum-cfg-v1",
    regime: { regime: "trending", atr: 0.001, atrPips: 10 }, qualifyReason: "", status: "valid",
    instrument: "EUR_USD", pair: "EUR/USD", direction: "long", timeframe: "15m",
    entry: ASK, stop: ASK - 0.002, target: ASK + 0.004, riskReward: 2, positionSize: null,
    features: {}, summary: "", conditions: [], passedConditions: [], failedConditions: [],
    evaluatedAt: "2026-08-20T13:15:00.000Z", dataSource: "oanda",
  } as never as StrategyCandidate;

  const policy = applyMomentumInversion(candidate, { bid: BID, ask: ASK });
  const paired = buildMomentumArms({ direction: "long", entry: ASK, stop: ASK - 0.002, target: ASK + 0.004, quote: { bid: BID, ask: ASK } })!;
  assert.equal(policy.inverted, true);
  assert.equal(policy.candidate.direction, paired.inverted.direction, "same direction");
  assert.ok(Math.abs(policy.candidate.entry! - paired.inverted.entry) < 1e-12, "same entry");
  assert.ok(Math.abs(policy.candidate.stop! - paired.inverted.stop) < 1e-12, "same stop");
  assert.ok(Math.abs(policy.candidate.target! - paired.inverted.target) < 1e-12, "same target");
  ok("the recorded inverted arm is geometrically identical to the trade the policy builds");
}

console.log("\nall pure evidence-integrity tests passed");

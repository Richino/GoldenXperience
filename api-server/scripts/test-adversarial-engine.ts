import assert from "node:assert/strict";
import {
  type AdaptiveCandidate, type BucketStat, contextKey, decideInstrument,
  type EvidenceStore, expectancy, stdErr, winRate,
} from "../src/adaptive-engine.js";
import { resolveShadowOutcome } from "../src/shadow-outcomes.js";
import { labelOutcome, type NormalizedQuote } from "../src/research.js";
import type { MarketRegime, RegimeClass, StrategyFamily } from "../../frontend/src/lib/strategy/types.js";

function regime(kind: RegimeClass, direction: "up" | "down" | "none" = "up"): MarketRegime {
  return { regime: kind, trendDirection: direction, trendStrength: 0.7, volatility: "normal", atr: 0.001, atrPips: 10, momentumState: "steady", emaFast: 1.1, emaMid: 1.09, emaSlow: 1.08, slopeAtrPerBar: 0.1, rangeHigh: null, rangeLow: null, rangeWidthAtr: null, rangeAgeBars: null, lookbackBars: 50, evaluatedAt: "2026-08-17T14:00:00.000Z" };
}
function cand(family: StrategyFamily, direction: "long" | "short", quality = 5, rr = 2, executable = true): AdaptiveCandidate {
  return { family, version: `${family}-v1`, configVersion: `${family}-cfg-v1`, direction, executable, riskReward: rr, quality };
}
function stat(resolved: number, wins: number, netR: number, sumSqR: number): BucketStat {
  return { resolved, wins, netR, sumSqR, mfe: null, mae: null };
}
function evidence(entries: Array<[StrategyFamily, "long" | "short", string, string, string, BucketStat]>): EvidenceStore {
  const context = new Map<string, BucketStat>();
  let total = 0;
  for (const [family, direction, pair, session, reg, s] of entries) { context.set(contextKey(family, pair, session, reg, direction), s); total += s.resolved; }
  return { totalResolved: total, context };
}

// ===========================================================================
// 1. CONTEXT LEAKAGE — mature evidence in one context must not affect another.
// ===========================================================================
{
  // 120 resolved, strongly negative, for EUR_USD ema long trending overlap.
  const ev = evidence([["ema", "long", "EUR_USD", "London/New York overlap", "trending", stat(120, 24, -60, 30)]]);

  // Same context → active selection, and confidently negative → suppressed/NONE.
  const same = decideInstrument({ instrument: "EUR_USD", session: "London/New York overlap", regime: regime("trending", "up"), candidates: [cand("ema", "long")], evidence: ev });
  assert.equal(same.state, "active_selection", "the matching context is mature");
  assert.equal(same.selected, null, "and the confidently-negative edge is rejected there");

  // Different pair → no evidence → cold start, taken.
  const otherPair = decideInstrument({ instrument: "GBP_JPY", session: "London/New York overlap", regime: regime("trending", "up"), candidates: [cand("ema", "long")], evidence: ev });
  assert.equal(otherPair.state, "collecting", "a different pair does not inherit the evidence");
  assert.equal(otherPair.selected?.family, "ema", "and its candidate is taken in cold start");

  // Different direction, session, and regime → each independently cold start.
  for (const change of [
    { label: "direction", args: { instrument: "EUR_USD", session: "London/New York overlap", regime: regime("trending", "down"), candidates: [cand("ema", "short")] } },
    { label: "session", args: { instrument: "EUR_USD", session: "London", regime: regime("trending", "up"), candidates: [cand("ema", "long")] } },
    { label: "regime", args: { instrument: "EUR_USD", session: "London/New York overlap", regime: regime("ranging", "none"), candidates: [cand("ema", "long")] } },
  ]) {
    const d = decideInstrument({ ...change.args, evidence: ev } as any);
    assert.equal(d.state, "collecting", `a different ${change.label} does not inherit the evidence`);
    assert.equal(d.selected?.family, "ema", `and stays a taken cold-start candidate for ${change.label}`);
  }
  console.log("1 context leakage: OK");
}

// ===========================================================================
// 2. MALFORMED STATISTICS — must fail safe (never suppress on bad numbers).
// ===========================================================================
{
  // Exported stat helpers on degenerate inputs.
  assert.equal(expectancy(stat(0, 0, 0, 0)), null, "expectancy of an empty bucket is null");
  assert.equal(stdErr(stat(1, 1, 2, 4)), null, "standard error needs at least two observations");
  assert.equal(stdErr(stat(100, 50, -50, 25)), 0, "zero-variance sample has zero standard error");
  assert.equal(winRate(stat(0, 0, 0, 0)), null, "win rate of an empty bucket is null");

  // 120 resolved but high variance & slightly negative → NOT confidently negative.
  const uncertain = decideInstrument({ instrument: "EUR_USD", session: "London", regime: regime("trending"), candidates: [cand("ema", "long")], evidence: evidence([["ema", "long", "EUR_USD", "London", "trending", stat(120, 55, -6, 480)]]) });
  assert.equal(uncertain.selected?.family, "ema", "a high-variance slightly-negative bucket is not suppressed");

  // A NaN-poisoned bucket must not crash and must not suppress.
  const nan = decideInstrument({ instrument: "EUR_USD", session: "London", regime: regime("trending"), candidates: [cand("ema", "long")], evidence: evidence([["ema", "long", "EUR_USD", "London", "trending", stat(120, 10, Number.NaN, Number.NaN)]]) });
  assert.ok(nan.selected !== null || nan.selected === null, "NaN statistics do not throw");
  assert.equal(nan.selected?.family, "ema", "NaN statistics fail safe and do not suppress the candidate");
  console.log("2 malformed statistics: OK");
}

// ===========================================================================
// 3. CONCURRENT & OPPOSING candidates — exactly one selected, rest recorded.
// ===========================================================================
{
  const empty = evidence([]);
  const same = decideInstrument({ instrument: "EUR_USD", session: "London", regime: regime("trending"), candidates: [cand("ema", "long", 6), cand("momentum", "long", 5), cand("breakout", "long", 4)], evidence: empty });
  assert.ok(same.selected, "one candidate is selected among simultaneous same-direction signals");
  assert.equal(same.suppressed.length, 2, "the other two are recorded as suppressed, not dropped");

  const opposing = decideInstrument({ instrument: "EUR_USD", session: "London", regime: regime("trending"), candidates: [cand("ema", "long", 5), cand("meanrev", "short", 5)], evidence: empty });
  assert.equal(opposing.selected?.family, "ema", "opposing signals resolve to one deterministic winner");
  assert.equal(opposing.suppressed.length, 1, "the opposing signal is preserved for research");
  console.log("3 concurrent/opposing: OK");
}

// ===========================================================================
// 4. SHADOW vs EXECUTED (labelOutcome) — identical inputs → identical economics.
// ===========================================================================
{
  const DECISION = "2026-08-17T14:00:00.000Z";
  const q = (m: number, bidHigh: number, bidLow: number, askHigh: number, askLow: number): NormalizedQuote => {
    const mid = (bidHigh + bidLow) / 2;
    return { closeTime: new Date(Date.parse(DECISION) + m * 60_000).toISOString(), bidOpen: mid, bidHigh, bidLow, bidClose: mid, askOpen: mid, askHigh, askLow, askClose: mid };
  };
  const now = new Date(Date.parse(DECISION) + 60 * 60_000);

  const scenarios: Array<[string, "long" | "short", number, number, number, NormalizedQuote[]]> = [
    ["long target", "long", 1.10, 1.099, 1.102, [q(15, 1.10210, 1.10100, 1.10220, 1.10110)]],
    ["long stop", "long", 1.10, 1.099, 1.102, [q(15, 1.10010, 1.09880, 1.10020, 1.09890)]],
    ["short target", "short", 1.10, 1.101, 1.098, [q(15, 1.09810, 1.09790, 1.09820, 1.09795)]],
    ["ambiguous", "long", 1.10, 1.099, 1.102, [q(15, 1.10210, 1.09880, 1.10220, 1.09890)]], // both levels in one bar
  ];
  for (const [label, dir, entry, stop, target, quotes] of scenarios) {
    const executed = labelOutcome(dir, entry, stop, target, DECISION, quotes);
    const shadow = resolveShadowOutcome(dir, entry, stop, target, DECISION, quotes, now);
    assert.ok(shadow, `${label}: shadow resolves when executed does`);
    assert.equal(shadow!.outcome, executed.outcome, `${label}: same outcome category`);
    assert.equal(shadow!.resultR, executed.resultR, `${label}: same result R (no divergent win/loss definition)`);
  }

  // JPY shadow: correct pip scale, target reached.
  const jpy = resolveShadowOutcome("long", 150.00, 149.90, 150.20, DECISION, [q(15, 150.21, 150.05, 150.22, 150.06)], now);
  assert.equal(jpy!.outcome, "target_first", "JPY shadow resolves target");
  assert.ok((jpy!.resultR ?? 0) > 0, "JPY shadow result is positive");
  console.log("4 shadow vs executed agreement: OK");
}

console.log("\nAll adversarial engine/shadow tests passed.");

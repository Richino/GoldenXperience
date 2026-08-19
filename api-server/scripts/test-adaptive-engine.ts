import assert from "node:assert/strict";
import {
  type AdaptiveCandidate, type BucketStat, contextKey, decideInstrument, DEFAULT_ADAPTIVE_CONFIG,
  type EvidenceStore,
} from "../src/adaptive-engine.js";
import type { MarketRegime, StrategyFamily } from "../../frontend/src/lib/strategy/types.js";

const REGIME: MarketRegime = {
  regime: "trending", trendDirection: "up", trendStrength: 0.7, volatility: "normal",
  atr: 0.001, atrPips: 10, momentumState: "steady", emaFast: 1.1, emaMid: 1.09, emaSlow: 1.08,
  slopeAtrPerBar: 0.1, rangeHigh: null, rangeLow: null, rangeWidthAtr: null, rangeAgeBars: null,
  lookbackBars: 50, evaluatedAt: "2026-08-17T14:00:00.000Z",
};

function cand(family: StrategyFamily, direction: "long" | "short", quality: number, rr = 2, executable = true): AdaptiveCandidate {
  return { family, version: `${family}-v1`, configVersion: `${family}-cfg-v1`, direction, executable, riskReward: rr, quality };
}

function stat(resolved: number, wins: number, netR: number, sumSqR: number): BucketStat {
  return { resolved, wins, netR, sumSqR, mfe: null, mae: null };
}

function evidence(entries: Array<[StrategyFamily, "long" | "short", BucketStat]>, pair = "EUR_USD", session = "London/New York overlap", regime = "trending"): EvidenceStore {
  const context = new Map<string, BucketStat>();
  let total = 0;
  for (const [family, direction, s] of entries) { context.set(contextKey(family, pair, session, regime, direction), s); total += s.resolved; }
  return { totalResolved: total, context };
}

const BASE = { instrument: "EUR_USD", session: "London/New York overlap", regime: REGIME };

// ===========================================================================
// COLLECTING — no evidence: deterministic tie-break, never fabricates a winner.
// ===========================================================================
{
  const empty = evidence([]);
  // Same-direction conflict: higher setup quality wins deterministically.
  const d1 = decideInstrument({ ...BASE, candidates: [cand("momentum", "long", 5), cand("ema", "long", 6)], evidence: empty });
  assert.equal(d1.state, "collecting", "no evidence means cold start");
  assert.equal(d1.selected?.family, "ema", "cold start selects the higher-quality candidate");
  assert.equal(d1.suppressed.length, 1, "the other candidate is recorded as suppressed");
  assert.match(d1.reason, /tie-break/, "reason names the deterministic tie-break");

  // Equal quality → the fixed family priority order decides (ema before meanrev).
  const d2 = decideInstrument({ ...BASE, candidates: [cand("meanrev", "short", 5), cand("ema", "long", 5)], evidence: empty });
  assert.equal(d2.selected?.family, "ema", "equal quality falls back to the stable family order");
  assert.equal(d2.suppressed[0]?.family, "meanrev", "the opposing signal is preserved, not discarded");

  // A lone candidate is taken, never suppressed, during cold start.
  const d3 = decideInstrument({ ...BASE, candidates: [cand("breakout", "long", 4)], evidence: empty });
  assert.equal(d3.selected?.family, "breakout", "the only valid candidate is taken");

  // Deterministic: repeating the same decision yields the same winner.
  const repeat = decideInstrument({ ...BASE, candidates: [cand("momentum", "long", 5), cand("ema", "long", 6)], evidence: empty });
  assert.equal(repeat.selected?.family, d1.selected?.family, "the cold-start decision is deterministic");
  console.log("collecting: OK");
}

// ===========================================================================
// No executable candidates → nothing selected (recorded, not forced).
// ===========================================================================
{
  const d = decideInstrument({ ...BASE, candidates: [cand("ema", "long", 3, 2, false), cand("meanrev", "short", 2, 1.5, false)], evidence: evidence([]) });
  assert.equal(d.selected, null, "no executable candidate means no selection");
  assert.match(d.reason, /No executable/, "reason explains the absence");
  console.log("no-candidate: OK");
}

// ===========================================================================
// LEARNING — evidence ranks simultaneous candidates; lone candidate never cut.
// ===========================================================================
{
  // Momentum long has proven positive expectancy; ema long proven negative.
  const ev = evidence([
    ["ema", "long", stat(60, 20, -12, 60)],       // expectancy -0.2
    ["momentum", "long", stat(60, 40, 30, 60)],   // expectancy +0.5
  ]);
  const d = decideInstrument({ ...BASE, candidates: [cand("ema", "long", 6), cand("momentum", "long", 5)], evidence: ev });
  assert.equal(d.state, "learning", "50–99 resolved is the learning state");
  assert.equal(d.selected?.family, "momentum", "evidence overrides the cold-start order and higher quality");

  // A lone candidate with proven-negative evidence is still taken in LEARNING
  // (no performance-based suppression of a standalone candidate).
  const lone = decideInstrument({ ...BASE, candidates: [cand("ema", "long", 6)], evidence: evidence([["ema", "long", stat(60, 20, -12, 60)]]) });
  assert.equal(lone.selected?.family, "ema", "LEARNING does not suppress a standalone candidate");
  assert.equal(lone.state, "learning", "60 resolved is learning, not active selection");
  console.log("learning: OK");
}

// ===========================================================================
// ACTIVE_SELECTION — prefer the stronger edge; suppress negative; allow NONE.
// ===========================================================================
{
  // Enough sample (>=100); one strongly positive, one confidently negative.
  const ev = evidence([
    ["ema", "long", stat(120, 78, 48, 120)],     // expectancy +0.4
    ["meanrev", "short", stat(120, 24, -60, 30)], // expectancy -0.5, zero variance → confidently negative
  ]);
  const d = decideInstrument({ ...BASE, candidates: [cand("ema", "long", 5), cand("meanrev", "short", 6)], evidence: ev });
  assert.equal(d.state, "active_selection", "100+ resolved reaches active selection");
  assert.equal(d.selected?.family, "ema", "the stronger-edge candidate is chosen");
  assert.ok(d.suppressed.some((c) => c.family === "meanrev"), "the negative-edge opposing signal is suppressed");

  // 100+ sample but NOT confidently negative → still taken (sample size alone
  // never suppresses; the confidence test must also pass).
  const bigButUncertain = decideInstrument({ ...BASE, candidates: [cand("ema", "long", 6)], evidence: evidence([["ema", "long", stat(120, 55, -6, 480)]]) });
  assert.equal(bigButUncertain.state, "active_selection", "120 resolved is active selection");
  assert.equal(bigButUncertain.selected?.family, "ema", "a high-variance slightly-negative bucket is not suppressed on count alone");

  // Every available candidate confidently negative → NONE.
  const allBad = evidence([
    ["ema", "long", stat(120, 24, -60, 30)],
    ["momentum", "long", stat(110, 22, -55, 27.5)],
  ]);
  const none = decideInstrument({ ...BASE, candidates: [cand("ema", "long", 6), cand("momentum", "long", 5)], evidence: allBad });
  assert.equal(none.state, "active_selection", "state is active selection");
  assert.equal(none.selected, null, "the engine selects NONE when every edge is confidently negative");
  assert.match(none.reason, /No trade/, "reason states no trade");

  // A single confidently-negative candidate → NONE (may suppress a lone one here).
  const soloBad = decideInstrument({ ...BASE, candidates: [cand("ema", "long", 6)], evidence: evidence([["ema", "long", stat(120, 24, -60, 30)]]) });
  assert.equal(soloBad.selected, null, "active selection may reject a lone negative-edge candidate");
  console.log("active-selection: OK");
}

// ===========================================================================
// Missing / thin data — fail safe, never invent statistics.
// ===========================================================================
{
  // A negative bucket with too small a sample must NOT be suppressed.
  const thin = decideInstrument({ ...BASE, candidates: [cand("ema", "long", 6)], evidence: evidence([["ema", "long", stat(8, 1, -6, 6)]]) });
  assert.equal(thin.state, "collecting", "8 resolved is still cold start");
  assert.equal(thin.selected?.family, "ema", "a thin negative sample cannot suppress a candidate");

  // Under the new conservative thresholds, 49 resolved is still COLLECTING and
  // a confidently-negative-looking bucket cannot suppress anything yet.
  const belowLearning = decideInstrument({ ...BASE, candidates: [cand("ema", "long", 6)], evidence: evidence([["ema", "long", stat(49, 10, -24.5, 12.25)]]) });
  assert.equal(belowLearning.state, "collecting", "49 resolved is still collecting (threshold is 50)");
  assert.equal(belowLearning.selected?.family, "ema", "a sub-50 sample never suppresses");
  console.log("thin-data: OK");
}

console.log("\nAll adaptive-engine tests passed.");

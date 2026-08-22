import assert from "node:assert/strict";
import { applyMomentumInversion, MOMENTUM_DIRECTION_INVERSION, MOMENTUM_INVERSION_EXPERIMENT } from "../src/momentum-inversion.js";
import type { StrategyCandidate } from "../../frontend/src/lib/strategy/strategy.js";

/**
 * Momentum direction inversion — policy tests. Pure: no database, no network.
 *
 * Proves the independent variable really is direction alone: the firing set,
 * the stop distance, the target distance and the reward-to-risk all survive the
 * flip, only the side of the book changes, and no other family is affected.
 */
const BID = 1.10000; const ASK = 1.10014;       // 1.4 pip spread
const QUOTE = { bid: BID, ask: ASK };
const STOP_D = 0.00200; const TGT_D = 0.00400;   // 20 / 40 pips, RR 2.0

function candidate(family: string, direction: "long" | "short", status = "valid"): StrategyCandidate {
  const entry = direction === "long" ? ASK : BID;
  return {
    family, version: `${family}-v1`, configVersion: `${family}-cfg-v1`,
    regime: { regime: "trending", atr: 0.0010, atrPips: 10 } as never,
    qualifyReason: "", status, instrument: "EUR_USD", pair: "EUR/USD",
    direction, timeframe: "15m",
    entry,
    stop: direction === "long" ? entry - STOP_D : entry + STOP_D,
    target: direction === "long" ? entry + TGT_D : entry - TGT_D,
    riskReward: TGT_D / STOP_D, positionSize: null, features: {} as never,
    summary: "", conditions: [], passedConditions: [], failedConditions: [],
    evaluatedAt: "2026-08-22T10:15:00.000Z", dataSource: "oanda",
  } as never as StrategyCandidate;
}

assert.equal(MOMENTUM_DIRECTION_INVERSION, true, "the experiment is active for these tests");

// ---------------------------------------------------------------- momentum
{
  const r = applyMomentumInversion(candidate("momentum", "long"), QUOTE);
  assert.equal(r.inverted, true);
  assert.equal(r.originalDirection, "long");
  assert.equal(r.executedDirection, "short");
  assert.equal(r.candidate.direction, "short", "momentum LONG must execute SHORT");
  assert.equal(r.experimentId, MOMENTUM_INVERSION_EXPERIMENT);
  // a short fills at the BID
  assert.ok(Math.abs(r.candidate.entry! - BID) < 1e-12, "inverted SHORT entry must be the BID");
  assert.ok(r.candidate.stop! > r.candidate.entry!, "inverted SHORT stop sits ABOVE entry");
  assert.ok(r.candidate.target! < r.candidate.entry!, "inverted SHORT target sits BELOW entry");
}
{
  const r = applyMomentumInversion(candidate("momentum", "short"), QUOTE);
  assert.equal(r.inverted, true);
  assert.equal(r.originalDirection, "short");
  assert.equal(r.candidate.direction, "long", "momentum SHORT must execute LONG");
  // a long fills at the ASK
  assert.ok(Math.abs(r.candidate.entry! - ASK) < 1e-12, "inverted LONG entry must be the ASK");
  assert.ok(r.candidate.stop! < r.candidate.entry!, "inverted LONG stop sits BELOW entry");
  assert.ok(r.candidate.target! > r.candidate.entry!, "inverted LONG target sits ABOVE entry");
}
console.log("momentum LONG->SHORT and SHORT->LONG, correct book side: OK");

// ---------------------------------------------------------------- geometry
for (const d of ["long", "short"] as const) {
  const original = candidate("momentum", d);
  const r = applyMomentumInversion(original, QUOTE);
  const stopD = Math.abs(r.candidate.entry! - r.candidate.stop!);
  const tgtD = Math.abs(r.candidate.target! - r.candidate.entry!);
  assert.ok(Math.abs(stopD - STOP_D) < 1e-12, `stop DISTANCE preserved (${d})`);
  assert.ok(Math.abs(tgtD - TGT_D) < 1e-12, `target DISTANCE preserved (${d})`);
  assert.ok(Math.abs(r.candidate.riskReward! - original.riskReward!) < 1e-12, `RR unchanged (${d})`);
  // the inverted trade must NOT reuse the original side's entry price
  assert.notEqual(r.candidate.entry, original.entry, `inverted trade must not reuse the original entry (${d})`);
  assert.equal(r.candidate.positionSize, null, "size is recomputed downstream from the new entry/stop");
}
console.log("distances, RR preserved; no free spread: OK");

// ---------------------------------------------------------------- WAIT
for (const status of ["no_setup", "invalid"]) {
  const c = candidate("momentum", "long", status);
  const r = applyMomentumInversion(c, QUOTE);
  assert.equal(r.inverted, false, `a ${status} candidate is never turned into a trade`);
  assert.equal(r.candidate, c, "non-executable candidates pass through untouched");
}
{
  const c = { ...(candidate("momentum", "long") as object), direction: null } as never as StrategyCandidate;
  assert.equal(applyMomentumInversion(c, QUOTE).inverted, false, "WAIT stays WAIT");
}
console.log("WAIT -> WAIT, never converted into a trade: OK");

// ---------------------------------------------------------------- other families
for (const family of ["ema", "breakout", "meanrev"]) {
  for (const d of ["long", "short"] as const) {
    const c = candidate(family, d);
    const r = applyMomentumInversion(c, QUOTE);
    assert.equal(r.inverted, false, `${family} must not be inverted`);
    assert.equal(r.candidate.direction, d, `${family} ${d} stays ${d}`);
    assert.equal(r.candidate, c, `${family} candidate passes through by identity`);
    assert.equal(r.experimentId, null, `${family} carries no inversion experiment id`);
  }
}
console.log("EMA / Breakout / MeanRev untouched: OK");

// ---------------------------------------------------------------- fail closed
{
  const c = candidate("momentum", "long");
  assert.equal(applyMomentumInversion(c, undefined).inverted, false, "no quote -> no inversion");
  assert.equal(applyMomentumInversion(c, { bid: 0, ask: ASK }).inverted, false, "invalid bid -> no inversion");
  const degenerate = { ...(c as object), stop: c.entry } as never as StrategyCandidate;
  assert.equal(applyMomentumInversion(degenerate, QUOTE).inverted, false, "zero stop distance -> no inversion");
}
console.log("fail-closed on missing/invalid execution data: OK");

// ---------------------------------------------------------------- provenance
{
  const r = applyMomentumInversion(candidate("momentum", "short"), QUOTE);
  assert.notEqual(r.originalDirection, r.executedDirection, "original and executed must differ when inverted");
  assert.equal(r.originalDirection, "short");
  assert.equal(r.executedDirection, "long");
  assert.equal(r.experimentId, "momentum-inversion-v1");
}
console.log("provenance (original != executed, experiment id): OK");

console.log("\nAll momentum-inversion policy tests passed.");

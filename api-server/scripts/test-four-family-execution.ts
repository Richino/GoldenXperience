import assert from "node:assert/strict";
import { LIVE_EXECUTABLE_FAMILIES, STRATEGY_FAMILIES } from "../../frontend/src/lib/strategy/strategies/index.js";
import { toAdaptiveCandidate } from "../src/adaptive-engine.js";
import { applyMomentumInversion, MOMENTUM_DIRECTION_INVERSION, MOMENTUM_INVERSION_EXPERIMENT } from "../src/momentum-inversion.js";
import type { StrategyCandidate } from "../../frontend/src/lib/strategy/strategy.js";
import type { StrategyFamily } from "../../frontend/src/lib/strategy/types.js";

/**
 * Four-family execution + Momentum-inversion pre-deploy gate. Pure: no DB, no network.
 *
 * Proves the two properties the deployment depends on, and fails loudly on either:
 *   1. ALL FOUR families are executable through the one authoritative allowlist.
 *   2. Momentum is the ONLY family whose direction is inverted.
 */
const FAMILIES: StrategyFamily[] = ["ema", "breakout", "momentum", "meanrev"];
const BID = 1.10000; const ASK = 1.10014;
const QUOTE = { bid: BID, ask: ASK };
const STOP_D = 0.00200; const TGT_D = 0.00400;

function candidate(family: StrategyFamily, direction: "long" | "short" | null, status = "valid"): StrategyCandidate {
  const entry = direction === "short" ? BID : ASK;
  return {
    family, version: `${family}-v1`, configVersion: `${family}-cfg-v1`,
    regime: { regime: "trending", atr: 0.0010, atrPips: 10 } as never,
    qualifyReason: "", status, instrument: "EUR_USD", pair: "EUR/USD",
    direction, timeframe: "15m",
    entry: direction === null ? null : entry,
    stop: direction === null ? null : (direction === "long" ? entry - STOP_D : entry + STOP_D),
    target: direction === null ? null : (direction === "long" ? entry + TGT_D : entry - TGT_D),
    riskReward: TGT_D / STOP_D, positionSize: null, features: {} as never,
    summary: "", conditions: [], passedConditions: [], failedConditions: [],
    evaluatedAt: "2026-08-22T10:15:00.000Z", dataSource: "oanda",
  } as never as StrategyCandidate;
}

// ============================================================ 1. ALLOWLIST
console.log("1. EXECUTABLE ALLOWLIST");
assert.deepEqual([...LIVE_EXECUTABLE_FAMILIES].sort(), [...FAMILIES].sort(),
  "the allowlist must contain exactly the four families");
assert.notEqual(LIVE_EXECUTABLE_FAMILIES.length, 0, "the allowlist must not be empty");
assert.deepEqual([...STRATEGY_FAMILIES].sort(), [...FAMILIES].sort(),
  "the allowlist must match the engine's family set");
console.log(`   allowlist = [${LIVE_EXECUTABLE_FAMILIES.join(", ")}]`);

// the selection engine must actually consume it: every family, both directions
for (const family of FAMILIES) {
  for (const d of ["long", "short"] as const) {
    const a = toAdaptiveCandidate(candidate(family, d));
    assert.equal(a.executable, true, `${family} ${d} must be executable=true when its gates pass`);
    assert.equal(a.family, family);
  }
}
console.log("   EMA / Breakout / Momentum / MeanRev -> executable=true  (both directions)");

// and it must genuinely gate: a family outside the list is not executable
{
  const rogue = toAdaptiveCandidate(candidate("liquidity" as never as StrategyFamily, "long"));
  assert.equal(rogue.executable, false, "a family absent from the allowlist must NOT be executable");
}
// non-valid candidates never become executable regardless of the allowlist
for (const family of FAMILIES) {
  assert.equal(toAdaptiveCandidate(candidate(family, "long", "no_setup")).executable, false,
    `${family} no_setup must not be executable`);
  assert.equal(toAdaptiveCandidate(candidate(family, null)).executable, false,
    `${family} WAIT must not be executable`);
}
console.log("   allowlist genuinely gates; WAIT / no_setup never executable");

// ============================================================ 2. DIRECTION MATRIX
console.log("\n2. DIRECTION MATRIX  (family, original -> executed)");
assert.equal(MOMENTUM_DIRECTION_INVERSION, true, "the inversion policy must be enabled for this deployment");

const EXPECT: Array<[StrategyFamily, "long" | "short", "long" | "short", boolean]> = [
  ["ema", "long", "long", false],
  ["ema", "short", "short", false],
  ["breakout", "long", "long", false],
  ["breakout", "short", "short", false],
  ["meanrev", "long", "long", false],
  ["meanrev", "short", "short", false],
  ["momentum", "long", "short", true],
  ["momentum", "short", "long", true],
];
for (const [family, original, executed, inverted] of EXPECT) {
  const r = applyMomentumInversion(candidate(family, original), QUOTE);
  assert.equal(r.candidate.direction, executed, `${family} ${original} must execute ${executed}`);
  assert.equal(r.inverted, inverted, `${family} inverted must be ${inverted}`);
  assert.equal(r.originalDirection, original, `${family} original_direction must be preserved`);
  assert.equal(r.executedDirection, executed);
  assert.equal(r.experimentId, inverted ? MOMENTUM_INVERSION_EXPERIMENT : null);
  console.log(`   ${family.padEnd(9)} ${original.padEnd(5)} -> ${executed.padEnd(5)}  inverted=${String(inverted).padEnd(5)} OK`);
}

// the hard negative: no non-momentum family may EVER be inverted
for (const family of ["ema", "breakout", "meanrev"] as StrategyFamily[]) {
  for (const d of ["long", "short"] as const) {
    const c = candidate(family, d);
    const r = applyMomentumInversion(c, QUOTE);
    assert.equal(r.inverted, false, `FAIL: ${family} was inverted — only Momentum may invert`);
    assert.equal(r.candidate, c, `${family} must pass through by identity (untouched object)`);
    assert.equal(r.experimentId, null, `${family} must not carry an inversion experiment id`);
  }
}
console.log("   EMA / Breakout / MeanRev never inverted (identity pass-through)");

// WAIT from ANY family stays WAIT and never becomes a trade
for (const family of FAMILIES) {
  for (const status of ["no_setup", "invalid"]) {
    const r = applyMomentumInversion(candidate(family, "long", status), QUOTE);
    assert.equal(r.inverted, false, `${family} ${status} must not be inverted into a trade`);
  }
  const wait = applyMomentumInversion(candidate(family, null), QUOTE);
  assert.equal(wait.inverted, false, `${family} WAIT must stay WAIT`);
  assert.equal(wait.candidate.direction, null, `${family} WAIT must remain directionless`);
}
console.log("   WAIT -> WAIT for all four families");

// ============================================================ 3. GEOMETRY
console.log("\n3. MOMENTUM INVERTED GEOMETRY");
{
  const r = applyMomentumInversion(candidate("momentum", "short"), QUOTE);  // -> LONG
  assert.ok(Math.abs(r.candidate.entry! - ASK) < 1e-12, "inverted LONG enters at the ASK");
  assert.ok(r.candidate.stop! < r.candidate.entry!, "inverted LONG stop BELOW entry");
  assert.ok(r.candidate.target! > r.candidate.entry!, "inverted LONG target ABOVE entry");
  console.log("   SHORT -> LONG : entry=ASK, stop BELOW, target ABOVE  OK");
}
{
  const r = applyMomentumInversion(candidate("momentum", "long"), QUOTE);   // -> SHORT
  assert.ok(Math.abs(r.candidate.entry! - BID) < 1e-12, "inverted SHORT enters at the BID");
  assert.ok(r.candidate.stop! > r.candidate.entry!, "inverted SHORT stop ABOVE entry");
  assert.ok(r.candidate.target! < r.candidate.entry!, "inverted SHORT target BELOW entry");
  console.log("   LONG -> SHORT : entry=BID, stop ABOVE, target BELOW  OK");
}
for (const d of ["long", "short"] as const) {
  const original = candidate("momentum", d);
  const r = applyMomentumInversion(original, QUOTE);
  assert.ok(Math.abs(Math.abs(r.candidate.entry! - r.candidate.stop!) - STOP_D) < 1e-12, "stop DISTANCE preserved");
  assert.ok(Math.abs(Math.abs(r.candidate.target! - r.candidate.entry!) - TGT_D) < 1e-12, "target DISTANCE preserved");
  assert.ok(Math.abs(r.candidate.riskReward! - original.riskReward!) < 1e-12, "risk/reward preserved");
  assert.notEqual(r.candidate.entry, original.entry, "must NOT reuse the original side's entry (no free spread)");
  assert.equal(r.candidate.positionSize, null, "sizing recalculated downstream from the inverted entry/stop");
}
console.log("   stop/target distances + RR preserved; both sides pay real spread  OK");

console.log("\nAll four-family execution + inversion assertions passed.");

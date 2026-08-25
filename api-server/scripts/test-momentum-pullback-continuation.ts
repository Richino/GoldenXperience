import assert from "node:assert/strict";
import {
  MOMENTUM_PULLBACK_CONTINUATION_CONFIG,
  detectMomentumPullbackContinuation,
  invertMomentumPullbackDirection,
} from "../src/momentum-pullback-continuation.js";
import type { MomentumIgnitionBar } from "../src/momentum-early-ignition.js";

const base = Date.UTC(2026, 7, 24, 6, 0);

function bar(index: number, open: number, high: number, low: number, close: number, volume = 100): MomentumIgnitionBar {
  return { closeTime: new Date(base + (index + 1) * 5 * 60_000).toISOString(), open, high, low, close, volume };
}

function fixture(): MomentumIgnitionBar[] {
  const bars = Array.from({ length: 38 }, (_, index) => bar(index, 99.80, 100.00, 99.60, 99.80, 90));
  bars[27] = bar(27, 100.00, 100.30, 99.80, 100.20, 150);
  bars[28] = bar(28, 100.20, 100.80, 100.10, 100.70, 180);
  bars[29] = bar(29, 100.70, 101.60, 100.60, 101.50, 220);
  bars[30] = bar(30, 101.50, 101.55, 101.20, 101.30, 100);
  bars[31] = bar(31, 101.30, 101.35, 101.00, 101.10, 90);
  bars[32] = bar(32, 101.10, 101.70, 101.05, 101.60, 160);
  bars[33] = bar(33, 101.62, 101.90, 101.50, 101.80, 170);
  return bars;
}

// Two compact red candles followed by a green close through the pullback.
{
  const result = detectMomentumPullbackContinuation({ bars: fixture(), breakoutIndex: 29, direction: "long", m15Atr: 2 });
  assert.equal(result.action, "trade");
  assert.equal(result.direction, "long");
  assert.equal(result.pullbackBars, 2);
  assert.equal(result.resumeIndex, 32);
  assert.equal(result.entryIndex, 33);
  assert.ok(result.retracementFraction !== null && result.retracementFraction >= 0.10 && result.retracementFraction <= 0.50);
  assert.ok(result.stop !== null && result.entry !== null && result.stop < result.entry);
  assert.ok(result.target !== null && result.target > result.entry!);
  assert.ok(Math.abs(result.targetDistance! / result.stopDistance! - 2) < 1e-12);
  assert.ok(result.pullbackTickActivityRatio !== null && result.pullbackTickActivityRatio < 1);
}

// Three pullback candles are accepted when the following candle resumes.
{
  const bars = fixture();
  bars[32] = bar(32, 101.10, 101.20, 100.95, 101.00, 85);
  bars[33] = bar(33, 101.00, 101.70, 100.98, 101.62, 160);
  bars[34] = bar(34, 101.64, 101.90, 101.50, 101.80, 170);
  const result = detectMomentumPullbackContinuation({ bars, breakoutIndex: 29, direction: "long", m15Atr: 2 });
  assert.equal(result.action, "trade");
  assert.equal(result.pullbackBars, 3);
  assert.equal(result.entryIndex, 34);
}

// One countertrend candle is not the two-to-three candle pattern.
{
  const bars = fixture();
  bars[31] = bar(31, 101.30, 101.70, 101.20, 101.65, 160);
  const result = detectMomentumPullbackContinuation({ bars, breakoutIndex: 29, direction: "long", m15Atr: 2 });
  assert.equal(result.action, "wait");
}

// A retracement beyond half of the impulse is rejected.
{
  const bars = fixture();
  bars[31] = bar(31, 101.30, 101.35, 100.55, 100.65, 90);
  const result = detectMomentumPullbackContinuation({ bars, breakoutIndex: 29, direction: "long", m15Atr: 2 });
  assert.equal(result.action, "wait");
}

// A pullback candle almost as large as the entire impulse is not orderly.
{
  const bars = fixture();
  bars[30] = bar(30, 101.50, 101.55, 100.15, 101.20, 100);
  const result = detectMomentumPullbackContinuation({ bars, breakoutIndex: 29, direction: "long", m15Atr: 2 });
  assert.equal(result.action, "wait");
}

// The next open cannot chase more than 0.25 M15 ATR beyond the pullback.
{
  const bars = fixture();
  bars[33] = { ...bars[33]!, open: 102.10 };
  const result = detectMomentumPullbackContinuation({ bars, breakoutIndex: 29, direction: "long", m15Atr: 2 });
  assert.equal(result.action, "wait");
}

// Nearby prior resistance must leave room for the 2R target.
{
  const bars = fixture();
  bars[10] = { ...bars[10]!, high: 102.00 };
  const result = detectMomentumPullbackContinuation({ bars, breakoutIndex: 29, direction: "long", m15Atr: 2 });
  assert.equal(result.action, "wait");
}

// Entry-candle future prices cannot influence a decision made at its open.
{
  const clean = fixture();
  const changed = fixture();
  changed[33] = { ...changed[33]!, high: 150, low: 50, close: 75 };
  const args = { breakoutIndex: 29, direction: "long" as const, m15Atr: 2 };
  assert.deepEqual(detectMomentumPullbackContinuation({ bars: changed, ...args }), detectMomentumPullbackContinuation({ bars: clean, ...args }));
}

// Short logic is an exact price mirror.
{
  const mirror = (item: MomentumIgnitionBar): MomentumIgnitionBar => ({
    ...item,
    open: 200 - item.open,
    high: 200 - item.low,
    low: 200 - item.high,
    close: 200 - item.close,
  });
  const result = detectMomentumPullbackContinuation({ bars: fixture().map(mirror), breakoutIndex: 29, direction: "short", m15Atr: 2 });
  assert.equal(result.action, "trade");
  assert.equal(result.direction, "short");
  assert.ok(result.stop! > result.entry!);
  assert.ok(result.target! < result.entry!);
}

assert.equal(invertMomentumPullbackDirection("long"), "short");
assert.equal(invertMomentumPullbackDirection("short"), "long");
assert.deepEqual(MOMENTUM_PULLBACK_CONTINUATION_CONFIG, {
  impulseLookbackBars: 3,
  minImpulseM15Atr: 0.35,
  maxPrePullbackBars: 1,
  minPullbackBars: 2,
  maxPullbackBars: 3,
  minRetracementFraction: 0.10,
  maxRetracementFraction: 0.50,
  maxPullbackBarRangeImpulse: 0.75,
  resumeBufferM15Atr: 0.02,
  maxEntryExtensionM15Atr: 0.25,
  stopBufferM15Atr: 0.05,
  minStopM15Atr: 0.10,
  maxStopM15Atr: 0.75,
  targetR: 2,
  structureLookbackBars: 24,
});

console.log("momentum pullback continuation tests passed");

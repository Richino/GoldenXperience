import assert from "node:assert/strict";
import {
  MOMENTUM_CUSUM_CONFIG,
  calibratedWinProbability,
  detectMomentumCusumPullback,
  fitSigmoidCalibration,
  invertMomentumCusumDirection,
  scanMomentumCusumIgnitions,
  updateTwoSidedCusum,
} from "../src/momentum-cusum-pullback.js";
import type { MomentumCusumBar, MomentumCusumIgnition } from "../src/momentum-cusum-pullback.js";

const base = Date.UTC(2026, 0, 5, 7, 0);

function bar(index: number, open: number, high: number, low: number, close: number, volume = 100): MomentumCusumBar {
  return { closeTime: new Date(base + (index + 1) * 60_000).toISOString(), open, high, low, close, volume };
}

function fixture(): MomentumCusumBar[] {
  const bars = Array.from({ length: 90 }, (_, index) => {
    const open = 100 + (index % 2 === 0 ? 0 : 0.002);
    const close = 100 + (index % 2 === 0 ? 0.002 : 0);
    return bar(index, open, Math.max(open, close) + 0.01, Math.min(open, close) - 0.01, close, 90);
  });
  bars[66] = bar(66, 100.00, 100.12, 99.95, 100.10, 150);
  bars[67] = bar(67, 100.10, 100.24, 100.08, 100.22, 160);
  bars[68] = bar(68, 100.22, 100.38, 100.20, 100.36, 170);
  bars[69] = bar(69, 100.36, 100.52, 100.34, 100.50, 180);
  bars[70] = bar(70, 100.50, 100.60, 100.48, 100.58, 190);
  bars[71] = bar(71, 100.58, 100.59, 100.44, 100.46, 100);
  bars[72] = bar(72, 100.46, 100.50, 100.35, 100.38, 90);
  bars[73] = bar(73, 100.38, 100.66, 100.37, 100.64, 155);
  bars[74] = bar(74, 100.65, 100.75, 100.60, 100.70, 160);
  return bars;
}

const ignition: MomentumCusumIgnition = {
  index: 70,
  direction: "long",
  knownAt: new Date(base + 71 * 60_000).toISOString(),
  returnZ: 2,
  cusumMagnitude: 3.2,
  sigma: 0.001,
  referenceM5Atr: 1,
  impulseM5Atr: 0.65,
  impulseStart: 99.95,
  impulseExtreme: 100.60,
  impulseRange: 0.65,
};

// The CUSUM fires early from accumulated standardized returns and resets.
{
  let state = { positive: 0, negative: 0 };
  let direction: "long" | "short" | null = null;
  for (const z of [0.9, 0.9, 0.9]) {
    const step = updateTwoSidedCusum(state, z);
    state = step.state;
    direction = step.direction;
  }
  assert.equal(direction, "long");
  assert.deepEqual(state, { positive: 0, negative: 0 });
}

// A compact two-candle pullback and close through its high is tradable.
{
  const result = detectMomentumCusumPullback({ bars: fixture(), ignition });
  assert.equal(result.action, "trade");
  assert.equal(result.direction, "long");
  assert.equal(result.pullbackBars, 2);
  assert.equal(result.entryIndex, 74);
  assert.ok(result.retracementFraction !== null && result.retracementFraction >= 0.10 && result.retracementFraction <= 0.55);
  assert.ok(result.stop !== null && result.stop < fixture()[74]!.open);
  assert.ok(result.rawScore > 0 && result.rawScore <= 100);
}

// The entry candle's future high/low/close cannot affect a decision at its open.
{
  const clean = fixture();
  const changed = fixture();
  changed[74] = { ...changed[74]!, high: 150, low: 50, close: 75 };
  assert.deepEqual(
    detectMomentumCusumPullback({ bars: clean, ignition }),
    detectMomentumCusumPullback({ bars: changed, ignition }),
  );
}

// A one-candle pullback is not accepted.
{
  const bars = fixture();
  bars[72] = bar(72, 100.46, 100.67, 100.44, 100.65, 150);
  const result = detectMomentumCusumPullback({ bars, ignition });
  assert.equal(result.action, "wait");
}

// A market-data gap invalidates the sequential pattern.
{
  const bars = fixture();
  bars[72] = { ...bars[72]!, closeTime: new Date(Date.parse(bars[72]!.closeTime) + 60_000).toISOString() };
  const result = detectMomentumCusumPullback({ bars, ignition });
  assert.equal(result.action, "wait");
  assert.match(result.reason, /gap/i);
}

// End-to-end ignition scanning receives only point-in-time ATR context.
{
  const bars = fixture();
  const references = bars.map(() => 1);
  const detected = scanMomentumCusumIgnitions({ bars, referenceM5AtrByIndex: references });
  assert.ok(detected.some((item) => item.direction === "long" && item.index >= 66 && item.index <= 70));
}

// A sigmoid confidence is learned from outcomes; it is unavailable when thin.
{
  const thin = fitSigmoidCalibration([{ rawScore: 50, won: true }], 20);
  assert.equal(thin, null);
  const samples = Array.from({ length: 200 }, (_, index) => ({ rawScore: index % 100, won: index % 100 >= 55 }));
  const fitted = fitSigmoidCalibration(samples, 100);
  assert.ok(fitted);
  assert.ok(fitted.slope > 0);
  const low = calibratedWinProbability(fitted, 20);
  const high = calibratedWinProbability(fitted, 80);
  assert.ok(low !== null && high !== null && low < high);
}

assert.equal(invertMomentumCusumDirection("long"), "short");
assert.equal(invertMomentumCusumDirection("short"), "long");
assert.deepEqual(MOMENTUM_CUSUM_CONFIG, {
  volatilityLookbackBars: 60,
  cusumThreshold: 2.5,
  cusumDrift: 0.05,
  maxReturnZ: 6,
  refractoryBars: 15,
  impulseLookbackBars: 5,
  minImpulseM5Atr: 0.15,
  maxImpulseM5Atr: 0.90,
  maxPrePullbackBars: 1,
  minPullbackBars: 2,
  maxPullbackBars: 3,
  minRetracementFraction: 0.10,
  maxRetracementFraction: 0.55,
  maxPullbackBarRangeImpulse: 0.75,
  resumeBufferM5Atr: 0.01,
  maxEntryExtensionM5Atr: 0.15,
  stopBufferM5Atr: 0.02,
  minStopM5Atr: 0.05,
  maxStopM5Atr: 0.60,
  targetR: 2,
  structureLookbackBars: 30,
  calibrationMinimumSamples: 100,
});

console.log("momentum CUSUM pullback tests passed");

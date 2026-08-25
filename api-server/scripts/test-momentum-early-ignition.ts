import assert from "node:assert/strict";
import {
  MOMENTUM_EARLY_IGNITION_CONFIG,
  detectMomentumEarlyIgnition,
  invertMomentumIgnitionDirection,
  type MomentumIgnitionBar,
} from "../src/momentum-early-ignition.js";

const base = Date.UTC(2026, 7, 24, 6, 0);

function bar(closeMs: number, open: number, high: number, low: number, close: number): MomentumIgnitionBar {
  return { closeTime: new Date(closeMs).toISOString(), open, high, low, close };
}

function fixture() {
  const m15Bars: MomentumIgnitionBar[] = Array.from({ length: 28 }, (_, index) => {
    const center = 100 + ((index % 3) - 1) * 0.03;
    return bar(base - 4 * 60 * 60_000 + (index + 1) * 15 * 60_000, center - 0.05, 100.50, 99.50, center + 0.05);
  });
  const m5Bars: MomentumIgnitionBar[] = Array.from({ length: 61 }, (_, index) => {
    const center = 100 + ((index % 3) - 1) * 0.02;
    return bar(base + (index + 1) * 5 * 60_000, center - 0.02, center + 0.15, center - 0.15, center + 0.02);
  });
  // 09:05Z ignition; the old M15 Momentum decision is 10:00Z.
  m5Bars[36] = bar(base + 37 * 5 * 60_000, 100.00, 100.86, 99.96, 100.80);
  m5Bars[37] = bar(base + 38 * 5 * 60_000, 100.82, 101.00, 100.70, 100.90);
  return { m15Bars, m5Bars, originalDecisionTime: new Date(base + 4 * 60 * 60_000).toISOString() };
}

// A completed M5 range/swing break is detected 55 minutes before the old signal.
{
  const input = fixture();
  const result = detectMomentumEarlyIgnition(input);
  assert.equal(result.action, "ignite");
  assert.equal(result.direction, "long");
  assert.equal(result.triggerIndex, 36);
  assert.equal(result.entryIndex, 37);
  assert.equal(result.leadMinutes, 55);
  assert.ok(result.ruleStrength >= 60 && result.ruleStrength <= 100);
  assert.ok(result.compressionRangeAtr !== null && result.compressionRangeAtr <= 2);
}

// Short logic is the exact price mirror of long logic.
{
  const input = fixture();
  const mirror = (item: MomentumIgnitionBar): MomentumIgnitionBar => ({
    ...item,
    open: 200 - item.open,
    high: 200 - item.low,
    low: 200 - item.high,
    close: 200 - item.close,
  });
  const result = detectMomentumEarlyIgnition({
    ...input,
    m15Bars: input.m15Bars.map(mirror),
    m5Bars: input.m5Bars.map(mirror),
  });
  assert.equal(result.action, "ignite");
  assert.equal(result.direction, "short");
  assert.equal(result.leadMinutes, 55);
}

// Future high/low/close values in the entry candle cannot influence the signal;
// only its already-known opening price is used.
{
  const clean = fixture();
  const changed = fixture();
  changed.m5Bars[37] = { ...changed.m5Bars[37]!, high: 150, low: 50, close: 75 };
  assert.deepEqual(detectMomentumEarlyIgnition(changed), detectMomentumEarlyIgnition(clean));
}

// M15 candles that close after the ignition candle opens are also unavailable.
{
  const clean = fixture();
  const changed = fixture();
  changed.m15Bars.push(
    bar(base + 3 * 60 * 60_000 + 15 * 60_000, 100, 150, 50, 75),
    bar(base + 3 * 60 * 60_000 + 30 * 60_000, 75, 175, 25, 125),
  );
  assert.deepEqual(detectMomentumEarlyIgnition(changed), detectMomentumEarlyIgnition(clean));
}

// An entry that gaps too far beyond the broken level is explicitly rejected.
{
  const input = fixture();
  input.m5Bars[37] = { ...input.m5Bars[37]!, open: 101.20 };
  const result = detectMomentumEarlyIgnition(input);
  assert.equal(result.action, "wait");
  assert.equal(result.direction, null);
}

// A breakout occurring at the old decision time is not an early signal.
{
  const input = fixture();
  input.m5Bars[36] = bar(base + 37 * 5 * 60_000, 100.00, 100.15, 99.85, 100.02);
  input.m5Bars[47] = bar(base + 48 * 5 * 60_000, 100.00, 100.86, 99.96, 100.80);
  input.m5Bars[48] = bar(base + 49 * 5 * 60_000, 100.82, 101.00, 100.70, 100.90);
  const result = detectMomentumEarlyIgnition(input);
  assert.equal(result.action, "wait");
}

assert.equal(invertMomentumIgnitionDirection("long"), "short");
assert.equal(invertMomentumIgnitionDirection("short"), "long");
assert.deepEqual(MOMENTUM_EARLY_IGNITION_CONFIG, {
  searchLeadMinutes: 90,
  compressionBars: 4,
  maxCompressionRangeAtr: 2.0,
  microBreakBars: 6,
  atrPeriod: 14,
  breakoutBufferM15Atr: 0.03,
  minBodyRatio: 0.60,
  minBodyM5Atr: 0.50,
  maxCloseFromExtremeFraction: 0.25,
  maxEntryExtensionM15Atr: 0.50,
});

console.log("momentum early ignition tests passed");

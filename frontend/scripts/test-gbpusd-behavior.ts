/**
 * GBPUSD 30M Dual-Origin V2 — behavior tests. Proves the frozen V2 mechanics on
 * the CURRENT evaluator: dual origins (10:30/11:00), causal 9-bar (10:30) / 10-bar
 * (11:00) 06:00-range, EMA20/EMA50 trend, strict close breakout, and the
 * TradingView hedging-block overlap rule. Synthetic M30 candles; read-only.
 */
import assert from "node:assert/strict";
import { evaluateGbpusdStrategyTrace, gbpusdOverlapDecision } from "../src/lib/strategy/strategies/gbpusd-strategy.js";
import type { Candle } from "../src/types/forex.js";

const START = Date.parse("2026-01-01T00:00:00.000Z");
const DAY = 48;            // M30 bars per day
const TEST_DAY = 4;        // 2026-01-05
const idx = (h: number, m: number) => TEST_DAY * DAY + h * 2 + (m === 30 ? 1 : 0);
const tsAt = (h: number, m: number) => new Date(START + idx(h, m) * 30 * 60_000).toISOString();
type OHLC = { open: number; high: number; low: number; close: number };

// Rising ramp -> EMA20 > EMA50 (LONG trend); "down" -> SHORT trend.
function build(trend: "up" | "down", overrides: Record<number, OHLC>): Candle[] {
  const ramp = (i: number) => trend === "up" ? 1.2400 + i * 0.0001 : 1.3200 - i * 0.0001;
  const rows: Candle[] = [];
  for (let i = 0; i < 5 * DAY; i += 1) {
    const close = ramp(i), open = i === 0 ? close - 0.0001 : ramp(i - 1);
    rows.push({ time: new Date(START + i * 30 * 60_000).toISOString(), open, high: Math.max(open, close) + 0.0002, low: Math.min(open, close) - 0.0002, close, volume: 1, complete: true });
  }
  for (const [i, o] of Object.entries(overrides)) rows[Number(i)] = { ...rows[Number(i)]!, ...o };
  return rows;
}
// Fill the current-day 06:00-10:00 range bars (9 bars) with a known band around `base`.
function rangeBars(base: number, band = 0.0010): Record<number, OHLC> {
  const o: Record<number, OHLC> = {};
  for (let h = 6; h <= 10; h += 1) for (const m of (h === 10 ? [0] : [0, 30])) o[idx(h, m)] = { open: base, high: base + band, low: base - band, close: base }; // 06:00..10:00 = 9 bars
  return o;
}
const PRE_HIGH = 0; // computed per test from base+band

let passed = 0, total = 0;
function rowAt(candles: Candle[], h: number, m: number) { return evaluateGbpusdStrategyTrace(candles).rows.find((r) => r.timestamp === tsAt(h, m))!; }
function run(label: string, r: ReturnType<typeof rowAt>, expect: { long?: boolean; short?: boolean; rangeBars?: number; preHigh?: number; preLow?: number }, extra?: () => void) {
  total += 1;
  if (expect.long !== undefined) assert.equal(r.rawLongSignal, expect.long, `${label}: rawLongSignal expected ${expect.long} [trend=${r.trend} rangeReady=${r.rangeReady} bars=${r.rangeBars}/${r.expectedRangeBars} preHigh=${r.preRangeHigh} close-breakout]`);
  if (expect.short !== undefined) assert.equal(r.rawShortSignal, expect.short, `${label}: rawShortSignal expected ${expect.short} [trend=${r.trend} preLow=${r.preRangeLow}]`);
  if (expect.rangeBars !== undefined) assert.equal(r.rangeBars, expect.rangeBars, `${label}: rangeBars ${expect.rangeBars} expected, got ${r.rangeBars}`);
  if (expect.preHigh !== undefined) assert.ok(Math.abs((r.preRangeHigh ?? -1) - expect.preHigh) < 1e-9, `${label}: preHigh ${expect.preHigh} expected, got ${r.preRangeHigh}`);
  extra?.();
  console.log(`  ${label}: OK (origin=${r.origin} trend=${r.trend} bars=${r.rangeBars}/${r.expectedRangeBars} preHigh=${r.preRangeHigh?.toFixed(5)} preLow=${r.preRangeLow?.toFixed(5)} long=${r.rawLongSignal} short=${r.rawShortSignal})`);
  passed += 1;
}

const B = 1.2605;                 // range base for LONG tests
const RH = B + 0.0010, RL = B - 0.0010; // 9-bar preHigh/preLow = 1.2615 / 1.2595

// ---- A: 10:30 LONG — EMA up, 9-bar range, close > preHigh ----
{ const c = build("up", { ...rangeBars(B), [idx(10, 30)]: { open: 1.2620, high: 1.2632, low: 1.2618, close: 1.2630 } });
  run("A (10:30 LONG)", rowAt(c, 10, 30), { long: true, short: false, rangeBars: 9, preHigh: RH }, () => {}); }

// ---- B: 11:00 LONG — EMA up, 10-bar range (includes 10:30), close > preHigh ----
{ const c = build("up", { ...rangeBars(B), [idx(10, 30)]: { open: 1.2620, high: 1.2640, low: 1.2618, close: 1.2622 }, [idx(11, 0)]: { open: 1.2641, high: 1.2652, low: 1.2639, close: 1.2650 } });
  // 11:00 preHigh = max(9-bar 1.2615, the 10:30 bar high 1.2640) = 1.2640
  run("B (11:00 LONG)", rowAt(c, 11, 0), { long: true, short: false, rangeBars: 10, preHigh: 1.2640 }); }

// ---- C: 10:30 SHORT — EMA down, close < preLow ----
{ const base = 1.2805; const c = build("down", { ...rangeBarsAt(base), [idx(10, 30)]: { open: 1.2790, high: 1.2792, low: 1.2778, close: 1.2780 } });
  run("C (10:30 SHORT)", rowAt(c, 10, 30), { long: false, short: true, rangeBars: 9 }, () => {}); }

// ---- D: 11:00 SHORT — EMA down, close < preLow (10-bar) ----
{ const base = 1.2805; const c = build("down", { ...rangeBarsAt(base), [idx(10, 30)]: { open: 1.2792, high: 1.2794, low: 1.2770, close: 1.2791 }, [idx(11, 0)]: { open: 1.2769, high: 1.2771, low: 1.2758, close: 1.2760 } });
  run("D (11:00 SHORT)", rowAt(c, 11, 0), { long: false, short: true, rangeBars: 10 }); }

// ---- E: trend neutral is impossible on a ramp; instead prove trend gates: EMA down but a LONG breakout -> NO long ----
{ const c = build("down", { ...rangeBarsAt(1.2805), [idx(10, 30)]: { open: 1.2820, high: 1.2832, low: 1.2818, close: 1.2830 } });
  run("E (LONG breakout but EMA down -> no long)", rowAt(c, 10, 30), { long: false }, () => { const r = rowAt(c, 10, 30); assert.equal(r.trend, "SHORT", "E: trend is SHORT"); }); }

// ---- F: no breakout (close inside range) -> no signal ----
{ const c = build("up", { ...rangeBars(B), [idx(10, 30)]: { open: 1.2605, high: 1.2612, low: 1.2598, close: 1.2608 } }); // close 1.2608 < preHigh 1.2615
  run("F (no breakout)", rowAt(c, 10, 30), { long: false, short: false }); }

// ---- G: 10:30 origin EXCLUDES its own bar (uses 9 bars 06:00-10:00) ----
// The 10:30 bar's own high (1.2700) is the highest of the morning, yet its preHigh
// must remain the 9-bar high (1.2615); close below that -> no long, isolating the range build.
{ const c = build("up", { ...rangeBars(B), [idx(10, 30)]: { open: 1.2610, high: 1.2700, low: 1.2605, close: 1.2610 } });
  run("G (10:30 excludes own bar)", rowAt(c, 10, 30), { rangeBars: 9, preHigh: RH, long: false }, () => { assert.ok((rowAt(c, 10, 30).preRangeHigh ?? 0) < 1.2700, "G: preHigh excludes the 10:30 bar's own 1.2700 high"); }); }

// ---- H: 11:00 origin INCLUDES the 10:30 bar (10 bars 06:00-10:30) ----
{ const c = build("up", { ...rangeBars(B), [idx(10, 30)]: { open: 1.2620, high: 1.2700, low: 1.2618, close: 1.2620 }, [idx(11, 0)]: { open: 1.2621, high: 1.2632, low: 1.2619, close: 1.2630 } });
  run("H (11:00 includes 10:30 bar)", rowAt(c, 11, 0), { rangeBars: 10, preHigh: 1.2700 }, () => { const r = rowAt(c, 11, 0); assert.equal(r.rawLongSignal, false, "H: close 1.2630 < 1.2700 preHigh -> no breakout"); }); }

// ---- I: range not ready (a range bar missing) -> no signal ----
{ const base = B; const rb = rangeBars(base); delete rb[idx(8, 0)]; // remove the 08:00 bar
  const c = build("up", { ...rb, [idx(10, 30)]: { open: 1.2620, high: 1.2632, low: 1.2618, close: 1.2630 } });
  // Rebuild without the 08:00 candle entirely (filter it out so the slot is truly absent).
  const filtered = c.filter((k) => k.time !== new Date(START + idx(8, 0) * 30 * 60_000).toISOString());
  const r = evaluateGbpusdStrategyTrace(filtered).rows.find((x) => x.timestamp === tsAt(10, 30))!;
  total += 1; assert.equal(r.rangeReady, false, "I: rangeReady false with a missing range bar"); assert.equal(r.rawLongSignal, false, "I: no signal"); console.log(`  I (missing range bar): OK (bars=${r.rangeBars}/${r.expectedRangeBars} rangeReady=${r.rangeReady} -> long=${r.rawLongSignal})`); passed += 1; }

// ---- J/K/L: hedging-block overlap decision (pure function) ----
{ total += 1;
  const legLong = [{ strategyId: "gbpusd_strategy", originCode: "1030", direction: "long" as const }];
  const legShort = [{ strategyId: "gbpusd_strategy", originCode: "1030", direction: "short" as const }];
  // Opposite blocked when a leg is open (hedging disabled)
  assert.equal(gbpusdOverlapDecision({ originCode: "1100", direction: "short", openLegs: legLong, hedgingEnabled: false }).allowed, false, "opposite (short vs open long) blocked");
  assert.equal(gbpusdOverlapDecision({ originCode: "1100", direction: "long", openLegs: legShort, hedgingEnabled: false }).allowed, false, "opposite (long vs open short) blocked");
  // Same direction allowed (pyramiding across the two origins)
  assert.equal(gbpusdOverlapDecision({ originCode: "1100", direction: "long", openLegs: legLong, hedgingEnabled: false }).allowed, true, "same-direction second origin allowed");
  // Same origin already open -> duplicate blocked
  assert.equal(gbpusdOverlapDecision({ originCode: "1030", direction: "long", openLegs: legLong, hedgingEnabled: false }).blockReason, "DUPLICATE_SIGNAL", "same-origin duplicate blocked");
  // Flat -> allowed either direction
  assert.equal(gbpusdOverlapDecision({ originCode: "1030", direction: "short", openLegs: [], hedgingEnabled: false }).allowed, true, "flat allows entry");
  console.log("  J/K/L (hedging overlap): OK (opposite blocked, same-dir allowed, duplicate blocked, flat allowed)"); passed += 1; }

// helper for SHORT range bars around a base (declining ambient)
function rangeBarsAt(base: number, band = 0.0010): Record<number, OHLC> {
  const o: Record<number, OHLC> = {};
  for (let h = 6; h <= 10; h += 1) for (const m of (h === 10 ? [0] : [0, 30])) o[idx(h, m)] = { open: base, high: base + band, low: base - band, close: base };
  return o;
}

console.log(`\nGBPUSD V2 behavior tests: PASS (${passed}/${total}) — dual origin 10:30/11:00, causal 9/10-bar 06:00 range, EMA20/EMA50 trend, strict breakout, hedging-block overlap.`);

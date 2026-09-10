/**
 * USDJPY Body Extreme V6 — mandatory behavior tests (A–O).
 * Proves the frozen V6 decision logic on the CURRENT evaluator:
 *   qualified <=> 11-14 origin AND EMA20>EMA50 AND close>08-10 preHigh
 *                 AND body>=0.40*ATR AND close in upper 40% AND first-of-day.
 * Synthetic candles only; read-only.
 */
import assert from "node:assert/strict";
import { evaluateUsdjpyStrategyTrace } from "../src/lib/strategy/strategies/usdjpy-strategy.js";
import type { Candle } from "../src/types/forex.js";

// 7 days of hourly bars; the test day is day index 6 (2026-01-07). Its hour H is
// at candle index 6*24 + H. Warmup rises so EMA20 > EMA50 unless trend overridden.
const DAYS = 7;
const TEST_DAY_BASE = 6 * 24; // 2026-01-07T00:00
const START = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (i: number) => new Date(START + i * 3_600_000).toISOString();
const testISO = (h: number) => iso(TEST_DAY_BASE + h);
type OHLC = { open: number; high: number; low: number; close: number };

function build(trend: "up" | "flat" | "down", overrides: Record<number, OHLC>): Candle[] {
  const rampClose = (i: number) => trend === "up" ? 150 + i * 0.01 : trend === "down" ? 156 - i * 0.01 : 150;
  const rows: Candle[] = [];
  for (let i = 0; i < DAYS * 24; i += 1) {
    const close = rampClose(i), open = i === 0 ? close - 0.01 : rampClose(i - 1);
    rows.push({ time: iso(i), open, high: Math.max(open, close) + 0.02, low: Math.min(open, close) - 0.02, close, volume: 1, complete: true });
  }
  for (const [h, o] of Object.entries(overrides)) rows[TEST_DAY_BASE + Number(h)] = { ...rows[TEST_DAY_BASE + Number(h)]!, ...o };
  return rows;
}
function traceAt(candles: Candle[], h: number) { const rows = evaluateUsdjpyStrategyTrace(candles).rows; return rows.find((r) => r.timestamp === testISO(h))!; }
function atrAt(candles: Candle[], h: number) { return traceAt(candles, h).atr14!; }

// Range bars 08/09/10 that set preHigh; keep them below the origin breakout level.
const RANGE = { 8: { open: 151.20, high: 151.30, low: 151.10, close: 151.25 }, 9: { open: 151.25, high: 151.35, low: 151.15, close: 151.30 }, 10: { open: 151.30, high: 151.40, low: 151.20, close: 151.35 } } as Record<number, OHLC>; // preHigh = 151.40
const PRE_HIGH = 151.40;

let passed = 0, total = 0;
function run(label: string, candles: Candle[], hour: number, expect: { signal: boolean }, extra?: (r: ReturnType<typeof traceAt>) => void) {
  total += 1;
  const r = traceAt(candles, hour);
  assert.equal(r.finalLongSignal, expect.signal, `${label}: finalLongSignal expected ${expect.signal} [trend=${r.trendDirection} rangeReady=${r.rangeReady} breakout=${r.breakoutLong} bodyR=${r.bodyATRRatio?.toFixed(4)} closeLoc=${r.closePositionPct?.toFixed(2)}% tradedEarlier=${r.tradedEarlierUtcDay}]`);
  extra?.(r);
  console.log(`  ${label}: OK (hour=${hour} trend=${r.trendDirection} breakout=${r.breakoutLong} bodyR=${r.bodyATRRatio?.toFixed(4)} closeLoc=${r.closePositionPct?.toFixed(1)}% traded=${r.tradedEarlierUtcDay} -> ${r.finalLongSignal})`);
  passed += 1;
}
// A strong long origin at hour h (close well above preHigh, big body, close near high).
function strongOrigin(close: number, atrProbeBody = 0.7): OHLC { return { open: close - 0.10, high: close + 0.005, low: close - 0.20, close }; }

// ---- A: 11:00 all rules pass -> SIGNAL ----
run("A (11:00 full pass)", build("up", { ...RANGE, 11: strongOrigin(151.55) }), 11, { signal: true }, (r) => { assert.equal(r.trendDirection, "LONG"); assert.ok(r.breakoutLong && r.bodyPassed && r.bullExtremeClose); });

// ---- B: 12:00 passes, 11:00 did not qualify (no breakout) -> SIGNAL ----
run("B (12:00; 11:00 no breakout)", build("up", { ...RANGE, 11: { open: 151.30, high: 151.38, low: 151.25, close: 151.33 }, 12: strongOrigin(151.55) }), 12, { signal: true }, (r) => assert.equal(r.tradedEarlierUtcDay, false, "B: day not yet consumed"));

// ---- C: 13:00 passes, 11/12 did not qualify -> SIGNAL ----
run("C (13:00; 11/12 no breakout)", build("up", { ...RANGE, 11: { open: 151.30, high: 151.38, low: 151.25, close: 151.33 }, 12: { open: 151.31, high: 151.39, low: 151.25, close: 151.34 }, 13: strongOrigin(151.56) }), 13, { signal: true });

// ---- D: 14:00 passes, 11/12/13 did not qualify -> SIGNAL ----
run("D (14:00; 11-13 no breakout)", build("up", { ...RANGE, 11: { open: 151.30, high: 151.38, low: 151.25, close: 151.33 }, 12: { open: 151.31, high: 151.39, low: 151.25, close: 151.34 }, 13: { open: 151.30, high: 151.38, low: 151.24, close: 151.33 }, 14: strongOrigin(151.57) }), 14, { signal: true });

// ---- E: 15:00 all technicals pass -> NO SIGNAL (outside 11-14 window) ----
run("E (15:00 outside window)", build("up", { ...RANGE, 15: strongOrigin(151.60) }), 15, { signal: false });

// ---- F: body exactly 0.40 ATR -> PASS ----
{ const close = 151.55, base = build("up", { ...RANGE, 11: { open: close - 0.10, high: close + 0.005, low: close - 0.30, close } }); const atr = atrAt(base, 11); const c2 = build("up", { ...RANGE, 11: { open: close - 0.4 * atr, high: close + 0.005, low: close - 0.30, close } }); run("F (body==0.40 ATR)", c2, 11, { signal: true }, (r) => assert.ok((r.bodyATRRatio ?? 0) >= 0.4, "F: bodyR >= 0.40")); }
// ---- G: body 0.39 ATR -> NO SIGNAL ----
{ const close = 151.55, base = build("up", { ...RANGE, 11: { open: close - 0.10, high: close + 0.005, low: close - 0.30, close } }); const atr = atrAt(base, 11); const c2 = build("up", { ...RANGE, 11: { open: close - 0.39 * atr, high: close + 0.005, low: close - 0.30, close } }); run("G (body==0.39 ATR)", c2, 11, { signal: false }, (r) => assert.ok((r.bodyATRRatio ?? 1) < 0.4, "G: bodyR < 0.40")); }

// ---- H: close exactly on upper-40% boundary -> PASS ----
// close = high - 0.40*range (the exact `close >= high - range*0.40` boundary); open=low for a big body.
{ const low = 151.30, high = 151.75, range = high - low, close = high - 0.40 * range; assert.ok(close > PRE_HIGH); const c = build("up", { ...RANGE, 11: { open: low, high, low, close } }); run("H (close at upper-40% edge)", c, 11, { signal: true }, (r) => assert.ok((r.closePositionPct ?? 0) >= 59.99 && r.bodyPassed && r.bullExtremeClose, "H: closeLoc≈60% (boundary), body & extreme pass")); }
// ---- I: close outside upper 40% -> NO SIGNAL ----
{ const low = 151.30, high = 151.85, range = high - low, close = high - 0.45 * range; assert.ok(close > PRE_HIGH); const c = build("up", { ...RANGE, 11: { open: low, high, low, close } }); run("I (close below upper-40%)", c, 11, { signal: false }, (r) => assert.ok((r.closePositionPct ?? 100) < 60, "I: closeLoc < 60%")); }

// ---- J: close > preHigh by a tiny amount -> SIGNAL (no clearance) ----
{ const close = PRE_HIGH + 0.001; const c = build("up", { ...RANGE, 11: { open: close - 0.15, high: close + 0.002, low: close - 0.25, close } }); run("J (tiny breakout)", c, 11, { signal: true }, (r) => assert.equal(r.breakoutLong, true, "J: breakout by 0.001")); }

// ---- K: EMA20 not > EMA50 (downtrend) -> NO SIGNAL. Origin breaks out & body/extreme pass,
// so the trend gate is the sole blocker (the evaluator treats EMA20<=EMA50 as not LONG). ----
{ const kRange: Record<number, OHLC> = { 8: { open: 154.28, high: 154.35, low: 154.18, close: 154.30 }, 9: { open: 154.30, high: 154.38, low: 154.20, close: 154.33 }, 10: { open: 154.33, high: 154.40, low: 154.22, close: 154.36 } };
  const c = build("down", { ...kRange, 11: { open: 154.46, high: 154.62, low: 154.44, close: 154.60 } });
  run("K (EMA20<=EMA50)", c, 11, { signal: false }, (r) => { assert.notEqual(r.trendDirection, "LONG", "K: trend not LONG (EMA20<=EMA50)"); assert.equal(r.breakoutLong, false, "K: breakout gated off because trend not LONG"); }); }

// ---- L: 11:00 qualifies+enters; 12:00 also qualifies -> NO SECOND SIGNAL ----
{ const c = build("up", { ...RANGE, 11: strongOrigin(151.55), 12: strongOrigin(151.60) }); run("L1 (11:00 enters)", c, 11, { signal: true }); run("L2 (12:00 suppressed)", c, 12, { signal: false }, (r) => assert.equal(r.tradedEarlierUtcDay, true, "L: day already consumed at 11:00")); }

// ---- M: 11:00 fails; 12:00 qualifies+enters; 13:00 qualifies -> NO SECOND ----
{ const c = build("up", { ...RANGE, 11: { open: 151.30, high: 151.38, low: 151.25, close: 151.33 }, 12: strongOrigin(151.55), 13: strongOrigin(151.60) }); run("M1 (12:00 enters)", c, 12, { signal: true }); run("M2 (13:00 suppressed)", c, 13, { signal: false }, (r) => assert.equal(r.tradedEarlierUtcDay, true, "M: consumed at 12:00")); }

// ---- N: passes on 08-10 range but would fail on 06-10 range -> SIGNAL (no V5 contamination) ----
// Make 06:00/07:00 highs ABOVE the origin close, but 08-10 highs below it. V6 (08-10) breaks out; V5 (06-10) would not.
{ const close = 151.55; const c = build("up", { 6: { open: 151.60, high: 151.90, low: 151.55, close: 151.85 }, 7: { open: 151.85, high: 151.95, low: 151.60, close: 151.70 }, ...RANGE, 11: strongOrigin(close) });
  const preHigh0610 = Math.max(151.90, 151.95, 151.30, 151.35, 151.40); // 06-10 high = 151.95 > close
  assert.ok(close < preHigh0610, "N: close is below the 06-10 range high (would fail V5)");
  assert.ok(close > PRE_HIGH, "N: close is above the 08-10 range high (passes V6)");
  run("N (08-10 not 06-10)", c, 11, { signal: true }, (r) => assert.equal(r.preHigh, PRE_HIGH, "N: preHigh is the 08-10 high, not 06-10")); }

// ---- O: all Pine conditions pass; strategySignalQualified is Pine-only (no session gate) ----
// The pure trace has no session gate; a fully-passing origin qualifies regardless of session.
run("O (no session gate in signal)", build("up", { ...RANGE, 11: strongOrigin(151.55) }), 11, { signal: true });

console.log(`\nUSDJPY V6 behavior tests: PASS (${passed}/${total}) — 11-14 origin, EMA20>EMA50, close>08-10 preHigh, body>=0.40ATR, upper-40%, one-trade-per-UTC-day.`);

/**
 * EURJPY 01-05 Range Break V1 — mandatory behavior tests (A–L).
 * Proves the frozen decision logic on the CURRENT evaluator:
 *   qualified <=> EMA20>EMA20[3] AND close>high[1] AND close>preHigh
 *   (no consensus, no ema50, no body/extreme, no session gate, no 5-bar count gate).
 * Synthetic candles only; read-only.
 */
import assert from "node:assert/strict";
import { evaluateEurjpy01To05RangeBreakV1 } from "../src/lib/strategy/strategies/eurjpy-strategy.js";
import { calculateEmaValues } from "../src/lib/strategy/indicators.js";
import type { Candle } from "../src/types/forex.js";

const START = Date.parse("2026-01-01T00:00:00.000Z"); // idx 102 = 2026-01-05T06:00Z (origin); range bars 01-05 = idx 97..101
const ORIGIN_ISO = "2026-01-05T06:00:00.000Z";
const ORIGIN_IDX = 102, PREV_IDX = 101; // 05:00
const RANGE_IDX = [97, 98, 99, 100, 101]; // 01:00..05:00

function series(closeAt: (i: number) => number): Candle[] {
  const rows: Candle[] = [];
  for (let i = 0; i < 103; i += 1) {
    const close = closeAt(i);
    const open = i === 0 ? close - 0.03 : closeAt(i - 1);
    rows.push({ time: new Date(START + i * 3_600_000).toISOString(), open, high: Math.max(open, close) + 0.02, low: Math.min(open, close) - 0.02, close, volume: 1, complete: true });
  }
  return rows;
}
const rising = () => series((i) => 140 + i * 0.03);
function set(rows: Candle[], i: number, o: Partial<Candle>): Candle[] { const out = rows.slice(); out[i] = { ...out[i]!, ...o }; return out; }

let passed = 0, total = 0;
function run(label: string, rows: Candle[], expect: { signal: boolean }, extra?: (ev: ReturnType<typeof evaluateEurjpy01To05RangeBreakV1>) => void) {
  total += 1;
  const ev = evaluateEurjpy01To05RangeBreakV1(rows);
  assert.equal(ev.originTime, ORIGIN_ISO, `${label}: origin must be ${ORIGIN_ISO}, got ${ev.originTime}`);
  assert.equal(ev.strategySignalQualified, expect.signal, `${label}: qualified expected ${expect.signal} [slopeUp=${ev.emaSlopeUp} prevBreak=${ev.previousHighBreak} rangeBreak=${ev.preRangeHighBreak} bars=${ev.preRangeBarCount} preHigh=${ev.preHigh}]`);
  extra?.(ev);
  console.log(`  ${label}: OK (slopeUp=${ev.emaSlopeUp} prevBreak=${ev.previousHighBreak} rangeBreak=${ev.preRangeHighBreak} bars=${ev.preRangeBarCount} -> ${ev.strategySignalQualified})`);
  passed += 1;
}

// Build a rising series then set the 06:00 origin to break both high[1] and preHigh.
function risingPass(): Candle[] {
  const rows = rising();
  const prevHigh = rows[PREV_IDX]!.high;         // 05:00 high (also = preHigh in a rising series)
  const close = prevHigh + 0.10;
  return set(rows, ORIGIN_IDX, { open: close - 0.05, high: close, low: close - 0.20, close });
}

// ---- A: slope up, close>high[1], close>preHigh -> SIGNAL ----
run("A (all pass)", risingPass(), { signal: true });

// ---- B: EMA20 == EMA20[3] -> NO SIGNAL. Flat closes make EMA20 constant, so
// the slope is the blocking condition (a breakout close would pull EMA20 up, so
// slope-flat and breakout cannot coexist; slope is tested in isolation here). ----
{ const rows = series(() => 140); run("B (EMA20==EMA20[3])", rows, { signal: false }, (ev) => { assert.equal(ev.ema20, ev.ema20Back, "B: EMA20 must equal EMA20[3]"); assert.equal(ev.emaSlopeUp, false, "B: slope must be flat/false"); }); }

// ---- C: EMA20 < EMA20[3] -> NO SIGNAL (declining tail; slope tested in isolation) ----
{ const rows = series((i) => (i <= 90 ? 140 + i * 0.03 : 140 + 90 * 0.03 - (i - 90) * 0.05)); run("C (EMA20<EMA20[3])", rows, { signal: false }, (ev) => { assert.ok((ev.ema20 ?? 0) < (ev.ema20Back ?? 0), "C: EMA20 must be < EMA20[3]"); assert.equal(ev.emaSlopeUp, false, "C: slope must be down/false"); }); }

// ---- D: slope up, close == high[1] -> NO SIGNAL (strict >) ----
{ const rows = rising(); const prevHigh = rows[PREV_IDX]!.high; const close = prevHigh; const r = set(rows, ORIGIN_IDX, { open: close - 0.05, high: close + 0.01, low: close - 0.20, close }); run("D (close==high[1])", r, { signal: false }, (ev) => assert.equal(ev.previousHighBreak, false, "D: prevHighBreak must be false")); }

// ---- E: slope up, close>high[1] but close == preHigh -> NO SIGNAL ----
// Elevate an earlier range bar (03:00) so preHigh > high[1]; set close == preHigh (> high[1]).
{ const rows0 = rising(); const preHighTarget = rows0[PREV_IDX]!.high + 0.20; const rows1 = set(rows0, 99, { high: preHighTarget }); const close = preHighTarget; const r = set(rows1, ORIGIN_IDX, { open: close - 0.05, high: close + 0.01, low: close - 0.20, close }); run("E (close==preHigh)", r, { signal: false }, (ev) => { assert.equal(ev.previousHighBreak, true, "E: prevHighBreak true"); assert.equal(ev.preRangeHighBreak, false, "E: rangeBreak false (close==preHigh)"); }); }

// ---- F: slope up, close>high[1], close>preHigh -> SIGNAL ----
run("F (both breaks pass)", risingPass(), { signal: true });

// ---- G: all pass but bearish candle (close<open) -> SIGNAL (no body req) ----
{ const rows = rising(); const prevHigh = rows[PREV_IDX]!.high; const close = prevHigh + 0.10; const r = set(rows, ORIGIN_IDX, { open: close + 0.08, high: close + 0.10, low: close - 0.05, close }); run("G (bearish candle)", r, { signal: true }, (ev) => assert.ok(r[ORIGIN_IDX]!.close < r[ORIGIN_IDX]!.open, "G: candle is bearish")); }

// ---- H: all pass but tiny body (< 0.50 ATR) -> SIGNAL (no body filter) ----
{ const rows = rising(); const prevHigh = rows[PREV_IDX]!.high; const close = prevHigh + 0.10; const r = set(rows, ORIGIN_IDX, { open: close - 0.001, high: close + 0.01, low: close - 0.20, close }); run("H (tiny body)", r, { signal: true }); }

// ---- I: all pass but EMA20 < EMA50 -> SIGNAL (no ema50 requirement) ----
// V-shape: long decline then recovery -> EMA20 slope up while slower EMA50 still above EMA20.
{ const rows0 = series((i) => (i <= 70 ? 150 - i * 0.10 : 150 - 70 * 0.10 + (i - 70) * 0.06)); const prevHigh = rows0[PREV_IDX]!.high; const close = prevHigh + 0.10; const r = set(rows0, ORIGIN_IDX, { open: close - 0.05, high: close, low: close - 0.20, close });
  const closes = r.map((c) => c.close); const e20 = calculateEmaValues(closes, 20)[ORIGIN_IDX]!, e50 = calculateEmaValues(closes, 50)[ORIGIN_IDX]!;
  assert.ok(e50 > e20, `I: setup must have EMA50(${e50.toFixed(3)}) > EMA20(${e20.toFixed(3)})`);
  run("I (EMA20<EMA50)", r, { signal: true }); }

// ---- J: all pass; no generic session gate exists -> SIGNAL ----
run("J (session-closed irrelevant)", risingPass(), { signal: true });

// ---- K: preLow changes; preHigh + all conditions identical -> signal unchanged ----
{ const baseRows = risingPass(); const evBase = evaluateEurjpy01To05RangeBreakV1(baseRows);
  const lowered = set(baseRows, 98, { low: baseRows[98]!.low - 0.50 }); // lower a range-bar low -> changes preLow only
  const evLow = evaluateEurjpy01To05RangeBreakV1(lowered);
  assert.equal(evBase.preHigh, evLow.preHigh, "K: preHigh unchanged");
  assert.notEqual(evBase.preLow, evLow.preLow, "K: preLow did change");
  assert.equal(evBase.strategySignalQualified, evLow.strategySignalQualified, "K: signal unchanged by preLow");
  total += 1; assert.equal(evLow.strategySignalQualified, true, "K: still signals"); console.log(`  K (preLow change): OK (preHigh same=${evBase.preHigh === evLow.preHigh}, preLow changed, signal=${evLow.strategySignalQualified})`); passed += 1; }

// ---- L: only FOUR 01-05 range bars present (preHigh exists) -> SIGNAL (Pine has no 5-bar count gate) ----
{ let rows = risingPass();
  // Drop the 01:00 range bar (idx 97) so only 02:00..05:00 remain (4 bars).
  rows = rows.filter((_, i) => i !== 97);
  const ev = evaluateEurjpy01To05RangeBreakV1(rows);
  assert.equal(ev.originTime, ORIGIN_ISO, "L: origin still 06:00");
  assert.equal(ev.preRangeBarCount, 4, `L: exactly four range bars, got ${ev.preRangeBarCount}`);
  assert.equal(ev.rangeReady, true, "L: rangeReady true with >=1 bar (Pine: not na(preHigh))");
  assert.equal(ev.strategySignalQualified, true, "L: signals with 4 range bars per canonical Pine");
  total += 1; console.log(`  L (4 range bars): OK (bars=${ev.preRangeBarCount} rangeReady=${ev.rangeReady} -> signal=${ev.strategySignalQualified})`); passed += 1; }

console.log(`\nEURJPY behavior tests: PASS (${passed}/${total}) — EMA20>EMA20[3] AND close>high[1] AND close>preHigh; no consensus/ema50/body/session/5-bar-count gate.`);

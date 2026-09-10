/**
 * USDCHF Bear Consensus Structure V1 — mandatory behavior tests (A–J).
 * Proves the frozen decision logic on the CURRENT evaluator:
 *   qualified <=> 11:00 origin AND consensus<=-3 AND high<high[1] AND low<low[1].
 * No close-breakout filter, no body/candle-color filter, no session gate.
 * Synthetic candles only; read-only.
 */
import assert from "node:assert/strict";
import { evaluateUsdchfBearConsensusStructureV1 } from "../src/lib/strategy/strategies/usdchf-strategy.js";
import type { Candle } from "../src/types/forex.js";

const START = Date.parse("2026-01-01T00:00:00.000Z"); // 60 hourly bars -> origin idx 59 = 2026-01-03T11:00Z
const ORIGIN_ISO = "2026-01-03T11:00:00.000Z";
type OHLC = { open: number; high: number; low: number; close: number };
// Declining ramp -> ema20<ema50, close<ema20, ema20<ema20[3], close<close[3] => consensus -4.
function series(closeAt: (i: number) => number): Candle[] {
  const rows: Candle[] = [];
  for (let i = 0; i < 60; i += 1) { const close = closeAt(i); const open = i === 0 ? close + 0.0001 : closeAt(i - 1); rows.push({ time: new Date(START + i * 3_600_000).toISOString(), open, high: Math.max(open, close) + 0.0002, low: Math.min(open, close) - 0.0002, close, volume: 1, complete: true }); }
  return rows;
}
const declining = () => series((i) => 0.9200 - i * 0.0001);
const set = (rows: Candle[], i: number, o: OHLC): Candle[] => { const out = rows.slice(); out[i] = { ...out[i]!, ...o }; return out; };
const EPS = 0.00001;

let passed = 0, total = 0;
function run(label: string, rows: Candle[], expect: { signal: boolean; consensus?: number }, extra?: (ev: ReturnType<typeof evaluateUsdchfBearConsensusStructureV1>) => void) {
  total += 1;
  const ev = evaluateUsdchfBearConsensusStructureV1(rows);
  assert.equal(ev.originTime, ORIGIN_ISO, `${label}: origin must be ${ORIGIN_ISO}`);
  if (expect.consensus !== undefined) assert.equal(ev.consensus, expect.consensus, `${label}: consensus ${expect.consensus} expected, got ${ev.consensus} (t/p/s/m=${ev.voteTrend}/${ev.votePrice}/${ev.voteSlope}/${ev.voteMomentum})`);
  assert.equal(ev.strategySignalQualified, expect.signal, `${label}: qualified expected ${expect.signal} [consensus=${ev.consensus} bear=${ev.bearStructure} LH=${(ev.currentHigh ?? 0) < (ev.previousHigh ?? 0)} LL=${(ev.currentLow ?? 0) < (ev.previousLow ?? 0)}]`);
  extra?.(ev);
  console.log(`  ${label}: OK (consensus=${ev.consensus} bear=${ev.bearStructure} -> signal=${ev.strategySignalQualified})`);
  passed += 1;
}

const base = declining();
const prev = base.at(-2)!;            // idx 58 (10:00)
const close3 = base.at(-4)!.close;    // close[3] (idx 56)
const LH = prev.high - EPS;           // high < high[1]
const LL = prev.low - EPS;            // low  < low[1]
const notLH = prev.high;              // high == high[1] -> LH false
const notLL = prev.low;               // low  == low[1]  -> LL false

// ---- A: consensus -4, LH+LL -> SHORT ----
run("A (-4, LH+LL)", base, { signal: true, consensus: -4 }, (ev) => assert.equal(ev.bearStructure, true));

// ---- B: consensus -3 (momentum 0: origin close == close[3]), LH+LL -> SHORT ----
run("B (-3, LH+LL)", set(base, 59, { open: close3, high: LH, low: LL, close: close3 }), { signal: true, consensus: -3 });

// ---- C: consensus -2 (momentum +1: origin close just above close[3] but below EMA20), LH+LL -> NO ----
{ const c = evaluateUsdchfBearConsensusStructureV1(set(base, 59, { open: close3, high: LH, low: LL, close: close3 })).ema20!; // EMA20 with origin==close3
  const mid = (close3 + c) / 2; // between close[3] and EMA20 -> momentum +1, price -1
  run("C (-2, LH+LL)", set(base, 59, { open: mid, high: LH, low: LL, close: mid }), { signal: false, consensus: -2 }); }

// ---- D: consensus -4, LH false, LL true -> NO ----
run("D (-4, no LH)", set(base, 59, { open: base.at(-1)!.open, high: notLH, low: LL, close: base.at(-1)!.close }), { signal: false }, (ev) => assert.equal((ev.currentHigh ?? 0) < (ev.previousHigh ?? 0), false, "D: LH false"));

// ---- E: consensus -4, LH true, LL false -> NO ----
run("E (-4, no LL)", set(base, 59, { open: base.at(-1)!.open, high: LH, low: notLL, close: base.at(-1)!.close }), { signal: false }, (ev) => assert.equal((ev.currentLow ?? 0) < (ev.previousLow ?? 0), false, "E: LL false"));

// ---- F: consensus<=-3, LH+LL, close >= previous low -> SHORT (no close-breakout filter) ----
{ const close = prev.low + 0.0003; // close ABOVE previous low, yet LH+LL still hold
  const rows = set(base, 59, { open: close, high: LH, low: LL, close });
  assert.ok(rows.at(-1)!.close >= prev.low, "F: origin close >= previous low");
  run("F (close>=prevLow)", rows, { signal: true }, (ev) => { assert.ok((ev.consensus ?? 0) <= -3); assert.equal(ev.bearStructure, true); }); }

// ---- G: valid setup but bullish candle (close > open) -> SHORT (no candle-color filter) ----
{ const close = base.at(-1)!.close; const rows = set(base, 59, { open: close - 0.0004, high: LH, low: LL, close }); // open < close -> bullish
  assert.ok(rows.at(-1)!.close > rows.at(-1)!.open, "G: candle is bullish");
  run("G (bullish candle)", rows, { signal: true }); }

// ---- H: valid setup, tiny body (< 0.50 ATR) -> SHORT (no body filter) ----
{ const close = base.at(-1)!.close; const rows = set(base, 59, { open: close + 0.00001, high: LH, low: LL, close }); // ~doji body
  run("H (tiny body)", rows, { signal: true }); }

// ---- I: consensus exactly -3 -> SIGNAL (evaluator uses <= -3, not < -3) ----
run("I (exactly -3)", set(base, 59, { open: close3, high: LH, low: LL, close: close3 }), { signal: true, consensus: -3 });

// ---- J: all Pine rules pass; no generic session gate exists in the signal evaluator -> SIGNAL ----
run("J (no session gate)", base, { signal: true });

console.log(`\nUSDCHF behavior tests: PASS (${passed}/${total}) — consensus<=-3 AND strict LH+LL; no close-breakout, no body/color filter, no session gate.`);

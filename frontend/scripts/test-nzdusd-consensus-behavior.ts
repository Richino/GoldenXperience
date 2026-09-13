/**
 * NZDUSD Bull Consensus Structure V1 — mandatory behavior tests (A–G).
 * Proves the frozen decision logic on the CURRENT evaluator:
 *   qualified  <=>  consensus >= 3  AND  high>high[1]  AND  low>low[1]
 * and that NO close-breakout filter and NO body filter exist.
 * Synthetic candles only; read-only; no strategy modification.
 */
import assert from "node:assert/strict";
import { evaluateNzdusdBullConsensusStructureV1 } from "../src/lib/strategy/strategies/nzdusd-consensus-strategy.js";
import type { Candle } from "../src/types/forex.js";

const START = Date.parse("2026-01-01T00:00:00.000Z"); // 60 hourly bars -> origin index 59 = 2026-01-03T11:00Z (> Pine start 2023-01-01)

/** Rising ramp; origin (last bar) yields all four votes +1 (consensus +4). */
function baseRamp(): Candle[] {
  return Array.from({ length: 60 }, (_, i) => {
    const open = 0.6 + i * 0.001;
    const close = open + 0.0001;
    return { time: new Date(START + i * 3_600_000).toISOString(), open, high: close + 0.0002, low: open - 0.0002, close, volume: 1, complete: true };
  });
}

/** Overwrite the origin candle's OHLC, leaving all history (and thus EMA/ATR/close[3]) intact. */
function withOrigin(rows: Candle[], o: { open: number; high: number; low: number; close: number }): Candle[] {
  const out = rows.slice();
  const cur = out.at(-1)!;
  out[out.length - 1] = { ...cur, open: o.open, high: o.high, low: o.low, close: o.close };
  return out;
}

const EPS = 0.00001;
let passed = 0;
function check(label: string, rows: Candle[], expect: { consensus?: number; hh: boolean; hl: boolean; signal: boolean }) {
  const ev = evaluateNzdusdBullConsensusStructureV1(rows);
  assert.equal(ev.originTime, "2026-01-03T11:00:00.000Z", `${label}: origin must be the 2026-01-03 11:00 UTC candle`);
  if (expect.consensus !== undefined) assert.equal(ev.consensus, expect.consensus, `${label}: expected consensus ${expect.consensus}, got ${ev.consensus} (votes t/p/s/m=${ev.voteTrend}/${ev.votePrice}/${ev.voteSlope}/${ev.voteMomentum})`);
  assert.equal(ev.higherHigh, expect.hh, `${label}: higherHigh`);
  assert.equal(ev.higherLow, expect.hl, `${label}: higherLow`);
  assert.equal(ev.strategySignalQualified, expect.signal, `${label}: strategySignalQualified expected ${expect.signal}`);
  console.log(`  ${label}: OK  (consensus=${ev.consensus}, HH=${ev.higherHigh}, HL=${ev.higherLow}, signal=${ev.strategySignalQualified})`);
  passed += 1;
}

const ramp = baseRamp();
const prev = ramp.at(-2)!;            // origin-1 (previous H1 candle)
const close3 = ramp.at(-4)!.close;    // close[3]
const hh = prev.high + EPS;           // forces high > high[1]
const hl = prev.low + EPS;            // forces low  > low[1]
const notHH = prev.high;              // high == high[1]  -> HH false
const notHL = prev.low;               // low  == low[1]   -> HL false

// TEST A: consensus +4, HH, HL -> SIGNAL
check("A (+4, HH, HL)", withOrigin(ramp, { open: 0.6580, high: hh, low: hl, close: 0.6591 }), { consensus: 4, hh: true, hl: true, signal: true });

// TEST B: consensus +3, HH, HL -> SIGNAL  (momentum vote 0: origin close == close[3])
check("B (+3, HH, HL)", withOrigin(ramp, { open: 0.6560, high: hh, low: hl, close: close3 }), { consensus: 3, hh: true, hl: true, signal: true });

// TEST C: consensus +2, HH, HL -> NO SIGNAL  (momentum -1: origin close below close[3], still above EMA20)
check("C (+2, HH, HL)", withOrigin(ramp, { open: 0.6530, high: hh, low: hl, close: close3 - 0.0030 }), { consensus: 2, hh: true, hl: true, signal: false });

// TEST D: consensus +4, HH false, HL true -> NO SIGNAL
check("D (+4, no HH, HL)", withOrigin(ramp, { open: 0.6580, high: notHH, low: hl, close: 0.6591 }), { consensus: 4, hh: false, hl: true, signal: false });

// TEST E: consensus +4, HH true, HL false -> NO SIGNAL
check("E (+4, HH, no HL)", withOrigin(ramp, { open: 0.6580, high: hh, low: notHL, close: 0.6591 }), { consensus: 4, hh: true, hl: false, signal: false });

// TEST F: consensus >= +3, HH, HL, close <= high[1] -> SIGNAL  (no close-breakout filter)
{
  const closeBelowPrevHigh = prev.high - EPS; // close <= high[1]
  const rows = withOrigin(ramp, { open: 0.6580, high: hh, low: hl, close: closeBelowPrevHigh });
  assert.ok(rows.at(-1)!.close <= prev.high, "F: origin close must be <= previous high");
  check("F (close<=high[1])", rows, { hh: true, hl: true, signal: true });
}

// TEST G: consensus >= +3, HH, HL, tiny body (< 0.50 ATR) -> SIGNAL  (no body filter)
{
  const rows = withOrigin(ramp, { open: 0.65905, high: 0.6592, low: 0.6579, close: 0.6591 }); // body = 0.00005
  const ev = evaluateNzdusdBullConsensusStructureV1(rows);
  const body = Math.abs(rows.at(-1)!.close - rows.at(-1)!.open);
  assert.ok(ev.atr14 !== null && body < 0.5 * ev.atr14, `G: body ${body} must be < 0.5*ATR ${ev.atr14}`);
  check("G (tiny body)", rows, { hh: true, hl: true, signal: true });
}

console.log(`\nNZDUSD consensus behavior tests: PASS (${passed}/7) — consensus>=3 AND strict HH+HL; no close-breakout, no body filter.`);

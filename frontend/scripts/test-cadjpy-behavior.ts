/**
 * CADJPY Bull Break Extreme V1 — mandatory behavior tests (A–K).
 * Proves the frozen decision logic on the CURRENT evaluator:
 *   qualified <=> consensus>=3 AND close>high[1] AND close>open
 *                 AND body>=0.5*ATR AND close in upper 25% of range.
 * and that NO 0.10-ATR clearance and NO 07-11 range filter exist.
 * Synthetic candles only; read-only; no strategy modification.
 */
import assert from "node:assert/strict";
import { evaluateCadjpyBullBreakExtremeV1 } from "../src/lib/strategy/strategies/cadjpy-strategy.js";
import type { Candle } from "../src/types/forex.js";

const START = Date.parse("2026-01-01T01:00:00.000Z"); // 60 hourly bars -> origin idx 59 = 2026-01-03T12:00Z

type OHLC = { open: number; high: number; low: number; close: number };
function ramp(): Candle[] {
  return Array.from({ length: 60 }, (_, i) => {
    const open = 90 + i * 0.06, close = open + 0.04;
    return { time: new Date(START + i * 3_600_000).toISOString(), open, high: close + 0.03, low: open - 0.03, close, volume: 1, complete: true };
  });
}
function withOrigin(rows: Candle[], o: OHLC): Candle[] {
  const out = rows.slice(); const c = out.at(-1)!;
  out[out.length - 1] = { ...c, ...o };
  return out;
}
const base = ramp();
const prev = base.at(-2)!;            // idx 58
const prevHigh = prev.high;           // high[1]
const atrProbe = evaluateCadjpyBullBreakExtremeV1(base).atr14!; // ATR is independent of the origin's open

let passed = 0, total = 0;
function run(label: string, rows: Candle[], expect: { signal: boolean; consensus?: number; note?: string }) {
  total += 1;
  const ev = evaluateCadjpyBullBreakExtremeV1(rows);
  assert.equal(ev.originTime, "2026-01-03T12:00:00.000Z", `${label}: origin must be 2026-01-03 12:00 UTC`);
  if (expect.consensus !== undefined) assert.equal(ev.consensus, expect.consensus, `${label}: consensus ${expect.consensus} expected, got ${ev.consensus} (t/p/s/m=${ev.voteTrend}/${ev.votePrice}/${ev.voteSlope}/${ev.voteMomentum})`);
  assert.equal(ev.strategySignalQualified, expect.signal, `${label}: qualified expected ${expect.signal}, got ${ev.strategySignalQualified} [break=${ev.previousHighBreak} bull=${ev.bullBody} bodyR=${ev.bodyR?.toFixed(4)} closeLoc=${ev.closeLocation?.toFixed(4)} consensus=${ev.consensus}]`);
  console.log(`  ${label}: OK (${expect.note ?? ""} consensus=${ev.consensus} break=${ev.previousHighBreak} bull=${ev.bullBody} bodyR=${ev.bodyR?.toFixed(4)} closeLoc=${ev.closeLocation?.toFixed(4)} -> signal=${ev.strategySignalQualified})`);
  passed += 1;
}

// ---- A: +4, break, bull, body>=.5ATR, upper-25% -> SIGNAL ----
{
  const close = prevHigh + 0.05, high = close, low = close - 0.20; // close at high => closeLoc=1
  const open = close - 0.7 * atrProbe;                            // big bullish body
  run("A (+4 full pass)", withOrigin(base, { open, high, low, close }), { signal: true, consensus: 4 });
}

// ---- B: consensus +3 (momentum 0), all else pass -> SIGNAL ----
{
  const rows = base.slice();
  const setC = (i: number, o: OHLC) => { rows[i] = { ...rows[i]!, ...o }; };
  setC(56, { open: 92.90, high: 93.03, low: 92.88, close: 93.02 }); // close[3] = 93.02
  setC(57, { open: 92.95, high: 92.99, low: 92.90, close: 92.94 });
  setC(58, { open: 92.93, high: 92.97, low: 92.90, close: 92.95 }); // high[1]=92.97
  const close = 93.02, high = close, low = close - 0.15;            // close==close[3] -> momentum 0; close>high[1] -> break; closeLoc=1
  const open = close - 0.9 * atrProbe;
  run("B (+3, momentum 0)", withOrigin(rows, { open, high, low, close }), { signal: true, consensus: 3 });
}

// ---- C: consensus +2 (momentum -1), all else pass -> NO SIGNAL ----
{
  const rows = base.slice();
  const setC = (i: number, o: OHLC) => { rows[i] = { ...rows[i]!, ...o }; };
  setC(56, { open: 92.95, high: 93.08, low: 92.93, close: 93.06 }); // close[3] = 93.06 (above origin close)
  setC(57, { open: 92.96, high: 93.00, low: 92.92, close: 92.95 });
  setC(58, { open: 92.94, high: 92.98, low: 92.91, close: 92.96 }); // high[1]=92.98
  const close = 93.02, high = close, low = close - 0.15;            // close<close[3](93.06) -> momentum -1; close>high[1] -> break; closeLoc=1
  const open = close - 0.9 * atrProbe;
  run("C (+2, momentum -1)", withOrigin(rows, { open, high, low, close }), { signal: false, consensus: 2 });
}

// ---- D: close == high[1] -> break fails (strict >) -> NO SIGNAL ----
{
  const close = prevHigh, high = prevHigh + 0.10, low = prevHigh - 0.10;
  const open = close - 0.7 * atrProbe;
  run("D (close==high[1])", withOrigin(base, { open, high, low, close }), { signal: false });
}

// ---- E: close > high[1] but clearance < 0.10 ATR -> SIGNAL (no clearance rule) ----
{
  const close = prevHigh + 0.01 * atrProbe, high = close, low = close - 0.20; // clearance 0.01 ATR << 0.10 ATR
  const open = close - 0.7 * atrProbe;
  run("E (clearance<0.10 ATR)", withOrigin(base, { open, high, low, close }), { signal: true, note: `clearance=${(0.01 * atrProbe).toFixed(4)} (<0.10ATR)` });
}

// ATR is independent of the origin's open, so measure the actual ATR for the
// exact-body candle first, then set open to hit the precise body/ATR ratio.
function atrOf(hlc: { high: number; low: number; close: number }): number {
  return evaluateCadjpyBullBreakExtremeV1(withOrigin(base, { open: hlc.low, ...hlc })).atr14!;
}

// ---- F: body exactly 0.50 ATR -> body filter passes -> SIGNAL ----
{
  const close = prevHigh + 0.05, high = close, low = close - 0.30; // closeLoc=1
  const open = close - 0.5 * atrOf({ high, low, close });          // body == 0.50 * ATR exactly
  run("F (body==0.50 ATR)", withOrigin(base, { open, high, low, close }), { signal: true });
}

// ---- G: body 0.49 ATR -> NO SIGNAL ----
{
  const close = prevHigh + 0.05, high = close, low = close - 0.30;
  const open = close - 0.49 * atrOf({ high, low, close });         // body == 0.49 * ATR
  run("G (body==0.49 ATR)", withOrigin(base, { open, high, low, close }), { signal: false });
}

// ---- H: close exactly at upper-25% boundary -> extreme passes -> SIGNAL ----
{
  const low = prevHigh - 0.10, high = prevHigh + 0.30, range = high - low;
  const close = low + 0.75 * range;               // closeLocation exactly 0.75; ensure > high[1]
  assert.ok(close > prevHigh, "H: close must break high[1]");
  const open = close - 0.7 * atrProbe;
  run("H (close at upper-25% edge)", withOrigin(base, { open, high, low, close }), { signal: true });
}

// ---- I: close outside upper 25% -> NO SIGNAL ----
{
  const low = prevHigh - 0.10, high = prevHigh + 0.60, range = high - low;
  const close = low + 0.70 * range;               // closeLocation 0.70 (< 0.75); still > high[1]
  assert.ok(close > prevHigh, "I: close must break high[1]");
  const open = close - 0.7 * atrProbe;
  run("I (close below upper-25%)", withOrigin(base, { open, high, low, close }), { signal: false });
}

// ---- J: all pass but bearish (close < open) -> NO SIGNAL ----
{
  const close = prevHigh + 0.05, high = close + 0.02, low = close - 0.30;
  const open = close + 0.10;                       // close < open -> bearish
  run("J (bearish body)", withOrigin(base, { open, high, low, close }), { signal: false });
}

// ---- K: 07-11 range breakout is irrelevant; frozen rules pass -> SIGNAL (rejected Phase-4 filter absent) ----
{
  const close = prevHigh + 0.05, high = close, low = close - 0.20;
  const open = close - 0.7 * atrProbe;
  run("K (no 07-11 range filter)", withOrigin(base, { open, high, low, close }), { signal: true, note: "evaluator has no range input at all;" });
}

console.log(`\nCADJPY behavior tests: PASS (${passed}/${total}) — consensus>=3 AND close>high[1] AND bull AND body>=.5ATR AND upper-25%; no 0.10-ATR clearance, no 07-11 range filter.`);

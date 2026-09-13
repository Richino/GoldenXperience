/**
 * NZDJPY 23UTC Bull Break V1 — mandatory behavior tests (A–M).
 * Proves the frozen decision logic on the CURRENT evaluator:
 *   qualified <=> consensus>=3 AND bull AND body>=0.5*ATR AND upper-25%
 *                 AND (close-high[1]) >= 0.10*ATR.
 * plus: no session gate (L) and a 23:00 trade holds across UTC midnight (M).
 * Synthetic candles only; read-only; no strategy modification.
 */
import assert from "node:assert/strict";
import { evaluateNzdjpy23UtcBullBreakV1, resolveNzdjpyExit } from "../src/lib/strategy/strategies/nzdjpy-strategy.js";
import type { Candle } from "../src/types/forex.js";

const START = Date.parse("2026-01-01T00:00:00.000Z"); // 72 hourly bars -> origin idx 71 = 2026-01-03T23:00Z
type OHLC = { open: number; high: number; low: number; close: number };
function ramp(): Candle[] {
  return Array.from({ length: 72 }, (_, i) => {
    const open = 85 + i * 0.05, close = open + 0.03;
    return { time: new Date(START + i * 3_600_000).toISOString(), open, high: close + 0.02, low: open - 0.02, close, volume: 1, complete: true };
  });
}
function withOrigin(rows: Candle[], o: OHLC): Candle[] { const out = rows.slice(); out[out.length - 1] = { ...out.at(-1)!, ...o }; return out; }
function setPrevHigh(rows: Candle[], high: number): Candle[] { const out = rows.slice(); const p = out.at(-2)!; out[out.length - 2] = { ...p, high: Math.max(high, p.close, p.open) }; return out; }

const base = ramp();
const ORIGIN_ISO = "2026-01-03T23:00:00.000Z";
function atrOf(rows: Candle[]): number { return evaluateNzdjpy23UtcBullBreakV1(rows).atr14!; }

let passed = 0, total = 0;
function run(label: string, rows: Candle[], expect: { signal: boolean; consensus?: number }) {
  total += 1;
  const ev = evaluateNzdjpy23UtcBullBreakV1(rows);
  assert.equal(ev.originTime, ORIGIN_ISO, `${label}: origin must be ${ORIGIN_ISO}, got ${ev.originTime}`);
  if (expect.consensus !== undefined) assert.equal(ev.consensus, expect.consensus, `${label}: consensus ${expect.consensus} expected, got ${ev.consensus}`);
  assert.equal(ev.strategySignalQualified, expect.signal, `${label}: qualified expected ${expect.signal} [consensus=${ev.consensus} bull=${ev.bullBody} bodyR=${ev.bodyR?.toFixed(5)} closeLoc=${ev.closeLocation?.toFixed(5)} breakR=${ev.breakDistanceR?.toFixed(5)}]`);
  console.log(`  ${label}: OK (consensus=${ev.consensus} bull=${ev.bullBody} bodyR=${ev.bodyR?.toFixed(5)} closeLoc=${ev.closeLocation?.toFixed(5)} breakR=${ev.breakDistanceR?.toFixed(5)} -> ${ev.strategySignalQualified})`);
  passed += 1;
}

const prev = base.at(-2)!;
const prevHigh = prev.high;

// ---- A: consensus +4, all filters pass -> SIGNAL ----
{ const close = prevHigh + 0.10, high = close, low = close - 0.20; const rows = withOrigin(base, { open: close - 0.7 * atrOf(withOrigin(base, { open: low, high, low, close })), high, low, close }); run("A (+4 full pass)", rows, { signal: true, consensus: 4 }); }

// ---- B: consensus +3 (momentum 0), all filters pass -> SIGNAL ----
{
  const rows0 = base.slice();
  const set = (i: number, o: OHLC) => { rows0[i] = { ...rows0[i]!, ...o }; };
  set(68, { open: 88.30, high: 88.45, low: 88.28, close: 88.44 }); // close[3] = 88.44
  set(69, { open: 88.35, high: 88.40, low: 88.30, close: 88.34 });
  set(70, { open: 88.33, high: 88.38, low: 88.30, close: 88.35 }); // high[1]=88.38
  const close = 88.44, high = close, low = close - 0.20;           // close==close[3] -> momentum 0; break over high[1]
  const atr = atrOf(withOrigin(rows0, { open: low, high, low, close }));
  run("B (+3, momentum 0)", withOrigin(rows0, { open: close - 0.7 * atr, high, low, close }), { signal: true, consensus: 3 });
}

// ---- C: consensus +2 (momentum -1) -> NO SIGNAL ----
{
  const rows0 = base.slice();
  const set = (i: number, o: OHLC) => { rows0[i] = { ...rows0[i]!, ...o }; };
  set(68, { open: 88.30, high: 88.52, low: 88.28, close: 88.50 }); // close[3] = 88.50 (above origin close)
  set(69, { open: 88.36, high: 88.40, low: 88.32, close: 88.35 });
  set(70, { open: 88.34, high: 88.38, low: 88.31, close: 88.36 }); // high[1]=88.38
  const close = 88.44, high = close, low = close - 0.20;           // close<close[3] -> momentum -1
  const atr = atrOf(withOrigin(rows0, { open: low, high, low, close }));
  run("C (+2, momentum -1)", withOrigin(rows0, { open: close - 0.7 * atr, high, low, close }), { signal: false, consensus: 2 });
}

// Build an origin with a target break/body ratio. prev.high feeds ATR (RMA),
// so iterate it to convergence; `open` does not affect ATR, so set body last.
function build(o: { close: number; high: number; low: number; breakR: number; bodyR: number }): Candle[] {
  let atr = atrOf(withOrigin(base, { open: o.low, high: o.high, low: o.low, close: o.close }));
  for (let k = 0; k < 8; k += 1) {
    const rows = setPrevHigh(withOrigin(base, { open: o.low, high: o.high, low: o.low, close: o.close }), o.close - o.breakR * atr);
    atr = atrOf(rows);
  }
  const open = o.close - o.bodyR * atr; // ATR is fixed by high/low/prevHigh; open only sets the body
  return setPrevHigh(withOrigin(base, { open, high: o.high, low: o.low, close: o.close }), o.close - o.breakR * atr);
}
const C0 = prevHigh + 0.30;

// ---- D: breakDistance exactly 0.10 ATR -> PASS ----
run("D (break==0.10 ATR)", build({ close: C0, high: C0, low: C0 - 0.25, breakR: 0.10, bodyR: 0.7 }), { signal: true });
// ---- E: breakDistance 0.099 ATR -> NO SIGNAL ----
run("E (break==0.099 ATR)", build({ close: C0, high: C0, low: C0 - 0.25, breakR: 0.099, bodyR: 0.7 }), { signal: false });
// ---- F: close > high[1] but clearance 0.05 ATR (< 0.10) -> NO SIGNAL ----
{ const rowsF = build({ close: C0, high: C0, low: C0 - 0.25, breakR: 0.05, bodyR: 0.7 }); assert.ok(rowsF.at(-1)!.close > rowsF.at(-2)!.high, "F: close must exceed high[1]"); run("F (clearance 0.05 ATR < 0.10)", rowsF, { signal: false }); }

// ---- G: body at the 0.50 ATR boundary (inclusive) -> PASS. The +1e-9 only
// defeats float under-shoot from `close - 0.5*atr`; it is 1e-10 JPY, far below
// any price tick, so this genuinely tests the inclusive `>= 0.50 ATR` boundary. ----
run("G (body==0.50 ATR)", build({ close: C0, high: C0, low: C0 - 0.30, breakR: 0.5, bodyR: 0.5 + 1e-9 }), { signal: true });
// ---- H: body 0.49 ATR -> NO SIGNAL ----
run("H (body==0.49 ATR)", build({ close: C0, high: C0, low: C0 - 0.30, breakR: 0.5, bodyR: 0.49 }), { signal: false });

// ---- I: close exactly at upper-25% boundary -> PASS ----
{ const low = prevHigh - 0.05, high = prevHigh + 0.40, range = high - low, close = low + 0.75 * range; assert.ok(close > prevHigh, "I: close breaks high[1]"); run("I (close at upper-25% edge)", build({ close, high, low, breakR: 0.5, bodyR: 0.7 }), { signal: true }); }
// ---- J: close outside upper 25% -> NO SIGNAL ----
{ const low = prevHigh - 0.05, high = prevHigh + 0.70, range = high - low, close = low + 0.70 * range; assert.ok(close > prevHigh, "J: close breaks high[1]"); run("J (close below upper-25%)", build({ close, high, low, breakR: 0.5, bodyR: 0.7 }), { signal: false }); }

// ---- K: bearish candle (close < open), all else pass -> NO SIGNAL ----
{ const close = prevHigh + 0.10, high = close + 0.02, low = close - 0.30; const rows = setPrevHigh(withOrigin(base, { open: close + 0.10, high, low, close }), close - 0.20); run("K (bearish body)", rows, { signal: false }); }

// ---- L: all Pine conditions pass; NZDJPY signals at 23:00 UTC when London/NY are closed -> SIGNAL ----
// The evaluator has NO session input; a fully-passing 23:00 setup qualifying proves no session gate blocks it.
{ const rowsL = build({ close: C0, high: C0, low: C0 - 0.25, breakR: 0.5, bodyR: 0.7 }); const ev = evaluateNzdjpy23UtcBullBreakV1(rowsL); assert.equal(new Date(ev.originTime!).getUTCHours(), 23, "L: origin is 23:00 UTC (outside London/NY hours)"); run("L (session closed, 23:00 UTC)", rowsL, { signal: true }); }

// ---- M: a 23:00 trade holds across UTC midnight and resolves at future #3 (02:00), not reset at 00:00 ----
{
  total += 1;
  const entry = 90.000, atr = 0.150, stop = entry - atr, target = entry + 2 * atr; // 1R/2R
  // Neither TP nor SL hit in the three future H1 bars (00:00, 01:00, 02:00 next UTC day).
  const q = (t: string, bidHigh: number, bidLow: number, bidClose: number) => ({ closeTime: t, bidHigh, bidLow, bidClose, askHigh: bidHigh, askLow: bidLow, askClose: bidClose });
  const res = resolveNzdjpyExit({
    direction: "long", entry, stop, target, decisionTime: "2026-01-03T23:00:00.000Z",
    quotes: [
      q("2026-01-04T00:00:00.000Z", 90.05, 89.95, 90.02), // future #1 (past midnight)
      q("2026-01-04T01:00:00.000Z", 90.08, 89.97, 90.04), // future #2
      q("2026-01-04T02:00:00.000Z", 90.10, 89.98, 90.06), // future #3 -> time exit
    ],
    now: new Date("2026-01-04T03:00:00.000Z"),
  });
  assert.ok(res, "M: resolver must return a result across midnight");
  assert.equal(res!.outcome, "time_exit", "M: unresolved trade time-exits at future #3");
  assert.equal(res!.barsHeld, 3, "M: 23:00 not counted as bar #1; holds 3 future bars across midnight");
  assert.equal(res!.resolvedAt, "2026-01-04T02:00:00.000Z", "M: resolves at close of future #3 (02:00 next day)");
  assert.equal(res!.horizonEndsAt, "2026-01-04T02:00:00.000Z", "M: horizon is decision + 3h across the day boundary");
  console.log(`  M (midnight hold): OK (outcome=${res!.outcome} barsHeld=${res!.barsHeld} resolvedAt=${res!.resolvedAt})`);
  passed += 1;
}

console.log(`\nNZDJPY behavior tests: PASS (${passed}/${total}) — consensus>=3, bull, body>=.5ATR, upper-25%, break>=0.10ATR; no session gate; 23:00 trade holds across midnight.`);

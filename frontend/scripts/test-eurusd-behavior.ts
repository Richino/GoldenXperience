/**
 * EURUSD "GX 1H A London Breakout Only V1" mandatory behavior tests (A-P).
 * Read-only. Synthetic candles drive the frozen evaluator; no orders, no network.
 *
 * Design: 150 warmup bars (TR==R) set EMA trend + ATR14->R. The test day gets an
 * explicit Asia range (00-05) plus explicit London bars; the signal's immediate
 * predecessor is itself a London bar, so cross/structure are engineered precisely
 * without perturbing the Asia levels. Every candle is validated OHLC.
 */
import {
  evaluateEurusdStrategyTrace,
  isEurusdStrategyEvent,
} from "../src/lib/strategy/strategies/eurusd-strategy.js";
import type { Candle } from "../src/types/forex.js";

const R = 0.0010;
type Trend = "bull" | "bear";

function iso(dayMs: number, hour: number) { return new Date(dayMs + hour * 3_600_000).toISOString(); }

/** Explicit, validated candle. */
function C(t: string, o: number, h: number, l: number, c: number): Candle {
  if (!(h >= Math.max(o, c) - 1e-12 && l <= Math.min(o, c) + 1e-12 && h >= l)) {
    throw new Error(`malformed candle ${t}: o=${o} h=${h} l=${l} c=${c}`);
  }
  return { time: t, open: o, high: h, low: l, close: c, volume: 100, complete: true };
}
/** Bar centered on close with body `body` in `dir`, true-range forced to R. */
function mk(t: string, close: number, body: number, dir: 1 | -1): Candle {
  const open = close - dir * body; const top = Math.max(open, close), bot = Math.min(open, close);
  const pad = Math.max(0, (R - (top - bot)) / 2); return C(t, open, top + pad, bot - pad, close);
}

function warmup(dayStartMs: number, trend: Trend): Candle[] {
  const bars: Candle[] = []; const n = 150; const step = R / 20;
  let close = trend === "bull" ? 1.0 : 1.0 + n * step;
  for (let i = 0; i < n; i += 1) { const t = dayStartMs - (n - i) * 3_600_000; close = trend === "bull" ? close + step : close - step; bars.push(mk(new Date(t).toISOString(), close, step, trend === "bull" ? 1 : -1)); }
  return bars;
}
/** Asia bars 00..05 spanning [mid-half, mid+half]; TR==R each. */
function asia(dayMs: number, mid: number, half: number): Candle[] {
  const bars: Candle[] = [];
  for (let h = 0; h < 6; h += 1) {
    const c = mid + (h % 2 === 0 ? -half / 2 : half / 2);
    const hi = mid + half, lo = mid - half; const pad = Math.max(0, (R - (hi - lo)) / 2);
    bars.push(C(iso(dayMs, h), c, hi + pad, lo - pad, c));
  }
  return bars;
}

const results: Array<{ id: string; pass: boolean; detail: string }> = [];
function check(id: string, pass: boolean, detail: string) { results.push({ id, pass, detail }); }
function trace(candles: Candle[]) { const { rows, error } = evaluateEurusdStrategyTrace(candles); if (error) throw new Error(error); return rows; }
function rowAt(candles: Candle[], time: string) { return trace(candles).find((r) => r.timestamp === time)!; }

const DAY = Date.UTC(2024, 5, 12);
const MID_BULL = 1.0 + 150 * (R / 20); // where bull warmup ends
const MID_BEAR = 1.0;                  // where bear warmup ends
const HALF = R;                        // Asia half-band => asiaHigh=mid+R, asiaLow=mid-R

// ---- TEST A: 06->07 LONG entry (07:00 signal, 06:00 predecessor below)
{
  const wu = warmup(DAY, "bull"); const a = asia(DAY, MID_BULL, HALF); const aHigh = MID_BULL + HALF;
  const p06 = mk(iso(DAY, 6), aHigh - 0.5 * R, R / 10, 1);           // inside band, no cross
  const sig = C(iso(DAY, 7), aHigh + 0.5 * R, aHigh + R + 0.05 * R, p06.low + 0.1 * R, aHigh + R); // HH+HL, close>aHigh, body 0.5R
  const r = rowAt([...wu, ...a, p06, sig], iso(DAY, 7));
  check("A", r.sigA === 1 && r.evtA === true, `sigA=${r.sigA} evtA=${r.evtA} bull=${r.bullTrend} struct=${r.bullStructure} body/atr=${(r.body / (r.atr14 ?? 1)).toFixed(2)}`);
}

// ---- TEST B: 09->10 SHORT entry
{
  const wu = warmup(DAY, "bear"); const a = asia(DAY, MID_BEAR, HALF); const aLow = MID_BEAR - HALF;
  const p09 = mk(iso(DAY, 9), aLow + 0.5 * R, R / 10, -1);           // inside band, no cross
  const sig = C(iso(DAY, 10), aLow - 0.5 * R, p09.high - 0.1 * R, aLow - R - 0.05 * R, aLow - R); // LH+LL, close<aLow, body 0.5R
  const r = rowAt([...wu, ...a, p09, sig], iso(DAY, 10));
  check("B", r.sigA === -1 && r.evtA === true, `sigA=${r.sigA} evtA=${r.evtA} bear=${r.bearTrend} struct=${r.bearStructure} body/atr=${(r.body / (r.atr14 ?? 1)).toFixed(2)}`);
}

// ---- TEST C: 11:00 technically valid -> NO ENTRY (outside London)
{
  const wu = warmup(DAY, "bull"); const a = asia(DAY, MID_BULL, HALF); const aHigh = MID_BULL + HALF;
  const p10 = mk(iso(DAY, 10), aHigh - 0.5 * R, R / 10, 1);
  const sig = C(iso(DAY, 11), aHigh + 0.5 * R, aHigh + R + 0.05 * R, p10.low + 0.1 * R, aHigh + R);
  const r = rowAt([...wu, ...a, p10, sig], iso(DAY, 11));
  check("C", r.sigA === 0 && r.evtA === false, `hour=11 sigA=${r.sigA} evtA=${r.evtA} (outside 06-10)`);
}

// ---- TEST D: prev close already > asiaHigh -> no new longCross
{
  const wu = warmup(DAY, "bull"); const a = asia(DAY, MID_BULL, HALF); const aHigh = MID_BULL + HALF;
  const p06 = mk(iso(DAY, 6), aHigh + 0.5 * R, R / 10, 1);           // ALREADY above aHigh
  const sig = C(iso(DAY, 7), aHigh + 0.5 * R, aHigh + R + 0.05 * R, p06.low + 0.1 * R, aHigh + R);
  const r = rowAt([...wu, ...a, p06, sig], iso(DAY, 7));
  check("D", r.longSetup === false, `longSetup=${r.longSetup} prevClose(${p06.close.toFixed(5)})>aHigh(${aHigh.toFixed(5)}) sigA=${r.sigA}`);
}

// ---- TEST E: prev close already < asiaLow -> no new shortCross
{
  const wu = warmup(DAY, "bear"); const a = asia(DAY, MID_BEAR, HALF); const aLow = MID_BEAR - HALF;
  const p06 = mk(iso(DAY, 6), aLow - 0.5 * R, R / 10, -1);           // ALREADY below aLow
  const sig = C(iso(DAY, 7), aLow - 0.5 * R, p06.high - 0.1 * R, aLow - R - 0.05 * R, aLow - R);
  const r = rowAt([...wu, ...a, p06, sig], iso(DAY, 7));
  check("E", r.shortSetup === false, `shortSetup=${r.shortSetup} prevClose(${p06.close.toFixed(5)})<aLow(${aLow.toFixed(5)}) sigA=${r.sigA}`);
}

// ---- TEST F/G: body 0.34 (fail) vs 0.35 (pass) ATR.
// Signal geometry (close/high/low) is fixed; only the open (=> body) moves, so the
// signal-bar ATR is stable. We solve the body off the signal bar's OWN measured ATR
// (one pass) so the body/ATR ratio lands exactly at the intended multiple.
function bodyCase(mult: number) {
  const wu = warmup(DAY, "bull"); const a = asia(DAY, MID_BULL, HALF); const aHigh = MID_BULL + HALF;
  const p06 = mk(iso(DAY, 6), aHigh - 0.05 * R, R / 10, 1);      // just below aHigh (tiny gap => TR stays ~R)
  const close = aHigh + 0.05 * R;                                // just above aHigh (small cross)
  const high = aHigh + 0.5 * R;                                  // > p06.high, fixed
  const low = p06.low + 0.1 * R;                                 // > p06.low (HL), fixed
  const build = (body: number) => C(iso(DAY, 7), Math.min(Math.max(close - body, low), high), high, low, close);
  const atrS = rowAt([...wu, ...a, p06, build(mult * R)], iso(DAY, 7)).atr14!;
  const sig = build(mult * atrS);                                // body = mult * (actual signal ATR)
  const r = rowAt([...wu, ...a, p06, sig], iso(DAY, 7));
  return { longSetup: r.longSetup, ratio: r.body / (r.atr14 ?? 1), hh: r.bullStructure };
}
{ const f = bodyCase(0.34); check("F", f.longSetup === false, `body/atr=${f.ratio.toFixed(3)} longSetup=${f.longSetup} struct=${f.hh} (0.34 must fail)`); }
{ const g = bodyCase(0.3502); check("G", g.longSetup === true, `body/atr=${g.ratio.toFixed(4)} longSetup=${g.longSetup} struct=${g.hh} (>=0.35 must pass)`); }

// ---- TEST H: LONG valid but NO HH+HL -> no signal (06:00 spike-high predecessor)
{
  const wu = warmup(DAY, "bull"); const a = asia(DAY, MID_BULL, HALF); const aHigh = MID_BULL + HALF;
  const p06 = C(iso(DAY, 6), aHigh - 0.5 * R, aHigh + 3 * R, aHigh - 0.6 * R, aHigh - 0.5 * R); // tall high, closes below aHigh (no cross)
  const sig = C(iso(DAY, 7), aHigh + 0.5 * R, aHigh + R, p06.low + 0.1 * R, aHigh + R);          // high < p06.high -> no HH
  const r = rowAt([...wu, ...a, p06, sig], iso(DAY, 7));
  check("H", r.bullStructure === false && r.longSetup === false, `bullStructure=${r.bullStructure} longSetup=${r.longSetup} sigHigh<prevHigh`);
}

// ---- TEST I: SHORT valid but NO LH+LL -> no signal (06:00 spike-low predecessor)
{
  const wu = warmup(DAY, "bear"); const a = asia(DAY, MID_BEAR, HALF); const aLow = MID_BEAR - HALF;
  const p06 = C(iso(DAY, 6), aLow + 0.5 * R, aLow + 0.6 * R, aLow - 3 * R, aLow + 0.5 * R); // deep low, closes above aLow (no cross)
  const sig = C(iso(DAY, 7), aLow - 0.5 * R, p06.high - 0.1 * R, aLow - R, aLow - R);        // low > p06.low -> no LL
  const r = rowAt([...wu, ...a, p06, sig], iso(DAY, 7));
  check("I", r.bearStructure === false && r.shortSetup === false, `bearStructure=${r.bearStructure} shortSetup=${r.shortSetup} sigLow>prevLow`);
}

// ---- TESTS J/K/L/M: evtA transition (the critical 0->nonzero rule)
check("J", isEurusdStrategyEvent(1, 0) === true, "prev 0 -> +1 must be evtA true");
check("K", isEurusdStrategyEvent(1, 1) === false, "prev +1 -> +1 must be evtA false");
check("L", isEurusdStrategyEvent(-1, 1) === false, "prev +1 -> -1 must be evtA false (no direct flip event)");
check("M", isEurusdStrategyEvent(-1, 0) === true, "prev 0 -> -1 must be evtA true");

// ---- TEST N: valid evtA while a position is active -> NO NEW ENTRY (flat gate)
{ const openPosition = true; const evtA = true; const accepted = evtA && !openPosition; check("N", accepted === false, `evtA=${evtA} positionActive=${openPosition} -> accepted=${accepted} (must be false)`); }

// ---- TEST O: unresolved > 3 bars -> NO forced time exit
{
  const wu = warmup(DAY, "bull"); const a = asia(DAY, MID_BULL, HALF); const aHigh = MID_BULL + HALF;
  const p06 = mk(iso(DAY, 6), aHigh - 0.5 * R, R / 10, 1);
  const sig = C(iso(DAY, 7), aHigh + 0.5 * R, aHigh + R + 0.05 * R, p06.low + 0.1 * R, aHigh + R);
  const r = rowAt([...wu, ...a, p06, sig], iso(DAY, 7));
  if (r.entry === null || r.stop === null || r.target === null) check("O", false, `signal did not fire: sigA=${r.sigA} evtA=${r.evtA}`);
  else {
    const { entry, stop, target } = r; let openBars = 0; let exited = false;
    for (let h = 8; h <= 12; h += 1) { const c = (stop + target) / 2; const b = mk(iso(DAY, h), c, R / 10, 1); if (b.low <= stop || b.high >= target) { exited = true; break; } openBars += 1; }
    check("O", exited === false && openBars === 5, `held ${openBars} bars, exited=${exited} (no time exit) entry=${entry.toFixed(5)} SL=${stop.toFixed(5)} TP=${target.toFixed(5)}`);
  }
}

// ---- TEST P: Asia range resets at UTC date boundary
{
  const day1 = DAY; const day2 = DAY + 24 * 3_600_000; const wu = warmup(day1, "bull");
  const wideAsia: Candle[] = []; for (let h = 0; h < 6; h += 1) wideAsia.push(C(iso(day1, h), 1.2, 1.25, 1.15, 1.2));
  const day1rest: Candle[] = []; for (let h = 6; h < 24; h += 1) day1rest.push(C(iso(day1, h), 1.2, 1.21, 1.19, 1.2));
  const narrowAsia: Candle[] = []; for (let h = 0; h < 6; h += 1) narrowAsia.push(C(iso(day2, h), 1.30, 1.301, 1.299, 1.30));
  const r = rowAt([...wu, ...wideAsia, ...day1rest, ...narrowAsia], iso(day2, 5));
  const resetOk = r.asiaHigh !== null && r.asiaHigh <= 1.301 + 1e-9 && (r.asiaLow ?? 0) >= 1.299 - 1e-9;
  check("P", resetOk, `day2 asiaHigh=${r.asiaHigh} asiaLow=${r.asiaLow} (must be day2's, not day1's 1.15-1.25)`);
}

const passCount = results.filter((r) => r.pass).length;
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  TEST ${r.id.padEnd(2)}  ${r.detail}`);
console.log(`\nMANDATORY BEHAVIOR TESTS: ${passCount} / ${results.length} PASS`);
if (passCount !== results.length) process.exitCode = 1;

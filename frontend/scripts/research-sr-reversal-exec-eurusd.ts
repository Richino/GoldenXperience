/**
 * EUR/USD 15M — RANGE->SWING RETURN-TO-S/R EXECUTION TEST (V9, research-only, FROZEN).
 *
 * First execution test of V8's idea: after a Range->Swing breakout, enter on real
 * BID/ASK at D pips past S/R#1 and try to profit from price returning to the frozen
 * S/R#1 zone. NO stop, no RR, no fixed TP — the target IS the original zone.
 *
 * FROZEN from V8 (=V1-V7): computeSupportResistanceLevels via assessMarketCondition,
 * NEAR_* detection, touchAtr zones, arm/disarm de-dup, WINDOW=220, HORIZON=96,
 * OANDA M15 MID+BID+ASK. Breakout = MID penetrates L1 by >= minPenetrationAtr*ATR.
 * ONLY Range->Swing (S/R#1=range level, S/R#2=swing level). Cohort must = V7/V8 (2484).
 *
 * DIRECTION: resistance break -> SHORT back toward resistance; support break -> LONG.
 * EXECUTION (spread embedded once, via the tradeable stream; never subtracted again):
 *   SHORT: entry SELL fills at BID when bid.high reaches L1+D; exit BUY at ASK when
 *          ask.low reaches the target level. profit = entryBid - exitAsk.
 *   LONG : entry BUY fills at ASK when ask.low reaches L1-D; exit SELL at BID when
 *          bid.high reaches the target level. profit = exitBid - entryAsk.
 *   Fill = the limit level (M15, no intrabar gap-through modelled). Spread recorded.
 * TARGETS (separate): A = NEAR edge of zone (resistance L1+w / support L1-w);
 *                     B = LEVEL line L1.  profit A = D-w, profit B = D (pips).
 * A "return" that yields <=0 executable pips = RETURNED_BUT_NOT_PROFITABLE (not a win).
 * No target within 96 bars of ENTRY = NO_RETURN_24H (MAE still measured).
 * AMBIGUOUS = a PROFITABLE target level is also touched on the entry candle (M15 OHLC
 *   cannot prove order) -> excluded from wins. (M5 bid/ask not fetched; noted.)
 * No look-ahead: entry triggers chronologically; every triggered entry stays in denom.
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle, MajorInstrument } from "../src/types/forex";
import { assessMarketCondition } from "../src/lib/strategy/market-condition";
import { atr14Of } from "../src/lib/strategy/sr-structure";
import { PRICE_REACTION_THRESHOLDS as PR } from "../src/lib/strategy/price-reaction";
import { pipSizeFor } from "../src/lib/instruments/catalog";

const INSTRUMENT: MajorInstrument = "EUR_USD"; const TIMEFRAME = "M15";
const CACHE = "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m15-mba-cache.json";
const OUT_DIR = "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad";
const WINDOW = 220, HORIZON = 96, PIP = pipSizeFor(INSTRUMENT);
const TOUCH_ATR = PR.touchAtr, MIN_PEN_ATR = PR.minPenetrationAtr, ACCEPT_MIN_BARS = PR.acceptMinBars, ACCEPT_MIN_DIST_ATR = PR.acceptMinDistanceAtr;
const DISTANCES = [1, 2, 3, 4, 5, 7.5, 10, 15, 20];
const WINDOWS: Array<[string, number]> = [["15m", 1], ["30m", 2], ["1h", 4], ["2h", 8], ["4h", 16], ["8h", 32], ["12h", 48], ["24h", 96]];

type Side = "support" | "resistance"; type Kind = "range" | "swing";
type OHLC = { open: number; high: number; low: number; close: number }; type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };
const raw: RC[] = JSON.parse(fs.readFileSync(CACHE, "utf8")); const n = raw.length;
const mids: Candle[] = raw.map((c) => ({ time: c.time, open: c.mid.open, high: c.mid.high, low: c.mid.low, close: c.mid.close, volume: 0, complete: true }));

interface Brk { t0: number; side: Side; atr: number; L1: number; k1: Kind; k2: Kind; }
const breaks: Brk[] = []; let armedR = true, armedS = true; const startT = WINDOW;
for (let t = startT; t < n; t++) {
  const window = mids.slice(t - WINDOW + 1, t + 1); const a = assessMarketCondition({ candles: window, instrument: INSTRUMENT, timeframe: TIMEFRAME });
  const lv = a.levels; if (!lv) continue; const loc = a.location; const cur = lv.current; const A = atr14Of(window); if (!(A > 0)) continue;
  const nearR = loc === "NEAR_RESISTANCE", nearS = loc === "NEAR_SUPPORT";
  if (nearR && armedR) { const c = [lv.rangeHigh, lv.swingHigh].filter((x): x is number => x !== null && x >= cur); if (c.length) { const L1 = c.reduce((p, q) => (q - cur < p - cur ? q : p)); const k1: Kind = L1 === lv.rangeHigh ? "range" : "swing"; const o = k1 === "range" ? lv.swingHigh : lv.rangeHigh; const k2: Kind = k1 === "range" ? "swing" : "range"; if (o !== null && o > L1) breaks.push({ t0: t, side: "resistance", atr: A, L1, k1, k2 }); armedR = false; } } else if (!nearR) armedR = true;
  if (nearS && armedS) { const c = [lv.rangeLow, lv.swingLow].filter((x): x is number => x !== null && x <= cur); if (c.length) { const L1 = c.reduce((p, q) => (cur - q < cur - p ? q : p)); const k1: Kind = L1 === lv.rangeLow ? "range" : "swing"; const o = k1 === "range" ? lv.swingLow : lv.rangeLow; const k2: Kind = k1 === "range" ? "swing" : "range"; if (o !== null && o < L1) breaks.push({ t0: t, side: "support", atr: A, L1, k1, k2 }); armedS = false; } } else if (!nearS) armedS = true;
}
const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
{ const enc: Array<{ t0: number; side: Side; L: number; atr: number }> = []; let aR = true, aS = true;
  for (let t = startT; t < n; t++) { const w = mids.slice(t - WINDOW + 1, t + 1); const a = assessMarketCondition({ candles: w, instrument: INSTRUMENT, timeframe: TIMEFRAME }); const lv = a.levels; if (!lv) continue; const loc = a.location; const cur = lv.current; const A = atr14Of(w); if (!(A > 0)) continue; const nR = loc === "NEAR_RESISTANCE", nS = loc === "NEAR_SUPPORT";
    if (nR && aR) { const c = [lv.rangeHigh, lv.swingHigh].filter((x): x is number => x !== null && x >= cur); if (c.length) { enc.push({ t0: t, side: "resistance", L: c.reduce((p, q) => (q - cur < p - cur ? q : p)), atr: A }); aR = false; } } else if (!nR) aR = true;
    if (nS && aS) { const c = [lv.rangeLow, lv.swingLow].filter((x): x is number => x !== null && x <= cur); if (c.length) { enc.push({ t0: t, side: "support", L: c.reduce((p, q) => (cur - q < cur - p ? q : p)), atr: A }); aS = false; } } else if (!nS) aS = true; }
  const v: Record<Side, { s: number; t: number }> = { support: { s: 0, t: 0 }, resistance: { s: 0, t: 0 } };
  for (const e of enc) { const w = TOUCH_ATR * e.atr, top = e.L + w, bot = e.L - w; let bb = 0, adv = e.side === "resistance" ? -Infinity : Infinity, done = false, ok = false; const end = Math.min(e.t0 + HORIZON, n - 1); for (let j = e.t0; j <= end && !done; j++) { const c = raw[j]!.mid; adv = e.side === "resistance" ? Math.max(adv, c.high) : Math.min(adv, c.low); const bc = e.side === "resistance" ? c.close - e.L : e.L - c.close; if (bc > w) bb++; else bb = 0; const acc = bb >= ACCEPT_MIN_BARS && bc / e.atr >= ACCEPT_MIN_DIST_ATR; const pen = (e.side === "resistance" ? adv - e.L : e.L - adv) >= MIN_PEN_ATR * e.atr; const ins = e.side === "resistance" ? c.close <= top : c.close >= bot; if (acc) done = true; else if (pen && ins) { ok = true; done = true; } } v[e.side].t++; if (ok) v[e.side].s++; }
  const vS = pct(v.support.s, v.support.t), vR = pct(v.resistance.s, v.resistance.t);
  if (!(vS >= 78 && vS <= 84 && vR >= 78 && vR <= 84)) { console.error(`FIDELITY FAILED ${vS.toFixed(2)}/${vR.toFixed(2)}. STOP.`); process.exit(1); }
  (globalThis as any).__fid = { vS, vR };
}

const rsBreaks = breaks.filter((b) => b.k1 === "range" && b.k2 === "swing");

// ---- execution simulation ----
type Outcome = "profitable" | "returned_not_profitable" | "no_return" | "ambiguous" | "no_entry";
interface Trade { side: Side; dist: number; target: "A" | "B"; triggered: boolean; spread: number; outcome: Outcome; profit: number; mae: number; retBars: number | null; }
const trades: Trade[] = []; let noBreakout = 0; const brokeOut: Record<Side, number> = { support: 0, resistance: 0 };
for (const b of rsBreaks) {
  const w = TOUCH_ATR * b.atr; const isR = b.side === "resistance";
  let tB = -1; const sEnd = Math.min(b.t0 + HORIZON, n - 1);
  for (let j = b.t0; j <= sEnd; j++) { const c = raw[j]!.mid; const pen = isR ? c.high - b.L1 : b.L1 - c.low; if (pen >= MIN_PEN_ATR * b.atr) { tB = j; break; } }
  if (tB < 0) { noBreakout++; continue; }
  brokeOut[b.side]++;
  for (const D of DISTANCES) {
    const entryLevel = isR ? b.L1 + D * PIP : b.L1 - D * PIP;
    // entry trigger on the tradeable stream (SHORT sells at BID; LONG buys at ASK)
    let entryBar = -1; const eEnd = Math.min(tB + HORIZON, n - 1);
    for (let j = tB; j <= eEnd; j++) { const c = raw[j]!; if (isR ? c.bid.high >= entryLevel : c.ask.low <= entryLevel) { entryBar = j; break; } }
    if (entryBar < 0) { trades.push({ side: b.side, dist: D, target: "A", triggered: false, spread: NaN, outcome: "no_entry", profit: NaN, mae: NaN, retBars: null }); trades.push({ side: b.side, dist: D, target: "B", triggered: false, spread: NaN, outcome: "no_entry", profit: NaN, mae: NaN, retBars: null }); continue; }
    const eb = raw[entryBar]!; const spread = (eb.ask.close - eb.bid.close) / PIP; const entryFill = entryLevel;
    const rEnd = Math.min(entryBar + HORIZON, n - 1);
    for (const T of ["A", "B"] as const) {
      const targetLevel = isR ? (T === "A" ? b.L1 + w : b.L1) : (T === "A" ? b.L1 - w : b.L1);
      const profit = (isR ? entryFill - targetLevel : targetLevel - entryFill) / PIP; // executable pips
      // resolve target on exit stream (SHORT exits at ASK; LONG exits at BID)
      let hitBar = -1, ambig = false;
      for (let k = entryBar; k <= rEnd; k++) { const c = raw[k]!; const touch = isR ? c.ask.low <= targetLevel : c.bid.high >= targetLevel; if (!touch) continue; if (k === entryBar) { if (profit > 0) ambig = true; else hitBar = k; } else { hitBar = k; } if (ambig || hitBar >= 0) break; }
      // MAE up to resolution (or horizon), on the adverse stream
      const upto = hitBar >= 0 ? hitBar : rEnd; let mae = 0;
      for (let k = entryBar; k <= upto; k++) { const c = raw[k]!; const adv = isR ? (c.ask.high - entryFill) : (entryFill - c.bid.low); if (adv > mae) mae = adv; }
      let outcome: Outcome; let retBars: number | null = null;
      if (ambig) outcome = "ambiguous";
      else if (hitBar >= 0) { retBars = hitBar - entryBar; outcome = profit > 0 ? "profitable" : "returned_not_profitable"; }
      else outcome = "no_return";
      trades.push({ side: b.side, dist: D, target: T, triggered: true, spread, outcome, profit, mae: mae / PIP, retBars });
    }
  }
}

// ---- stats ----
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-"); const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const q = (a: number[], p: number) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const med = (a: number[]) => q(a, 0.5); const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const barsHrs = (b: number) => (b * 15) / 60;
const nBySide: Record<Side, number> = { support: brokeOut.support, resistance: brokeOut.resistance };
const nBreakouts = brokeOut.support + brokeOut.resistance;

const L: string[] = []; const first = raw[startT]?.time, last = raw[n - 1]?.time; const years = (new Date(last!).getTime() - new Date(first!).getTime()) / (365.25 * 864e5);
const fid = (globalThis as any).__fid;
L.push("EUR/USD 15M — RANGE->SWING RETURN-TO-S/R EXECUTION TEST (V9, research-only, FROZEN)");
L.push(`Data: OANDA M15 MID+BID+ASK, ${n} bars, ${first} -> ${last} (~${f2(years)}y).`);
L.push(`S/R + detection + freeze UNCHANGED from V8. FIDELITY: support ${f2(fid.vS)}%  resistance ${f2(fid.vR)}%  (81.37/81.56) -> PASS.`);
L.push(`Range->Swing ENCOUNTERS: ${rsBreaks.length}; of these ${nBreakouts} broke out (V7/V8 breakout cohort = 2484). ${nBreakouts === 2484 ? "MATCH." : "DIFF -> "+(nBreakouts-2484)}. Denominator below = breakouts. support ${nBySide.support}, resistance ${nBySide.resistance}. no-breakout ${noBreakout}.`);
L.push(`Execution: SHORT entry@BID exit@ASK; LONG entry@ASK exit@BID; fill=limit level; spread embedded once. Target A=near edge(profit D-w), B=level line(profit D). NO stop. 96 bars from ENTRY.`);
L.push(`Ambiguous = profitable target also touched on entry candle (M15 order unknown; M5 not fetched) -> excluded from wins.`);
L.push("");

function sub(side: Side | "combined", D: number, T: "A" | "B") { return trades.filter((t) => (side === "combined" || t.side === side) && t.dist === D && t.target === T); }
function detail(side: Side | "combined") {
  const nb = side === "combined" ? nBreakouts : nBySide[side];
  L.push("#".repeat(140)); L.push(`${String(side).toUpperCase()}${side === "support" ? " -> LONG" : side === "resistance" ? " -> SHORT" : ""}  (Range->Swing breakouts ${nb})`); L.push("#".repeat(140));
  L.push(["Dist", "Trig", "Trig%", "AvgSpr", "MedSpr", "A_ret", "A_prof%", "B_ret", "B_prof%", "NoRet%", "Amb%", "MedProfB", "MedProfA", "p25A", "p75A", "MedMAE", "p75MAE", "p90MAE", "MedRetB"].map((s) => s.padStart(8)).join(""));
  for (const D of DISTANCES) {
    const a = sub(side, D, "A"), bb = sub(side, D, "B");
    const trig = bb.filter((t) => t.triggered); const nt = trig.length;
    const aTr = a.filter((t) => t.triggered);
    const aProf = aTr.filter((t) => t.outcome === "profitable").length, aRet = aTr.filter((t) => t.outcome === "profitable" || t.outcome === "returned_not_profitable").length;
    const bProf = trig.filter((t) => t.outcome === "profitable").length, bRet = trig.filter((t) => t.outcome === "profitable" || t.outcome === "returned_not_profitable").length;
    const noRet = trig.filter((t) => t.outcome === "no_return").length, amb = trig.filter((t) => t.outcome === "ambiguous").length;
    const profB = trig.filter((t) => t.outcome === "profitable").map((t) => t.profit), profA = aTr.filter((t) => t.outcome === "profitable").map((t) => t.profit);
    const maeAll = trig.map((t) => t.mae), retB = trig.filter((t) => t.retBars != null && t.outcome === "profitable").map((t) => t.retBars!);
    L.push([`${D}p`, `${nt}`, f1(pct(nt, nb)), f2(mean(trig.map((t) => t.spread))), f2(med(trig.map((t) => t.spread))), `${aRet}`, f1(pct(aProf, nt)), `${bRet}`, f1(pct(bProf, nt)), f1(pct(noRet, nt)), f1(pct(amb, nt)), f2(med(profB)), f2(med(profA)), f2(q(profA, .25)), f2(q(profA, .75)), f2(med(maeAll)), f2(q(maeAll, .75)), f2(q(maeAll, .9)), f1(med(retB))].map((s) => s.padStart(8)).join(""));
  }
  L.push("");
}
for (const side of ["support", "resistance", "combined"] as const) detail(side);

// MAIN TABLE
L.push("=".repeat(140)); L.push("MAIN TABLE (combined) — profitable-return rates after real BID/ASK"); L.push("=".repeat(140));
L.push(["Entry", "Triggered", "Trigger%", "AvgSpread", "ProfRetA%", "ProfRetB%", "MedProfitB", "MedMAE", "NoReturn%", "MedRetTime"].map((s) => s.padStart(12)).join(""));
for (const D of DISTANCES) { const bb = sub("combined", D, "B").filter((t) => t.triggered); const a = sub("combined", D, "A").filter((t) => t.triggered); const nb = nBreakouts; const nt = bb.length; const retB = bb.filter((t) => t.retBars != null && t.outcome === "profitable").map((t) => t.retBars!); L.push([`${D}p`, `${nt}`, f1(pct(nt, nb)), f2(mean(bb.map((t) => t.spread))), f1(pct(a.filter((t) => t.outcome === "profitable").length, nt)), f1(pct(bb.filter((t) => t.outcome === "profitable").length, nt)), f2(med(bb.filter((t) => t.outcome === "profitable").map((t) => t.profit))), f2(med(bb.map((t) => t.mae))), f1(pct(bb.filter((t) => t.outcome === "no_return").length, nt)), `${f1(med(retB))}b/${f1(barsHrs(med(retB)))}h`].map((s) => s.padStart(12)).join("")); }
L.push("");

// SPREAD ANALYSIS: spread/gross-target and spread buckets (target B, combined)
L.push("=".repeat(140)); L.push("SPREAD ANALYSIS — spread as share of gross target distance (target B = D pips), combined"); L.push("=".repeat(140));
L.push(["Dist", "AvgSpread", "spread/D%", "ProfRetB%"].map((s) => s.padStart(12)).join(""));
for (const D of DISTANCES) { const bb = sub("combined", D, "B").filter((t) => t.triggered); const avgS = mean(bb.map((t) => t.spread)); L.push([`${D}p`, f2(avgS), f1(pct(avgS, D)), f1(pct(bb.filter((t) => t.outcome === "profitable").length, bb.length))].map((s) => s.padStart(12)).join("")); }
L.push("");
const SPB: Array<[string, (s: number) => boolean]> = [["<1", (s) => s < 1], ["1-1.5", (s) => s >= 1 && s < 1.5], ["1.5-2", (s) => s >= 1.5 && s < 2], ["2-3", (s) => s >= 2 && s < 3], ["3+", (s) => s >= 3]];
L.push("Spread buckets (combined, all distances pooled, target B): profitable-return rate & median net profit"); L.push("-".repeat(80));
L.push(["SpreadBucket", "Trades", "ProfRetB%", "MedNetProfit"].map((s) => s.padStart(14)).join(""));
for (const [nm, test] of SPB) { const bb = trades.filter((t) => t.target === "B" && t.triggered && test(t.spread)); L.push([nm, `${bb.length}`, f1(pct(bb.filter((t) => t.outcome === "profitable").length, bb.length)), f2(med(bb.filter((t) => t.outcome === "profitable").map((t) => t.profit)))].map((s) => s.padStart(14)).join("")); }
L.push("");

// TIME ANALYSIS: profitable returns (target B) completion windows, combined
L.push("=".repeat(140)); L.push("TIME ANALYSIS — of PROFITABLE returns (target B, combined), % completed within window"); L.push("=".repeat(140));
L.push(["Dist", ...WINDOWS.map(([nm]) => nm)].map((s) => s.padStart(9)).join(""));
for (const D of DISTANCES) { const prof = sub("combined", D, "B").filter((t) => t.outcome === "profitable" && t.retBars != null); L.push([`${D}p`, ...WINDOWS.map(([, bars]) => f1(pct(prof.filter((t) => t.retBars! <= bars).length, prof.length)))].map((s) => s.padStart(9)).join("")); }
L.push("");

// MAE analysis: adverse before success vs failure (target B, combined)
L.push("=".repeat(140)); L.push("MAE ANALYSIS (target B, combined) — adverse excursion in pips BEFORE success vs BEFORE no-return (design input for V10 stop)"); L.push("=".repeat(140));
L.push(["Dist", "Succ_med", "Succ_p75", "Succ_p90", "Succ_p95", "Succ_max", "Fail_med", "Fail_p75", "Fail_p90", "Fail_p95", "Fail_max"].map((s) => s.padStart(10)).join(""));
for (const D of DISTANCES) { const bb = sub("combined", D, "B").filter((t) => t.triggered); const succ = bb.filter((t) => t.outcome === "profitable").map((t) => t.mae); const fail = bb.filter((t) => t.outcome === "no_return").map((t) => t.mae); L.push([`${D}p`, f2(med(succ)), f2(q(succ, .75)), f2(q(succ, .9)), f2(q(succ, .95)), f2(q(succ, 1)), f2(med(fail)), f2(q(fail, .75)), f2(q(fail, .9)), f2(q(fail, .95)), f2(q(fail, 1))].map((s) => s.padStart(10)).join("")); }
L.push("");

const report = L.join("\n");
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-exec-report.txt"), report + "\n");
console.log(report.split("\n").slice(0, 6).join("\n"));

// event CSV (triggered entries, per target)
const csv: string[] = [];
csv.push(["side", "entry_distance_pips", "target", "triggered", "spread_pips", "outcome", "executable_profit_pips", "mae_pips", "return_bars"].join(","));
for (const t of trades) csv.push([t.side, t.dist, t.target, t.triggered ? "yes" : "no", Number.isFinite(t.spread) ? t.spread.toFixed(2) : "", t.outcome, Number.isFinite(t.profit) ? t.profit.toFixed(2) : "", Number.isFinite(t.mae) ? t.mae.toFixed(2) : "", t.retBars ?? ""].join(","));
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-exec-events.csv"), csv.join("\n") + "\n");
console.error(`[written] eurusd-15m-sr-exec-report.txt | eurusd-15m-sr-exec-events.csv (${trades.length} rows)`);

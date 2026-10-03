/**
 * EUR/USD 15M — RANGE->SWING + TREND + %-OF-RANGE TARGETS (V11, research-only, FROZEN).
 *
 * From frozen V10: on the "no swing between" 20p Range->Swing setup, does TREND at
 * entry decide how far ACROSS the range price travels? Frozen 40p stop (control).
 *
 * FROZEN from V10 (=V1-V9): S/R detection, range->swing cohort, breakout, BID/ASK exec,
 * M5 trade-path resolution, no-lookahead (entry only after breakout bar closes).
 * Setup: price breaks the RANGE level (L1), extends 20 pips past it, enter back toward
 * the range; require NO swing (S/R#2) between entry and L1 (gap > 20p, i.e. V10 no-swing).
 *
 * TARGET (new): a % of the FROZEN RANGE [rangeLow, rangeHigh] (both frozen at breakout).
 *   LONG (support break, L1=rangeLow):   TP% = rangeLow + pct*(rangeHigh-rangeLow)
 *   SHORT(resistance break, L1=rangeHigh):TP% = rangeHigh - pct*(rangeHigh-rangeLow)
 *   pct in {50,60,70}. SL frozen at 40 pips from entry (V10 control). RR varies by range.
 *
 * TREND at entry (frozen, no-lookahead; last completed M15 bar before entry): EMA20 vs
 *   EMA50 + EMA20 slope(3) + HH/HL vs LH/LL structure(20).
 *   BULLISH: ema20>ema50 & slope>0 & higher-highs&higher-lows.
 *   BEARISH: ema20<ema50 & slope<0 & lower-highs&lower-lows.  else NEUTRAL.
 *
 * Trade path on M5 BID/ASK (intrabar TP/SL order). This is a reachability/target study,
 * NOT a final strategy; trend def and stop are NOT optimized.
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle, MajorInstrument } from "../src/types/forex";
import { assessMarketCondition } from "../src/lib/strategy/market-condition";
import { atr14Of } from "../src/lib/strategy/sr-structure";
import { PRICE_REACTION_THRESHOLDS as PR } from "../src/lib/strategy/price-reaction";
import { pipSizeFor } from "../src/lib/instruments/catalog";

const INSTRUMENT: MajorInstrument = "EUR_USD"; const TIMEFRAME = "M15";
const M15C = "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m15-mba-cache.json";
const M5C = "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m5-mba-cache.json";
const OUT_DIR = "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad";
const WINDOW = 220, HORIZON = 96, PIP = pipSizeFor(INSTRUMENT); const H5 = HORIZON * 3;
const TOUCH_ATR = PR.touchAtr, MIN_PEN_ATR = PR.minPenetrationAtr, ACCEPT_MIN_BARS = PR.acceptMinBars, ACCEPT_MIN_DIST_ATR = PR.acceptMinDistanceAtr;
const D = 20, SL_PIPS = 40; const PCTS = [50, 60, 70];

type Side = "support" | "resistance"; type Kind = "range" | "swing"; type Trend = "bullish" | "bearish" | "neutral";
type OHLC = { open: number; high: number; low: number; close: number }; type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };
const raw: RC[] = JSON.parse(fs.readFileSync(M15C, "utf8")); const n = raw.length;
const mids: Candle[] = raw.map((c) => ({ time: c.time, open: c.mid.open, high: c.mid.high, low: c.mid.low, close: c.mid.close, volume: 0, complete: true }));

// EMAs on M15 closes
function ema(period: number) { const k = 2 / (period + 1); const out = new Float64Array(n); out[0] = raw[0]!.mid.close; for (let i = 1; i < n; i++) out[i] = raw[i]!.mid.close * k + out[i - 1]! * (1 - k); return out; }
const ema20 = ema(20), ema50 = ema(50);
function trendAt(i: number): Trend {
  if (i < 25) return "neutral"; const slope = ema20[i]! - ema20[i - 3]!;
  let hiR = -Infinity, hiO = -Infinity, loR = Infinity, loO = Infinity;
  for (let j = i - 9; j <= i; j++) { hiR = Math.max(hiR, raw[j]!.mid.high); loR = Math.min(loR, raw[j]!.mid.low); }
  for (let j = i - 19; j <= i - 10; j++) { hiO = Math.max(hiO, raw[j]!.mid.high); loO = Math.min(loO, raw[j]!.mid.low); }
  const hhhl = hiR > hiO && loR > loO, lhll = hiR < hiO && loR < loO;
  if (ema20[i]! > ema50[i]! && slope > 0 && hhhl) return "bullish";
  if (ema20[i]! < ema50[i]! && slope < 0 && lhll) return "bearish";
  return "neutral";
}

// M5
const m5raw: Array<[string, number, number, number, number, number, number]> = JSON.parse(fs.readFileSync(M5C, "utf8"));
const M = m5raw.length; const mt: string[] = new Array(M); const bh = new Float64Array(M), bl = new Float64Array(M), ah = new Float64Array(M), al = new Float64Array(M), bc = new Float64Array(M), ac = new Float64Array(M);
for (let i = 0; i < M; i++) { const r = m5raw[i]!; mt[i] = r[0]; bh[i] = r[1]; bl[i] = r[2]; ah[i] = r[3]; al[i] = r[4]; bc[i] = r[5]; ac[i] = r[6]; }
(m5raw as any).length = 0;
function lb(t: string) { let lo = 0, hi = M; while (lo < hi) { const m = (lo + hi) >> 1; if (mt[m]! < t) lo = m + 1; else hi = m; } return lo; }
function lbM15(t: string) { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (raw[m]!.time < t) lo = m + 1; else hi = m; } return lo; }

interface Brk { t0: number; side: Side; atr: number; L1: number; L2: number; rangeHi: number; rangeLo: number; k1: Kind; k2: Kind; }
const breaks: Brk[] = []; let armedR = true, armedS = true; const startT = WINDOW;
for (let t = startT; t < n; t++) {
  const window = mids.slice(t - WINDOW + 1, t + 1); const a = assessMarketCondition({ candles: window, instrument: INSTRUMENT, timeframe: TIMEFRAME });
  const lv = a.levels; if (!lv) continue; const loc = a.location; const cur = lv.current; const A = atr14Of(window); if (!(A > 0)) continue;
  const nearR = loc === "NEAR_RESISTANCE", nearS = loc === "NEAR_SUPPORT";
  if (nearR && armedR) { const c = [lv.rangeHigh, lv.swingHigh].filter((x): x is number => x !== null && x >= cur); if (c.length) { const L1 = c.reduce((p, q) => (q - cur < p - cur ? q : p)); const k1: Kind = L1 === lv.rangeHigh ? "range" : "swing"; const o = k1 === "range" ? lv.swingHigh : lv.rangeHigh; const k2: Kind = k1 === "range" ? "swing" : "range"; if (o !== null && o > L1) breaks.push({ t0: t, side: "resistance", atr: A, L1, L2: o, rangeHi: lv.rangeHigh, rangeLo: lv.rangeLow, k1, k2 }); armedR = false; } } else if (!nearR) armedR = true;
  if (nearS && armedS) { const c = [lv.rangeLow, lv.swingLow].filter((x): x is number => x !== null && x <= cur); if (c.length) { const L1 = c.reduce((p, q) => (cur - q < cur - p ? q : p)); const k1: Kind = L1 === lv.rangeLow ? "range" : "swing"; const o = k1 === "range" ? lv.swingLow : lv.rangeLow; const k2: Kind = k1 === "range" ? "swing" : "range"; if (o !== null && o < L1) breaks.push({ t0: t, side: "support", atr: A, L1, L2: o, rangeHi: lv.rangeHigh, rangeLo: lv.rangeLow, k1, k2 }); armedS = false; } } else if (!nearS) armedS = true;
}
const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
{ const enc: Array<{ t0: number; side: Side; L: number; atr: number }> = []; let aR = true, aS = true;
  for (let t = startT; t < n; t++) { const w = mids.slice(t - WINDOW + 1, t + 1); const a = assessMarketCondition({ candles: w, instrument: INSTRUMENT, timeframe: TIMEFRAME }); const lv = a.levels; if (!lv) continue; const loc = a.location; const cur = lv.current; const A = atr14Of(w); if (!(A > 0)) continue; const nR = loc === "NEAR_RESISTANCE", nS = loc === "NEAR_SUPPORT";
    if (nR && aR) { const c = [lv.rangeHigh, lv.swingHigh].filter((x): x is number => x !== null && x >= cur); if (c.length) { enc.push({ t0: t, side: "resistance", L: c.reduce((p, q) => (q - cur < p - cur ? q : p)), atr: A }); aR = false; } } else if (!nR) aR = true;
    if (nS && aS) { const c = [lv.rangeLow, lv.swingLow].filter((x): x is number => x !== null && x <= cur); if (c.length) { enc.push({ t0: t, side: "support", L: c.reduce((p, q) => (cur - q < cur - p ? q : p)), atr: A }); aS = false; } } else if (!nS) aS = true; }
  const v: Record<Side, { s: number; t: number }> = { support: { s: 0, t: 0 }, resistance: { s: 0, t: 0 } };
  for (const e of enc) { const w = TOUCH_ATR * e.atr, top = e.L + w, bot = e.L - w; let bb = 0, adv = e.side === "resistance" ? -Infinity : Infinity, done = false, ok = false; const end = Math.min(e.t0 + HORIZON, n - 1); for (let j = e.t0; j <= end && !done; j++) { const c = raw[j]!.mid; adv = e.side === "resistance" ? Math.max(adv, c.high) : Math.min(adv, c.low); const bcx = e.side === "resistance" ? c.close - e.L : e.L - c.close; if (bcx > w) bb++; else bb = 0; const acc = bb >= ACCEPT_MIN_BARS && bcx / e.atr >= ACCEPT_MIN_DIST_ATR; const pen = (e.side === "resistance" ? adv - e.L : e.L - adv) >= MIN_PEN_ATR * e.atr; const ins = e.side === "resistance" ? c.close <= top : c.close >= bot; if (acc) done = true; else if (pen && ins) { ok = true; done = true; } } v[e.side].t++; if (ok) v[e.side].s++; }
  const vS = pct(v.support.s, v.support.t), vR = pct(v.resistance.s, v.resistance.t);
  if (!(vS >= 78 && vS <= 84 && vR >= 78 && vR <= 84)) { console.error(`FIDELITY FAILED ${vS.toFixed(2)}/${vR.toFixed(2)}. STOP.`); process.exit(1); }
  (globalThis as any).__fid = { vS, vR };
}
const rsBreaks = breaks.filter((b) => b.k1 === "range" && b.k2 === "swing");

// ---- simulate ----
type OC = "win" | "loss" | "timeout" | "ambiguous";
interface Trade { side: Side; trend: Trend; pctT: number; entryTime: string; pnl: number; oc: OC; rangePips: number; }
interface Reach { side: Side; trend: Trend; r0: boolean; r25: boolean; r50: boolean; r60: boolean; r70: boolean; r100: boolean; }
const trades: Trade[] = []; const reaches: Reach[] = [];
let noBreakout = 0, noEntry = 0, swingBetween = 0;

for (const b of rsBreaks) {
  const isR = b.side === "resistance"; const gapP = Math.abs(b.L2 - b.L1) / PIP;
  let tB = -1; const sEnd = Math.min(b.t0 + HORIZON, n - 1);
  for (let j = b.t0; j <= sEnd; j++) { const c = raw[j]!.mid; const pen = isR ? c.high - b.L1 : b.L1 - c.low; if (pen >= MIN_PEN_ATR * b.atr) { tB = j; break; } }
  if (tB < 0) { noBreakout++; continue; }
  if (gapP <= D) { swingBetween++; continue; } // V10 "no swing between" filter (gap > 20p)
  const entryLevel = isR ? b.L1 + D * PIP : b.L1 - D * PIP;
  const m5start = lb(new Date(new Date(raw[tB]!.time).getTime() + 15 * 60000).toISOString());
  if (m5start >= M) continue;
  let ei = -1; const eEnd = Math.min(m5start + H5, M - 1);
  for (let k = m5start; k <= eEnd; k++) { if (isR ? bh[k]! >= entryLevel : al[k]! <= entryLevel) { ei = k; break; } }
  if (ei < 0) { noEntry++; continue; }
  // trend at last completed M15 bar before entry
  const em15 = lbM15(mt[ei]!); const ti = Math.max(1, Math.min(em15 - 1, n - 1)); const trend = trendAt(ti);
  const R = b.rangeHi - b.rangeLo; const rangePips = R / PIP;
  const rEnd = Math.min(ei + H5, M - 1);
  // reachability across the range from entry (no stop)
  const lvlAt = (p: number) => isR ? b.rangeHi - p * R : b.rangeLo + p * R;
  const reached = (target: number) => { for (let k = ei + 1; k <= rEnd; k++) { if (isR ? al[k]! <= target : bh[k]! >= target) return true; } return false; };
  reaches.push({ side: b.side, trend, r0: reached(lvlAt(0)), r25: reached(lvlAt(0.25)), r50: reached(lvlAt(0.5)), r60: reached(lvlAt(0.6)), r70: reached(lvlAt(0.7)), r100: reached(lvlAt(1.0)) });
  // trades: each pct target, frozen 40p SL
  const slLevel = isR ? entryLevel + SL_PIPS * PIP : entryLevel - SL_PIPS * PIP;
  for (const P of PCTS) {
    const tp = isR ? b.rangeHi - (P / 100) * R : b.rangeLo + (P / 100) * R;
    let oc: OC = "timeout", pnl = 0;
    for (let k = ei + 1; k <= rEnd; k++) {
      const tpTouch = isR ? al[k]! <= tp : bh[k]! >= tp; const slTouch = isR ? ah[k]! >= slLevel : bl[k]! <= slLevel;
      if (tpTouch && slTouch) { oc = "ambiguous"; break; }
      if (tpTouch) { oc = "win"; pnl = (isR ? entryLevel - tp : tp - entryLevel) / PIP; break; }
      if (slTouch) { oc = "loss"; pnl = -SL_PIPS; break; }
    }
    if (oc === "timeout") { const last = rEnd; pnl = (isR ? entryLevel - ac[last]! : bc[last]! - entryLevel) / PIP; }
    trades.push({ side: b.side, trend, pctT: P, entryTime: mt[ei]!, pnl, oc, rangePips });
  }
}

// ---- stats ----
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-"); const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const years = (new Date(raw[n - 1]!.time).getTime() - new Date(raw[startT]!.time).getTime()) / (365.25 * 864e5);
function stats(list: Trade[]) {
  const res = list.filter((t) => t.oc !== "ambiguous"); const wins = res.filter((t) => t.pnl > 0), losses = res.filter((t) => t.pnl < 0);
  const gW = wins.reduce((s, t) => s + t.pnl, 0), gL = -losses.reduce((s, t) => s + t.pnl, 0); const total = res.reduce((s, t) => s + t.pnl, 0);
  const seq = [...res].sort((a, b) => (a.entryTime < b.entryTime ? -1 : 1)); let eq = 0, pk = 0, dd = 0; for (const t of seq) { eq += t.pnl; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  return { n: res.length, wins: wins.length, losses: losses.length, amb: list.length - res.length, wr: pct(wins.length, wins.length + losses.length), avgW: mean(wins.map((t) => t.pnl)), avgL: mean(losses.map((t) => t.pnl)), pf: gL > 0 ? gW / gL : Infinity, exp: res.length ? total / res.length : NaN, total, dd, perYr: res.length / years };
}
const trends: Trend[] = ["bullish", "neutral", "bearish"];

const L: string[] = []; const fid = (globalThis as any).__fid;
L.push("EUR/USD 15M — RANGE->SWING + TREND + %-OF-RANGE TARGETS (V11, research-only, FROZEN)");
L.push(`FIDELITY: support ${f2(fid.vS)}%  resistance ${f2(fid.vR)}%  (81.37/81.56) -> PASS. Range->Swing breakouts (broke out): ${rsBreaks.length - noBreakout}.`);
L.push(`Setup: no-swing-between (gap>${D}p) 20p entry; SL frozen ${SL_PIPS}p; target = % across frozen range [rangeLow,rangeHigh]; trend = EMA20/50+slope+HH/HL. M5 path.`);
L.push(`No-swing-between entries taken: ${reaches.length} (swing-between skipped ${swingBetween}, no-entry ${noEntry}). ~${f1(reaches.length / years)}/yr. SMALL SAMPLE -> read cautiously.`);
L.push("");

// direction x trend x pct grid
for (const [dir, side] of [["LONG (support break)", "support"], ["SHORT (resistance break)", "resistance"]] as Array<[string, Side]>) {
  L.push("#".repeat(140)); L.push(`${dir}`); L.push("#".repeat(140));
  L.push(["Trend", "Target%", "Trades", "Win%", "AvgWin", "AvgLoss", "PF", "Exp/trd", "TotalPips", "MaxDD", "Trd/yr"].map((s) => s.padStart(10)).join(""));
  for (const tr of trends) { for (const P of PCTS) { const s = stats(trades.filter((t) => t.side === side && t.trend === tr && t.pctT === P)); L.push([tr, `${P}%`, `${s.n}`, f1(s.wr), f2(s.avgW), f2(s.avgL), f2(s.pf), f2(s.exp), f1(s.total), f1(s.dd), f1(s.perYr)].map((x) => x.padStart(10)).join("")); } L.push(""); }
}

// reachability by direction x trend
L.push("=".repeat(140)); L.push("REACHABILITY (from entry, no stop) — % of setups whose price reaches each range level"); L.push("=".repeat(140));
L.push(["Dir", "Trend", "Setups", "reach0%(S/R)", "reach25%", "reach50%", "reach60%", "reach70%", "reach100%(oppS/R)"].map((s) => s.padStart(12)).join(""));
for (const [dir, side] of [["LONG", "support"], ["SHORT", "resistance"]] as Array<[string, Side]>) {
  for (const tr of trends) { const r = reaches.filter((x) => x.side === side && x.trend === tr); L.push([dir, tr, `${r.length}`, f1(pct(r.filter((x) => x.r0).length, r.length)), f1(pct(r.filter((x) => x.r25).length, r.length)), f1(pct(r.filter((x) => x.r50).length, r.length)), f1(pct(r.filter((x) => x.r60).length, r.length)), f1(pct(r.filter((x) => x.r70).length, r.length)), f1(pct(r.filter((x) => x.r100).length, r.length))].map((x) => x.padStart(12)).join("")); }
  L.push("");
}

const report = L.join("\n");
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-trend-report.txt"), report + "\n");
console.log(report);
const csv: string[] = []; csv.push(["entry_time", "side", "trend", "target_pct", "outcome", "pnl_pips", "range_pips"].join(","));
for (const t of trades) csv.push([t.entryTime, t.side, t.trend, t.pctT, t.oc, t.pnl.toFixed(2), t.rangePips.toFixed(1)].join(","));
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-trend-events.csv"), csv.join("\n") + "\n");
console.error(`[written] eurusd-15m-sr-trend-report.txt | eurusd-15m-sr-trend-events.csv`);

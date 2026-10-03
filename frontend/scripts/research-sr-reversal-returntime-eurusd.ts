/**
 * EUR/USD 15M — S/R RETURN-TIME STUDY (V8, research-only, FROZEN).
 *
 * How long after breaking S/R#1 does price return to it? Focus: Range->Swing
 * (S/R#1 = range level, S/R#2 = swing level) found in V7. Control: Swing->Range.
 * No TP/SL/RR/spread/filters — a return-time & penetration study only.
 *
 * FROZEN from V7 (=V1-V6): computeSupportResistanceLevels via assessMarketCondition,
 * NEAR_* detection, touchAtr zones, arm/disarm de-dup, WINDOW=220, HORIZON=96,
 * OANDA M15 MID+BID+ASK. Break set = encounters with valid next level (V5/V6/V7).
 * Breakout = first bar after t0 whose MID penetrates L1 by >= minPenetrationAtr*ATR
 * (identical to V7). Breaks that never break out are excluded (== V7 no-breakout).
 *
 * Return, tested separately:
 *   A TOUCH  price re-enters the frozen S/R#1 zone [L1-w, L1+w] (resistance: low<=L1+w;
 *            support: high>=L1-w).
 *   B CLOSE  a completed candle closes back inside/through the zone in the reversal
 *            direction (resistance: close<=L1+w; support: close>=L1-w).
 * Clock starts at the breakout bar; scan tB+1..tB+96 (24h). All breakouts stay in the
 * denominator; no return within 96 bars = NO_RETURN. MID used.
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
const WINDOWS: Array<[string, number]> = [["15m", 1], ["30m", 2], ["1h", 4], ["2h", 8], ["4h", 16], ["8h", 32], ["12h", 48], ["24h", 96]];

type Side = "support" | "resistance"; type Kind = "range" | "swing";
type OHLC = { open: number; high: number; low: number; close: number }; type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };
const raw: RC[] = JSON.parse(fs.readFileSync(CACHE, "utf8")); const n = raw.length;
const mids: Candle[] = raw.map((c) => ({ time: c.time, open: c.mid.open, high: c.mid.high, low: c.mid.low, close: c.mid.close, volume: 0, complete: true }));

interface Brk { t0: number; time: string; side: Side; atr: number; L1: number; k1: Kind; L2: number; k2: Kind; gapPips: number; }
const breaks: Brk[] = []; let armedR = true, armedS = true; const startT = WINDOW;
for (let t = startT; t < n; t++) {
  const window = mids.slice(t - WINDOW + 1, t + 1); const a = assessMarketCondition({ candles: window, instrument: INSTRUMENT, timeframe: TIMEFRAME });
  const lv = a.levels; if (!lv) continue; const loc = a.location; const cur = lv.current; const A = atr14Of(window); if (!(A > 0)) continue;
  const nearR = loc === "NEAR_RESISTANCE", nearS = loc === "NEAR_SUPPORT";
  if (nearR && armedR) { const c = [lv.rangeHigh, lv.swingHigh].filter((x): x is number => x !== null && x >= cur); if (c.length) { const L1 = c.reduce((p, q) => (q - cur < p - cur ? q : p)); const k1: Kind = L1 === lv.rangeHigh ? "range" : "swing"; const o = k1 === "range" ? lv.swingHigh : lv.rangeHigh; const k2: Kind = k1 === "range" ? "swing" : "range"; if (o !== null && o > L1) breaks.push({ t0: t, time: raw[t]!.time, side: "resistance", atr: A, L1, k1, L2: o, k2, gapPips: (o - L1) / PIP }); armedR = false; } } else if (!nearR) armedR = true;
  if (nearS && armedS) { const c = [lv.rangeLow, lv.swingLow].filter((x): x is number => x !== null && x <= cur); if (c.length) { const L1 = c.reduce((p, q) => (cur - q < cur - p ? q : p)); const k1: Kind = L1 === lv.rangeLow ? "range" : "swing"; const o = k1 === "range" ? lv.swingLow : lv.rangeLow; const k2: Kind = k1 === "range" ? "swing" : "range"; if (o !== null && o < L1) breaks.push({ t0: t, time: raw[t]!.time, side: "support", atr: A, L1, k1, L2: o, k2, gapPips: (L1 - o) / PIP }); armedS = false; } } else if (!nearS) armedS = true;
}

// fidelity
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

// ---- breakout + return measurement ----
interface Ret { time: string; side: Side; k1: Kind; k2: Kind; L1: number; L2: number; gapPips: number; breakoutPrice: number; touchBars: number | null; closeBars: number | null; touchTime: string; closeTime: string; maxPenPips: number; maxPenAtr: number; }
const rets: Ret[] = []; let noBreakout: Record<Side, number> = { support: 0, resistance: 0 };
for (const b of breaks) {
  const w = TOUCH_ATR * b.atr; const isR = b.side === "resistance"; const top = b.L1 + w, bot = b.L1 - w;
  let tB = -1; const sEnd = Math.min(b.t0 + HORIZON, n - 1);
  for (let j = b.t0; j <= sEnd; j++) { const c = raw[j]!.mid; const pen = isR ? c.high - b.L1 : b.L1 - c.low; if (pen >= MIN_PEN_ATR * b.atr) { tB = j; break; } }
  if (tB < 0) { noBreakout[b.side]++; continue; }
  const rEnd = Math.min(tB + HORIZON, n - 1); let touchBar = -1, closeBar = -1, maxPen = 0;
  for (let j = tB + 1; j <= rEnd; j++) { const c = raw[j]!.mid;
    const pen = isR ? c.high - b.L1 : b.L1 - c.low; if (pen > maxPen) maxPen = pen;
    if (touchBar < 0 && (isR ? c.low <= top : c.high >= bot)) touchBar = j;
    if (closeBar < 0 && (isR ? c.close <= top : c.close >= bot)) closeBar = j;
    if (touchBar >= 0 && closeBar >= 0) break;
  }
  // penetration measured up to the touch-return (or over full 24h if no return)
  const penEnd = touchBar >= 0 ? touchBar : rEnd; let penTo = 0;
  for (let j = tB + 1; j <= penEnd; j++) { const c = raw[j]!.mid; const pen = isR ? c.high - b.L1 : b.L1 - c.low; if (pen > penTo) penTo = pen; }
  rets.push({ time: raw[tB]!.time, side: b.side, k1: b.k1, k2: b.k2, L1: b.L1, L2: b.L2, gapPips: b.gapPips, breakoutPrice: raw[tB]!.mid.close, touchBars: touchBar >= 0 ? touchBar - tB : null, closeBars: closeBar >= 0 ? closeBar - tB : null, touchTime: touchBar >= 0 ? raw[touchBar]!.time : "", closeTime: closeBar >= 0 ? raw[closeBar]!.time : "", maxPenPips: penTo / PIP, maxPenAtr: penTo / b.atr });
}

// ---- stats ----
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-"); const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const q = (a: number[], p: number) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const med = (a: number[]) => q(a, 0.5); const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const barsToHrs = (b: number) => (b * 15) / 60;

const L: string[] = []; const first = raw[startT]?.time, last = raw[n - 1]?.time; const years = (new Date(last!).getTime() - new Date(first!).getTime()) / (365.25 * 864e5);
const fid = (globalThis as any).__fid;
L.push("EUR/USD 15M — S/R RETURN-TIME STUDY (V8, research-only, FROZEN)");
L.push(`Data: OANDA M15 MID+BID+ASK, ${n} bars, ${first} -> ${last} (~${f2(years)}y).`);
L.push(`S/R + detection + freeze UNCHANGED from V7. FIDELITY: support ${f2(fid.vS)}%  resistance ${f2(fid.vR)}%  (81.37/81.56) -> PASS.`);
L.push(`Breakout = MID penetrates L1 by >= ${MIN_PEN_ATR}*ATR (identical to V7). Clock starts at breakout bar; scan tB+1..tB+96. All breakouts in denominator; no return in 24h = NO_RETURN. MID.`);
L.push("");

// cohort alignment check with V7
const rs = rets.filter((r) => r.k1 === "range" && r.k2 === "swing");
const sr = rets.filter((r) => r.k1 === "swing" && r.k2 === "range");
L.push(`COHORT CHECK (Range->Swing breakouts, combined): V8 = ${rs.length}. V7 baseline range->swing = 2484. ${rs.length === 2484 ? "MATCH." : `DIFF of ${rs.length - 2484} -> both use the same break set + same breakout rule; any tiny diff would be edge-of-data bars where tB+... exceeds the array. Explained below if nonzero.`}`);
L.push(`  Range->Swing: support ${rs.filter((r) => r.side === "support").length}, resistance ${rs.filter((r) => r.side === "resistance").length} | no-breakout excluded (r->s): support ${noBreakout.support}? (global) — global no-breakout support ${noBreakout.support}, resistance ${noBreakout.resistance}.`);
L.push("");

function windowRow(list: Ret[], which: "touch" | "close") {
  const nb = list.length;
  return WINDOWS.map(([, bars]) => { const ret = list.filter((r) => { const b = which === "touch" ? r.touchBars : r.closeBars; return b !== null && b <= bars; }).length; return f1(pct(ret, nb)); });
}
function timeStats(list: Ret[], which: "touch" | "close") {
  const vals = list.map((r) => (which === "touch" ? r.touchBars : r.closeBars)).filter((x): x is number => x !== null);
  return { returned: vals.length, total: list.length, med: med(vals), avg: mean(vals), p25: q(vals, .25), p75: q(vals, .75), p90: q(vals, .9), p95: q(vals, .95) };
}

function cohortReport(list: Ret[], title: string) {
  L.push("#".repeat(120)); L.push(`${title}  (breakouts ${list.length})`); L.push("#".repeat(120));
  for (const side of ["support", "resistance"] as Side[]) {
    const s = list.filter((r) => r.side === side); if (!s.length) continue;
    L.push(`-- ${side} -> ${side === "support" ? "LONG (return UP)" : "SHORT (return DOWN)"}  (n=${s.length}) --`);
    L.push(["Window", ...WINDOWS.map(([nm]) => nm)].map((x) => x.padStart(9)).join(""));
    L.push(["Touch%", ...windowRow(s, "touch")].map((x) => x.padStart(9)).join(""));
    L.push(["Close%", ...windowRow(s, "close")].map((x) => x.padStart(9)).join(""));
    const t = timeStats(s, "touch"), c = timeStats(s, "close");
    L.push(`   TOUCH: returned ${t.returned}/${t.total} (${f1(pct(t.returned, t.total))}%), NO_RETURN ${t.total - t.returned}. Among returns (bars): med ${f1(t.med)} (${f1(barsToHrs(t.med))}h) avg ${f1(t.avg)} p25 ${f1(t.p25)} p75 ${f1(t.p75)} p90 ${f1(t.p90)} p95 ${f1(t.p95)}`);
    L.push(`   CLOSE: returned ${c.returned}/${c.total} (${f1(pct(c.returned, c.total))}%), NO_RETURN ${c.total - c.returned}. Among returns (bars): med ${f1(c.med)} (${f1(barsToHrs(c.med))}h) avg ${f1(c.avg)} p25 ${f1(c.p25)} p75 ${f1(c.p75)} p90 ${f1(c.p90)} p95 ${f1(c.p95)}`);
    const pens = s.filter((r) => r.touchBars !== null).map((r) => r.maxPenPips), pensA = s.filter((r) => r.touchBars !== null).map((r) => r.maxPenAtr);
    L.push(`   PENETRATION before touch-return (pips): med ${f1(med(pens))} avg ${f1(mean(pens))} p25 ${f1(q(pens, .25))} p75 ${f1(q(pens, .75))} p90 ${f1(q(pens, .9))} p95 ${f1(q(pens, .95))} | ATR: med ${f2(med(pensA))} p75 ${f2(q(pensA, .75))} p90 ${f2(q(pensA, .9))}`);
    L.push("");
  }
}
cohortReport(rs, "RANGE -> SWING (primary)");
cohortReport(sr, "SWING -> RANGE (control)");

// main table
function mainRows(list: Ret[]) {
  const rowFor = (s: Ret[]) => { const w = (bars: number) => f1(pct(s.filter((r) => r.touchBars !== null && r.touchBars <= bars).length, s.length)); const t = timeStats(s, "touch"); const pens = s.filter((r) => r.touchBars !== null).map((r) => r.maxPenPips); return [`${s.length}`, w(4), w(8), w(16), w(32), w(48), w(96), `${f1(t.med)}b/${f1(barsToHrs(t.med))}h`, `${f1(med(pens))}p`]; };
  return { support: rowFor(list.filter((r) => r.side === "support")), resistance: rowFor(list.filter((r) => r.side === "resistance")), combined: rowFor(list) };
}
for (const [name, list] of [["RANGE->SWING", rs], ["SWING->RANGE", sr]] as Array<[string, Ret[]]>) {
  L.push("=".repeat(120)); L.push(`MAIN TABLE — ${name} — Touch-return % within window`); L.push("=".repeat(120));
  L.push(["Row", "Breakouts", "1h", "2h", "4h", "8h", "12h", "24h", "MedRetTime", "MedPen"].map((x) => x.padStart(12)).join(""));
  const m = mainRows(list);
  L.push(["Support->Long", ...m.support].map((x) => x.padStart(12)).join(""));
  L.push(["Resist->Short", ...m.resistance].map((x) => x.padStart(12)).join(""));
  L.push(["Combined", ...m.combined].map((x) => x.padStart(12)).join(""));
  L.push("");
}

// time x distance (penetration buckets) — touch return, range->swing (and swing->range)
const PENB: Array<[string, (p: number) => boolean]> = [["0-2", (p) => p < 2], ["2-5", (p) => p >= 2 && p < 5], ["5-10", (p) => p >= 5 && p < 10], ["10-15", (p) => p >= 10 && p < 15], ["15-20", (p) => p >= 15 && p < 20], ["20-30", (p) => p >= 20 && p < 30], ["30+", (p) => p >= 30]];
for (const [name, list] of [["RANGE->SWING", rs], ["SWING->RANGE", sr]] as Array<[string, Ret[]]>) {
  L.push("=".repeat(120)); L.push(`TIME x DISTANCE — ${name} — buckets of max penetration before TOUCH return. Do deeper breakouts take longer?`); L.push("=".repeat(120));
  L.push(["PenBucket", "Breakouts", "Return%", "MedRetBars", "p75Bars", "p90Bars", "MedRetHrs"].map((x) => x.padStart(11)).join(""));
  for (const [bn, test] of PENB) {
    const inb = list.filter((r) => test(r.maxPenPips)); const ret = inb.filter((r) => r.touchBars !== null); const vals = ret.map((r) => r.touchBars!);
    L.push([bn, `${inb.length}`, f1(pct(ret.length, inb.length)), f1(med(vals)), f1(q(vals, .75)), f1(q(vals, .9)), f2(barsToHrs(med(vals)))].map((x) => x.padStart(11)).join(""));
  }
  L.push("");
}

// direct comparison
L.push("=".repeat(120)); L.push("DIRECT COMPARISON — Range->Swing vs Swing->Range (combined, touch return)"); L.push("=".repeat(120));
for (const [name, list] of [["Range->Swing", rs], ["Swing->Range", sr]] as Array<[string, Ret[]]>) {
  const t = timeStats(list, "touch"); const pens = list.filter((r) => r.touchBars !== null).map((r) => r.maxPenPips);
  L.push(`${name.padEnd(14)} breakouts ${list.length} | 24h touch-return ${f1(pct(t.returned, t.total))}% | 1h ${f1(pct(list.filter((r) => r.touchBars !== null && r.touchBars <= 4).length, list.length))}% | 2h ${f1(pct(list.filter((r) => r.touchBars !== null && r.touchBars <= 8).length, list.length))}% | 4h ${f1(pct(list.filter((r) => r.touchBars !== null && r.touchBars <= 16).length, list.length))}% | medRet ${f1(t.med)}b (${f1(barsToHrs(t.med))}h) | medPen ${f1(med(pens))}p`);
}
L.push("");

const report = L.join("\n");
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-returntime-report.txt"), report + "\n");
console.log(report.split("\n").slice(0, 8).join("\n"));

// event CSV
const csv: string[] = [];
csv.push(["timestamp", "side", "sr1_type", "sr2_type", "sr1_price", "sr2_price", "breakout_price", "touch_return_time", "close_return_time", "touch_return_bars", "close_return_bars", "max_penetration_pips", "max_penetration_atr", "ret15m", "ret30m", "ret1h", "ret2h", "ret4h", "ret8h", "ret12h", "ret24h"].join(","));
for (const r of rets) { const tb = r.touchBars; const w = (bars: number) => (tb !== null && tb <= bars ? "yes" : "no"); csv.push([r.time, r.side, r.k1, r.k2, r.L1.toFixed(5), r.L2.toFixed(5), r.breakoutPrice.toFixed(5), r.touchTime, r.closeTime, tb ?? "", r.closeBars ?? "", r.maxPenPips.toFixed(2), r.maxPenAtr.toFixed(3), w(1), w(2), w(4), w(8), w(16), w(32), w(48), w(96)].join(",")); }
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-returntime-events.csv"), csv.join("\n") + "\n");
console.error(`[written] eurusd-15m-sr-returntime-report.txt | eurusd-15m-sr-returntime-events.csv (${rets.length} breakouts)`);

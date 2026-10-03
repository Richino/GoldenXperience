/**
 * EUR/USD 15M — S/R POST-BREAKOUT CONFIRMATION TEST (V7, research-only, FROZEN).
 *
 * V6 proved distance past S/R carries no direction. V7 asks: does a PRICE-ACTION
 * confirmation after the breakout signal the reversal has actually begun? No RR,
 * TP, SL, or profitability — a pure direction test vs the breakout baseline.
 *
 * FROZEN from V6 (=V1-V5): computeSupportResistanceLevels via assessMarketCondition,
 * NEAR_* detection, touchAtr zones, arm/disarm de-dup, WINDOW=220, HORIZON=96,
 * OANDA M15 MID+BID+ASK. Break set = encounters with a valid next level (as V5/V6).
 * "Breakout" = first bar after t0 whose MID penetrates L1 by >= minPenetrationAtr*ATR
 * (the project's meaningful-penetration rule). Breaks that never break out are excluded.
 *
 * Confirmations (each detected once, first occurrence, no look-ahead), resistance
 * (mirror for support: favorable = UP toward S/R):
 *   A FAILED NEW EXTREME  first bar after breakout that fails to exceed the running high
 *   B FIRST OPPOSITE      first completed bearish candle after breakout
 *   C CLOSE TOWARD S/R    first candle closing nearer S/R#1 than the prior close
 *   D 2 CLOSES TOWARD     two consecutive such candles
 *   E BREAK PREV CANDLE   first candle closing below the previous candle's low
 *   F RECLAIM S/R         first candle closing back inside/through the S/R#1 zone
 * Combos A+B,A+C,A+E,B+C,B+E,C+E fire at the LATER of the two component bars.
 *
 * From each confirmation's candle close, over the next HORIZON bars, measure max
 * favorable/adverse (toward/away from S/R) and a FIRST-HIT direction test: does
 * favorable reach X pips before adverse reaches X pips (X=5,10,15,20)? Same M15
 * candle touches both => AMBIGUOUS (excluded). Baseline = same test from the
 * breakout bar close (entering just because S/R broke). MID for behaviour.
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
const THRESH = [5, 10, 15, 20];

type Side = "support" | "resistance"; type Kind = "range" | "swing";
type OHLC = { open: number; high: number; low: number; close: number }; type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };
const raw: RC[] = JSON.parse(fs.readFileSync(CACHE, "utf8")); const n = raw.length;
const mids: Candle[] = raw.map((c) => ({ time: c.time, open: c.mid.open, high: c.mid.high, low: c.mid.low, close: c.mid.close, volume: 0, complete: true }));

interface Brk { t0: number; time: string; year: number; side: Side; atr: number; L1: number; k1: Kind; L2: number; k2: Kind; gapPips: number; }
const breaks: Brk[] = []; let armedR = true, armedS = true; const startT = WINDOW;
for (let t = startT; t < n; t++) {
  const window = mids.slice(t - WINDOW + 1, t + 1); const a = assessMarketCondition({ candles: window, instrument: INSTRUMENT, timeframe: TIMEFRAME });
  const lv = a.levels; if (!lv) continue; const loc = a.location; const cur = lv.current; const A = atr14Of(window); if (!(A > 0)) continue;
  const nearR = loc === "NEAR_RESISTANCE", nearS = loc === "NEAR_SUPPORT";
  if (nearR && armedR) { const c = [lv.rangeHigh, lv.swingHigh].filter((x): x is number => x !== null && x >= cur); if (c.length) { const L1 = c.reduce((p, q) => (q - cur < p - cur ? q : p)); const k1: Kind = L1 === lv.rangeHigh ? "range" : "swing"; const o = k1 === "range" ? lv.swingHigh : lv.rangeHigh; const k2: Kind = k1 === "range" ? "swing" : "range"; if (o !== null && o > L1) breaks.push({ t0: t, time: raw[t]!.time, year: new Date(raw[t]!.time).getUTCFullYear(), side: "resistance", atr: A, L1, k1, L2: o, k2, gapPips: (o - L1) / PIP }); armedR = false; } } else if (!nearR) armedR = true;
  if (nearS && armedS) { const c = [lv.rangeLow, lv.swingLow].filter((x): x is number => x !== null && x <= cur); if (c.length) { const L1 = c.reduce((p, q) => (cur - q < cur - p ? q : p)); const k1: Kind = L1 === lv.rangeLow ? "range" : "swing"; const o = k1 === "range" ? lv.swingLow : lv.rangeLow; const k2: Kind = k1 === "range" ? "swing" : "range"; if (o !== null && o < L1) breaks.push({ t0: t, time: raw[t]!.time, year: new Date(raw[t]!.time).getUTCFullYear(), side: "support", atr: A, L1, k1, L2: o, k2, gapPips: (L1 - o) / PIP }); armedS = false; } } else if (!nearS) armedS = true;
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

// ---- forward direction test from a reference bar (measure from close[refBar], scan refBar+1..+HORIZON) ----
function forward(refBar: number, side: Side, entry: number) {
  const end = Math.min(refBar + HORIZON, n - 1); let maxFav = 0, maxAdv = 0;
  const hit: Record<number, "fav" | "adv" | "ambig" | "none"> = { 5: "none", 10: "none", 15: "none", 20: "none" };
  const pending = new Set(THRESH);
  for (let j = refBar + 1; j <= end; j++) { const c = raw[j]!.mid;
    const fav = (side === "resistance" ? entry - c.low : c.high - entry) / PIP;
    const adv = (side === "resistance" ? c.high - entry : entry - c.low) / PIP;
    if (fav > maxFav) maxFav = fav; if (adv > maxAdv) maxAdv = adv;
    for (const X of [...pending]) { const f = fav >= X, a = adv >= X; if (f && a) { hit[X] = "ambig"; pending.delete(X); } else if (f) { hit[X] = "fav"; pending.delete(X); } else if (a) { hit[X] = "adv"; pending.delete(X); } }
    if (!pending.size) break;
  }
  return { maxFav, maxAdv, hit };
}

// ---- per break: breakout bar + confirmation fire bars ----
const LABELS = ["Baseline", "A", "B", "C", "D", "E", "F", "A+B", "A+C", "A+E", "B+C", "B+E", "C+E"] as const; type Label = typeof LABELS[number];
interface Sig { side: Side; k1: Kind; k2: Kind; gap: number; refBar: number; entry: number; }
const sigs: Record<Label, Sig[]> = Object.fromEntries(LABELS.map((l) => [l, []])) as any;
let noBreakout = { support: 0, resistance: 0 };

for (const b of breaks) {
  const w = TOUCH_ATR * b.atr; const isR = b.side === "resistance";
  // breakout bar tB: first bar after t0 penetrating L1 by >= minPen
  let tB = -1; const sEnd = Math.min(b.t0 + HORIZON, n - 1);
  for (let j = b.t0; j <= sEnd; j++) { const c = raw[j]!.mid; const pen = isR ? c.high - b.L1 : b.L1 - c.low; if (pen >= MIN_PEN_ATR * b.atr) { tB = j; break; } }
  if (tB < 0) { noBreakout[b.side]++; continue; }
  // detect confirmations after tB
  let peak = isR ? raw[tB]!.mid.high : raw[tB]!.mid.low; let towardCount = 0;
  let fA = -1, fB = -1, fC = -1, fD = -1, fE = -1, fF = -1;
  const end = Math.min(tB + HORIZON, n - 1);
  for (let j = tB + 1; j <= end; j++) {
    const c = raw[j]!.mid, p = raw[j - 1]!.mid;
    const newExtreme = isR ? c.high > peak : c.low < peak;
    if (newExtreme) { peak = isR ? c.high : c.low; } else if (fA < 0) fA = j; // failed new extreme
    if (fB < 0 && (isR ? c.close < c.open : c.close > c.open)) fB = j; // first opposite candle
    const towardClose = isR ? c.close < p.close : c.close > p.close;
    if (towardClose) { towardCount++; if (fC < 0) fC = j; if (fD < 0 && towardCount >= 2) fD = j; } else towardCount = 0;
    if (fE < 0 && (isR ? c.close < p.low : c.close > p.high)) fE = j; // break previous candle
    if (fF < 0 && (isR ? c.close <= b.L1 + w : c.close >= b.L1 - w)) fF = j; // reclaim zone
  }
  const push = (label: Label, refBar: number) => { if (refBar >= 0 && refBar < n) sigs[label].push({ side: b.side, k1: b.k1, k2: b.k2, gap: b.gapPips, refBar, entry: raw[refBar]!.mid.close }); };
  push("Baseline", tB);
  push("A", fA); push("B", fB); push("C", fC); push("D", fD); push("E", fE); push("F", fF);
  const combo = (l: Label, x: number, y: number) => { if (x >= 0 && y >= 0) push(l, Math.max(x, y)); };
  combo("A+B", fA, fB); combo("A+C", fA, fC); combo("A+E", fA, fE); combo("B+C", fB, fC); combo("B+E", fB, fE); combo("C+E", fC, fE);
}

// ---- aggregate ----
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-"); const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const q = (a: number[], p: number) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const med = (a: number[]) => q(a, 0.5);

interface Agg { signals: number; dir: Record<number, number>; ambig: Record<number, number>; medFav: number; medAdv: number; p75Fav: number; p75Adv: number; p90Fav: number; p90Adv: number; }
function aggregate(list: Sig[]): Agg {
  const favs: number[] = [], advs: number[] = [];
  const favWin: Record<number, number> = { 5: 0, 10: 0, 15: 0, 20: 0 }, advWin: Record<number, number> = { 5: 0, 10: 0, 15: 0, 20: 0 }, amb: Record<number, number> = { 5: 0, 10: 0, 15: 0, 20: 0 };
  for (const s of list) { const r = forward(s.refBar, s.side, s.entry); favs.push(r.maxFav); advs.push(r.maxAdv); for (const X of THRESH) { const h = r.hit[X]; if (h === "fav") favWin[X]++; else if (h === "adv") advWin[X]++; else if (h === "ambig") amb[X]++; } }
  const dir: Record<number, number> = {}, ambig: Record<number, number> = {};
  for (const X of THRESH) { dir[X] = pct(favWin[X], favWin[X] + advWin[X]); ambig[X] = pct(amb[X], list.length); }
  return { signals: list.length, dir, ambig, medFav: med(favs), medAdv: med(advs), p75Fav: q(favs, .75), p75Adv: q(advs, .75), p90Fav: q(favs, .9), p90Adv: q(advs, .9) };
}

const sides: Side[] = ["support", "resistance"];
const L: string[] = []; const first = raw[startT]?.time, last = raw[n - 1]?.time; const years = (new Date(last!).getTime() - new Date(first!).getTime()) / (365.25 * 864e5);
const fid = (globalThis as any).__fid;
L.push("EUR/USD 15M — S/R POST-BREAKOUT CONFIRMATION TEST (V7, research-only, FROZEN)");
L.push(`Data: OANDA M15 MID+BID+ASK, ${n} bars, ${first} -> ${last} (~${f2(years)}y).`);
L.push(`S/R + detection + freeze UNCHANGED from V6. FIDELITY: support ${f2(fid.vS)}%  resistance ${f2(fid.vR)}%  (81.37/81.56) -> PASS.`);
L.push(`Breaks w/ next level: support ${breaks.filter((b) => b.side === "support").length}, resistance ${breaks.filter((b) => b.side === "resistance").length}. No-breakout (never penetrated L1 by ${MIN_PEN_ATR}ATR): support ${noBreakout.support}, resistance ${noBreakout.resistance}.`);
L.push(`Direction test: FIRST-HIT favorable(toward S/R) vs adverse at X pips from the confirmation candle close, next ${HORIZON} bars. Same-candle both = AMBIGUOUS (excluded). >50% = favorable edge. MID.`);
L.push("");

function table(getList: (label: Label) => Sig[], title: string) {
  L.push("=".repeat(122)); L.push(title); L.push("=".repeat(122));
  L.push(["Confirm", "Signals", "dir5%", "dir10%", "dir15%", "dir20%", "MedFav", "MedAdv", "p90Fav", "p90Adv", "amb10%"].map((s) => s.padStart(10)).join(""));
  for (const label of LABELS) { const a = aggregate(getList(label)); L.push([label, `${a.signals}`, f1(a.dir[5]!), f1(a.dir[10]!), f1(a.dir[15]!), f1(a.dir[20]!), f2(a.medFav), f2(a.medAdv), f2(a.p90Fav), f2(a.p90Adv), f1(a.ambig[10]!)].map((s) => s.padStart(10)).join("")); }
  L.push("");
}

table((l) => sigs[l], "MAIN TABLE — COMBINED support+resistance (dir% >50 = favorable/reversal edge; MedFav vs MedAdv symmetry)");
for (const side of sides) table((l) => sigs[l].filter((s) => s.side === side), `${side.toUpperCase()} -> ${side === "support" ? "LONG (reversal UP)" : "SHORT (reversal DOWN)"}`);
for (const [a, bk] of [["range", "swing"], ["swing", "range"]] as Array<[Kind, Kind]>) table((l) => sigs[l].filter((s) => s.k1 === a && s.k2 === bk), `S/R TYPE ${a}->${bk} (combined sides)`);

// gap breakdown: dir10% matrix (confirmation x gap) + signals
const GAPB: Array<[string, (g: number) => boolean]> = [["0-5", (g) => g <= 5], ["5-10", (g) => g > 5 && g <= 10], ["10-15", (g) => g > 10 && g <= 15], ["15-20", (g) => g > 15 && g <= 20], ["20-30", (g) => g > 20 && g <= 30], ["30+", (g) => g > 30]];
L.push("=".repeat(122)); L.push("GAP-SIZE breakdown (combined) — dir10% (favorable-first at 10 pips) by confirmation x gap"); L.push("=".repeat(122));
L.push(["Confirm", ...GAPB.map(([nm]) => nm)].map((s) => s.padStart(11)).join(""));
for (const label of LABELS) L.push([label, ...GAPB.map(([, test]) => f1(aggregate(sigs[label].filter((s) => test(s.gap))).dir[10]!))].map((s) => s.padStart(11)).join(""));
L.push("");

const report = L.join("\n");
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-confirm-report.txt"), report + "\n");
console.log(report.split("\n").slice(0, 6).join("\n"));

// event CSV: one row per signal (label, side, refbar behaviour)
const csv: string[] = [];
csv.push(["timestamp_break", "confirmation", "side", "sr1_type", "sr2_type", "gap_pips", "confirm_bar_time", "entry_close", "max_fav_pips", "max_adv_pips", "hit5", "hit10", "hit15", "hit20"].join(","));
for (const label of LABELS) for (const s of sigs[label]) { const r = forward(s.refBar, s.side, s.entry); csv.push([raw[s.refBar]!.time, label, s.side, s.k1, s.k2, s.gap.toFixed(2), raw[s.refBar]!.time, s.entry.toFixed(5), r.maxFav.toFixed(2), r.maxAdv.toFixed(2), r.hit[5], r.hit[10], r.hit[15], r.hit[20]].join(",")); }
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-confirm-events.csv"), csv.join("\n") + "\n");
console.error(`[written] eurusd-15m-sr-confirm-report.txt | eurusd-15m-sr-confirm-events.csv (${LABELS.reduce((s, l) => s + sigs[l].length, 0)} signals)`);

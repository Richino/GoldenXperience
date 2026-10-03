/**
 * EUR/USD 15M — S/R CONDITIONAL ENTRY BEHAVIOUR (V6, research-only, FROZEN).
 *
 * V5 found reversals cluster ~2-3 pips beyond S/R#1. V6 asks the CONDITIONAL
 * question: GIVEN price has already reached D pips beyond S/R#1, what happens
 * NEXT? (turn back vs keep going). No TP/SL, no RR, no filters, no final strategy.
 *
 * FROZEN from V5 (=V4=V1-V3): computeSupportResistanceLevels via assessMarketCondition,
 * NEAR_* detection, touchAtr zones, arm/disarm de-dup, WINDOW=220, HORIZON=96,
 * OANDA M15 MID+BID+ASK, R2/S2 = the other exposed level (for gap/type breakdown).
 * Break set = encounters that have a valid next level (same as V5). Entry distance
 * is measured from the LEVEL LINE L1 (as V5's excursion was), NOT the zone edge.
 *
 * Conditioning: for each distance D independently, trigger when MID reaches L1+-D
 * (scan t0+1.., no look-ahead). THEN measure forward from that entry bar over
 * HORIZON bars: max favorable move (toward S/R) and max adverse move (continuation).
 * Reversal confirmations, tracked separately (never mixed):
 *   A = favorable move >= 0.25 ATR from entry
 *   B = favorable move >= 0.50 ATR from entry
 *   C = favorable move >= 1.00 ATR from entry
 *   D = reclaim S/R#1 (MID close back inside the S/R#1 zone)
 * MID used for behaviour (bid/ask available; spread logged), consistent with V5.
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
const DISTANCES = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

type Side = "support" | "resistance"; type Kind = "range" | "swing";
type OHLC = { open: number; high: number; low: number; close: number }; type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };
const raw: RC[] = JSON.parse(fs.readFileSync(CACHE, "utf8")); const n = raw.length;
const mids: Candle[] = raw.map((c) => ({ time: c.time, open: c.mid.open, high: c.mid.high, low: c.mid.low, close: c.mid.close, volume: 0, complete: true }));

interface Brk { t0: number; time: string; year: number; side: Side; atr: number; L1: number; k1: Kind; L2: number; k2: Kind; gapPips: number; spreadPips: number; }
const breaks: Brk[] = []; let armedR = true, armedS = true; const startT = WINDOW;
for (let t = startT; t < n; t++) {
  const window = mids.slice(t - WINDOW + 1, t + 1); const a = assessMarketCondition({ candles: window, instrument: INSTRUMENT, timeframe: TIMEFRAME });
  const lv = a.levels; if (!lv) continue; const loc = a.location; const cur = lv.current; const A = atr14Of(window); if (!(A > 0)) continue;
  const nearR = loc === "NEAR_RESISTANCE", nearS = loc === "NEAR_SUPPORT";
  if (nearR && armedR) { const c = [lv.rangeHigh, lv.swingHigh].filter((x): x is number => x !== null && x >= cur); if (c.length) { const L1 = c.reduce((p, q) => (q - cur < p - cur ? q : p)); const k1: Kind = L1 === lv.rangeHigh ? "range" : "swing"; const o = k1 === "range" ? lv.swingHigh : lv.rangeHigh; const k2: Kind = k1 === "range" ? "swing" : "range"; if (o !== null && o > L1) breaks.push({ t0: t, time: raw[t]!.time, year: new Date(raw[t]!.time).getUTCFullYear(), side: "resistance", atr: A, L1, k1, L2: o, k2, gapPips: (o - L1) / PIP, spreadPips: (raw[t]!.ask.close - raw[t]!.bid.close) / PIP }); armedR = false; } } else if (!nearR) armedR = true;
  if (nearS && armedS) { const c = [lv.rangeLow, lv.swingLow].filter((x): x is number => x !== null && x <= cur); if (c.length) { const L1 = c.reduce((p, q) => (cur - q < cur - p ? q : p)); const k1: Kind = L1 === lv.rangeLow ? "range" : "swing"; const o = k1 === "range" ? lv.swingLow : lv.rangeLow; const k2: Kind = k1 === "range" ? "swing" : "range"; if (o !== null && o < L1) breaks.push({ t0: t, time: raw[t]!.time, year: new Date(raw[t]!.time).getUTCFullYear(), side: "support", atr: A, L1, k1, L2: o, k2, gapPips: (L1 - o) / PIP, spreadPips: (raw[t]!.ask.close - raw[t]!.bid.close) / PIP }); armedS = false; } } else if (!nearS) armedS = true;
}

// fidelity (ALL encounters, project reclaim from t0)
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

// V6 conditional measurement
interface Ev { time: string; year: number; side: Side; k1: Kind; k2: Kind; gapPips: number; dist: number; triggered: boolean; favPips: number; advPips: number; favAtr: number; advAtr: number; turn25: boolean; turn50: boolean; turn100: boolean; reclaim: boolean; spreadPips: number; }
const evs: Ev[] = [];
for (const b of breaks) {
  const w = TOUCH_ATR * b.atr;
  for (const D of DISTANCES) {
    const entry = b.side === "resistance" ? b.L1 + D * PIP : b.L1 - D * PIP;
    let entryBar = -1; const scanEnd = Math.min(b.t0 + HORIZON, n - 1);
    for (let j = b.t0 + 1; j <= scanEnd; j++) { const m = raw[j]!.mid; if (b.side === "resistance" ? m.high >= entry : m.low <= entry) { entryBar = j; break; } }
    if (entryBar < 0) { evs.push({ time: b.time, year: b.year, side: b.side, k1: b.k1, k2: b.k2, gapPips: b.gapPips, dist: D, triggered: false, favPips: NaN, advPips: NaN, favAtr: NaN, advAtr: NaN, turn25: false, turn50: false, turn100: false, reclaim: false, spreadPips: b.spreadPips }); continue; }
    const resEnd = Math.min(entryBar + HORIZON, n - 1); let maxFav = 0, maxAdv = 0, reclaim = false;
    for (let j = entryBar; j <= resEnd; j++) { const c = raw[j]!.mid;
      const fav = b.side === "resistance" ? entry - c.low : c.high - entry; // toward S/R
      const adv = b.side === "resistance" ? c.high - entry : entry - c.low; // continuation
      if (fav > maxFav) maxFav = fav; if (adv > maxAdv) maxAdv = adv;
      if (!reclaim) { const rec = b.side === "resistance" ? c.close <= b.L1 + w : c.close >= b.L1 - w; if (rec) reclaim = true; }
    }
    evs.push({ time: b.time, year: b.year, side: b.side, k1: b.k1, k2: b.k2, gapPips: b.gapPips, dist: D, triggered: true, favPips: maxFav / PIP, advPips: maxAdv / PIP, favAtr: maxFav / b.atr, advAtr: maxAdv / b.atr, turn25: maxFav >= 0.25 * b.atr, turn50: maxFav >= 0.5 * b.atr, turn100: maxFav >= 1.0 * b.atr, reclaim, spreadPips: b.spreadPips });
  }
}

// stats
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-"); const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const q = (a: number[], p: number) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const med = (a: number[]) => q(a, 0.5); const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const sides: Side[] = ["support", "resistance"];
const brkBySide: Record<Side, number> = { support: breaks.filter((b) => b.side === "support").length, resistance: breaks.filter((b) => b.side === "resistance").length };
const fid = (globalThis as any).__fid;

function row(list: Ev[], nb: number, label: string) {
  const trig = list.filter((e) => e.triggered); const adv = trig.map((e) => e.advPips), fav = trig.map((e) => e.favPips), advA = trig.map((e) => e.advAtr), favA = trig.map((e) => e.favAtr);
  return [label, `${trig.length}`, f1(pct(trig.length, nb)), f1(pct(trig.filter((e) => e.turn25).length, trig.length)), f1(pct(trig.filter((e) => e.turn50).length, trig.length)), f1(pct(trig.filter((e) => e.turn100).length, trig.length)), f1(pct(trig.filter((e) => e.reclaim).length, trig.length)), f2(med(adv)), f2(q(adv, .75)), f2(q(adv, .9)), f2(med(fav)), f2(q(fav, .75)), f2(q(fav, .9)), f2(med(advA)), f2(med(favA))];
}
const HEAD = ["Dist", "Entries", "EntryR%", "Turn.25", "Turn.50", "Turn1.0", "RclR1%", "MedAdv", "p75Adv", "p90Adv", "MedFav", "p75Fav", "p90Fav", "MedAdvA", "MedFavA"];

const L: string[] = []; const first = raw[startT]?.time, last = raw[n - 1]?.time; const years = (new Date(last!).getTime() - new Date(first!).getTime()) / (365.25 * 864e5);
L.push("EUR/USD 15M — S/R CONDITIONAL ENTRY BEHAVIOUR (V6, research-only, FROZEN)");
L.push(`Data: OANDA M15 MID+BID+ASK, ${n} bars, ${first} -> ${last} (~${f2(years)}y).`);
L.push(`S/R + detection + R1/R2 freeze UNCHANGED from V5. FIDELITY: support ${f2(fid.vS)}%  resistance ${f2(fid.vR)}%  (V5 81.37/81.56) -> PASS.`);
L.push(`Breaks (valid next level): support ${brkBySide.support}, resistance ${brkBySide.resistance}. Entry distance measured from LEVEL LINE L1. CONDITIONAL: metrics computed FROM the entry bar over ${HORIZON} bars.`);
L.push(`Turn.25/.50/1.0 = max favorable (toward S/R) move >= 0.25/0.50/1.00 ATR from entry. RclR1 = MID close back inside S/R#1 zone. Adv = continuation (against trade); Fav = toward S/R. pips + ATR. MID behaviour.`);
L.push("");

// main comparison per side
for (const side of sides) {
  const nb = brkBySide[side];
  L.push("#".repeat(130)); L.push(`${side.toUpperCase()} -> ${side === "support" ? "LONG" : "SHORT"}  (breaks ${nb})  — GIVEN price reached D beyond S/R#1, what happens next`); L.push("#".repeat(130));
  L.push(HEAD.map((s) => s.padStart(9)).join(""));
  for (const D of DISTANCES) L.push(row(evs.filter((e) => e.side === side && e.dist === D), nb, `${D}p`).map((s) => s.padStart(9)).join(""));
  L.push("");
}

// gap-size breakdown: Turn.50 and MedAdv by distance x gap (combined sides)
const GAPB: Array<[string, (g: number) => boolean]> = [["0-5", (g) => g <= 5], ["5-10", (g) => g > 5 && g <= 10], ["10-15", (g) => g > 10 && g <= 15], ["15-20", (g) => g > 15 && g <= 20], ["20-30", (g) => g > 20 && g <= 30], ["30+", (g) => g > 30]];
L.push("=".repeat(130)); L.push("GAP-SIZE breakdown (combined) — Turn.50ATR reversal rate % by entry distance"); L.push("=".repeat(130));
L.push(["Gap\\Dist", ...DISTANCES.map((d) => `${d}p`)].map((s) => s.padStart(8)).join(""));
for (const [name, test] of GAPB) L.push([name, ...DISTANCES.map((D) => { const t = evs.filter((e) => e.dist === D && e.triggered && test(e.gapPips)); return f1(pct(t.filter((e) => e.turn50).length, t.length)); })].map((s) => s.padStart(8)).join(""));
L.push("");
L.push("GAP-SIZE breakdown (combined) — MEDIAN adverse continuation (pips) by entry distance"); L.push("=".repeat(130));
L.push(["Gap\\Dist", ...DISTANCES.map((d) => `${d}p`)].map((s) => s.padStart(8)).join(""));
for (const [name, test] of GAPB) L.push([name, ...DISTANCES.map((D) => { const t = evs.filter((e) => e.dist === D && e.triggered && test(e.gapPips)); return f2(med(t.map((e) => e.advPips))); })].map((s) => s.padStart(8)).join(""));
L.push("");
L.push("GAP-SIZE breakdown (combined) — ENTRY RATE % by entry distance (how often price even reaches D)"); L.push("=".repeat(130));
L.push(["Gap\\Dist", ...DISTANCES.map((d) => `${d}p`)].map((s) => s.padStart(8)).join(""));
for (const [name, test] of GAPB) { const base = breaks.filter((b) => test(b.gapPips)).length; L.push([name, ...DISTANCES.map((D) => { const t = evs.filter((e) => e.dist === D && e.triggered && test(e.gapPips)); return f1(pct(t.length, base)); })].map((s) => s.padStart(8)).join("")); }
L.push("");

// S/R type breakdown (full metric rows at each distance)
for (const [a, bk] of [["range", "swing"], ["swing", "range"]] as Array<[Kind, Kind]>) {
  const nb = breaks.filter((b) => b.k1 === a && b.k2 === bk).length;
  L.push("=".repeat(130)); L.push(`S/R TYPE ${a}->${bk} (breaks ${nb}, combined sides)`); L.push("=".repeat(130));
  L.push(HEAD.map((s) => s.padStart(9)).join(""));
  for (const D of DISTANCES) L.push(row(evs.filter((e) => e.dist === D && e.k1 === a && e.k2 === bk), nb, `${D}p`).map((s) => s.padStart(9)).join(""));
  L.push("");
}

// support vs resistance similarity at 2.5p
{ const s = pct(evs.filter((e) => e.side === "support" && e.dist === 2.5 && e.triggered && e.turn50).length, evs.filter((e) => e.side === "support" && e.dist === 2.5 && e.triggered).length);
  const r = pct(evs.filter((e) => e.side === "resistance" && e.dist === 2.5 && e.triggered && e.turn50).length, evs.filter((e) => e.side === "resistance" && e.dist === 2.5 && e.triggered).length);
  L.push(`SUPPORT vs RESISTANCE Turn.50 rate at 2.5p: support ${f1(s)}%  resistance ${f1(r)}%  -> ${Math.abs(s - r) <= 3 ? "similar" : "differ"}.`); L.push(""); }

const report = L.join("\n");
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-conditional-report.txt"), report + "\n");
console.log(report.split("\n").slice(0, 5).join("\n"));

const csv: string[] = [];
csv.push(["timestamp", "side", "sr1_type", "sr2_type", "gap_pips", "entry_distance_pips", "entry_triggered", "favorable_pips", "adverse_pips", "favorable_atr", "adverse_atr", "turn_025atr", "turn_050atr", "turn_100atr", "reclaim_r1", "spread_pips"].join(","));
for (const e of evs) csv.push([e.time, e.side, e.k1, e.k2, e.gapPips.toFixed(2), e.dist, e.triggered ? "yes" : "no", e.triggered ? e.favPips.toFixed(2) : "", e.triggered ? e.advPips.toFixed(2) : "", e.triggered ? e.favAtr.toFixed(3) : "", e.triggered ? e.advAtr.toFixed(3) : "", e.triggered ? (e.turn25 ? "yes" : "no") : "", e.triggered ? (e.turn50 ? "yes" : "no") : "", e.triggered ? (e.turn100 ? "yes" : "no") : "", e.triggered ? (e.reclaim ? "yes" : "no") : "", e.spreadPips.toFixed(2)].join(","));
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-conditional-events.csv"), csv.join("\n") + "\n");
console.error(`[written] eurusd-15m-sr-conditional-report.txt | eurusd-15m-sr-conditional-events.csv (${evs.length} rows)`);

/**
 * EUR/USD 15M — S/R REVERSAL MAP (V5, research-only, PRICE-BEHAVIOR study, FROZEN).
 *
 * Pure behaviour study: after S/R#1 breaks toward S/R#2, HOW DEEP into the gap does
 * price travel before a meaningful reversal? No trades, no TP/SL, no RR, no filters.
 *
 * S/R + entry detection + R1/R2 freezing: reused VERBATIM from V4 (=V1-V3):
 *   computeSupportResistanceLevels (via assessMarketCondition), NEAR_* detection,
 *   touchAtr zones, arm/disarm de-dup, WINDOW=220, HORIZON=96, OANDA M15 MID+BID+ASK.
 *   R2/S2 = the OTHER exposed level ({range,swing}) beyond R1/S1; only range->swing
 *   and swing->range pairs can exist. NO_NEXT_SR when none.
 *
 * TURN DEPTH (center-to-center, per the V5 example): gap = |L2 - L1|.
 *   resistance excursion = maxHigh - L1 ; support excursion = L1 - minLow.
 *   turnDepth% = excursion / gap * 100  (raw, unrounded). >100% = exceeded R2.
 *   Measured on MID (price behaviour). bid/ask used only to log spread at the break.
 *
 * FIVE reversal confirmations, tracked INDEPENDENTLY (never mixed) — purpose is to
 * see if the turning depth is stable across reasonable definitions:
 *   A = 1 M15 close back toward R1 (a lower close for resistance / higher for support)
 *   B = 2 consecutive closes back toward R1
 *   C = price pulls back 0.25*ATR from its max excursion
 *   D = price pulls back 0.50*ATR from its max excursion
 *   E = price pulls back 1.00*ATR from its max excursion
 * Turn depth = the MAX excursion reached up to the confirming bar.
 * No look-ahead: levels frozen at/<=t0; behaviour scanned t0..t0+HORIZON.
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle, MajorInstrument } from "../src/types/forex";
import { assessMarketCondition } from "../src/lib/strategy/market-condition";
import { atr14Of } from "../src/lib/strategy/sr-structure";
import { PRICE_REACTION_THRESHOLDS as PR } from "../src/lib/strategy/price-reaction";
import { pipSizeFor } from "../src/lib/instruments/catalog";

const INSTRUMENT: MajorInstrument = "EUR_USD";
const TIMEFRAME = "M15";
const CACHE = "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m15-mba-cache.json";
const OUT_DIR = "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad";

const WINDOW = 220, HORIZON = 96, PIP = pipSizeFor(INSTRUMENT);
const TOUCH_ATR = PR.touchAtr, MIN_PEN_ATR = PR.minPenetrationAtr, ACCEPT_MIN_BARS = PR.acceptMinBars, ACCEPT_MIN_DIST_ATR = PR.acceptMinDistanceAtr;

type Side = "support" | "resistance"; type Kind = "range" | "swing";
type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };

const raw: RC[] = JSON.parse(fs.readFileSync(CACHE, "utf8"));
const n = raw.length;
const mids: Candle[] = raw.map((c) => ({ time: c.time, open: c.mid.open, high: c.mid.high, low: c.mid.low, close: c.mid.close, volume: 0, complete: true }));

interface Brk { t0: number; time: string; year: number; side: Side; atr: number; L1: number; k1: Kind; L2: number; k2: Kind; gapPips: number; gapAtr: number; spreadPips: number; }

// ---------- encounter detection + R2/S2 freeze: verbatim from V4 ----------
const breaks: Brk[] = []; let noNext: Record<Side, number> = { support: 0, resistance: 0 };
let armedR = true, armedS = true; const startT = WINDOW;
for (let t = startT; t < n; t++) {
  const window = mids.slice(t - WINDOW + 1, t + 1);
  const a = assessMarketCondition({ candles: window, instrument: INSTRUMENT, timeframe: TIMEFRAME });
  const lv = a.levels; if (!lv) continue; const loc = a.location; const cur = lv.current; const A = atr14Of(window); if (!(A > 0)) continue;
  const nearR = loc === "NEAR_RESISTANCE", nearS = loc === "NEAR_SUPPORT";
  if (nearR && armedR) {
    const cand = [lv.rangeHigh, lv.swingHigh].filter((x): x is number => x !== null && x >= cur);
    if (cand.length) {
      const L1 = cand.reduce((p, q) => (q - cur < p - cur ? q : p)); const k1: Kind = L1 === lv.rangeHigh ? "range" : "swing";
      const other = k1 === "range" ? lv.swingHigh : lv.rangeHigh; const k2: Kind = k1 === "range" ? "swing" : "range";
      if (other !== null && other > L1) breaks.push({ t0: t, time: raw[t]!.time, year: new Date(raw[t]!.time).getUTCFullYear(), side: "resistance", atr: A, L1, k1, L2: other, k2, gapPips: (other - L1) / PIP, gapAtr: (other - L1) / A, spreadPips: (raw[t]!.ask.close - raw[t]!.bid.close) / PIP });
      else noNext.resistance++;
      armedR = false;
    }
  } else if (!nearR) armedR = true;
  if (nearS && armedS) {
    const cand = [lv.rangeLow, lv.swingLow].filter((x): x is number => x !== null && x <= cur);
    if (cand.length) {
      const L1 = cand.reduce((p, q) => (cur - q < cur - p ? q : p)); const k1: Kind = L1 === lv.rangeLow ? "range" : "swing";
      const other = k1 === "range" ? lv.swingLow : lv.rangeLow; const k2: Kind = k1 === "range" ? "swing" : "range";
      if (other !== null && other < L1) breaks.push({ t0: t, time: raw[t]!.time, year: new Date(raw[t]!.time).getUTCFullYear(), side: "support", atr: A, L1, k1, L2: other, k2, gapPips: (L1 - other) / PIP, gapAtr: (L1 - other) / A, spreadPips: (raw[t]!.ask.close - raw[t]!.bid.close) / PIP });
      else noNext.support++;
      armedS = false;
    }
  } else if (!nearS) armedS = true;
}

// ---------- fidelity check (must reproduce ~81.37 / 81.56) ----------
const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
{
  const allEnc: Array<{ t0: number; side: Side; L: number; atr: number }> = [];
  let aR = true, aS = true;
  for (let t = startT; t < n; t++) {
    const window = mids.slice(t - WINDOW + 1, t + 1); const a = assessMarketCondition({ candles: window, instrument: INSTRUMENT, timeframe: TIMEFRAME }); const lv = a.levels; if (!lv) continue; const loc = a.location; const cur = lv.current; const A = atr14Of(window); if (!(A > 0)) continue;
    const nearR = loc === "NEAR_RESISTANCE", nearS = loc === "NEAR_SUPPORT";
    if (nearR && aR) { const c = [lv.rangeHigh, lv.swingHigh].filter((x): x is number => x !== null && x >= cur); if (c.length) { allEnc.push({ t0: t, side: "resistance", L: c.reduce((p, q) => (q - cur < p - cur ? q : p)), atr: A }); aR = false; } } else if (!nearR) aR = true;
    if (nearS && aS) { const c = [lv.rangeLow, lv.swingLow].filter((x): x is number => x !== null && x <= cur); if (c.length) { allEnc.push({ t0: t, side: "support", L: c.reduce((p, q) => (cur - q < cur - p ? q : p)), atr: A }); aS = false; } } else if (!nearS) aS = true;
  }
  const v: Record<Side, { s: number; t: number }> = { support: { s: 0, t: 0 }, resistance: { s: 0, t: 0 } };
  for (const e of allEnc) { const w = TOUCH_ATR * e.atr, top = e.L + w, bot = e.L - w; let bb = 0, adv = e.side === "resistance" ? -Infinity : Infinity, done = false, ok = false; const end = Math.min(e.t0 + HORIZON, n - 1); for (let j = e.t0; j <= end && !done; j++) { const c = raw[j]!.mid; adv = e.side === "resistance" ? Math.max(adv, c.high) : Math.min(adv, c.low); const bc = e.side === "resistance" ? c.close - e.L : e.L - c.close; if (bc > w) bb++; else bb = 0; const acc = bb >= ACCEPT_MIN_BARS && bc / e.atr >= ACCEPT_MIN_DIST_ATR; const pen = (e.side === "resistance" ? adv - e.L : e.L - adv) >= MIN_PEN_ATR * e.atr; const ins = e.side === "resistance" ? c.close <= top : c.close >= bot; if (acc) done = true; else if (pen && ins) { ok = true; done = true; } } v[e.side].t++; if (ok) v[e.side].s++; }
  const vS = pct(v.support.s, v.support.t), vR = pct(v.resistance.s, v.resistance.t);
  if (!(vS >= 78 && vS <= 84 && vR >= 78 && vR <= 84)) { console.error(`FIDELITY FAILED ${vS.toFixed(2)}/${vR.toFixed(2)}. STOP.`); process.exit(1); }
  (globalThis as any).__fid = { vS, vR };
}

// ---------- V5 measurement: per break, per definition ----------
const DEFS = ["A", "B", "C", "D", "E"] as const; type Def = typeof DEFS[number];
const ATRPULL: Record<Def, number> = { A: 0, B: 0, C: 0.25, D: 0.5, E: 1.0 };
interface Rev { time: string; year: number; side: Side; k1: Kind; k2: Kind; L1: number; L2: number; gapPips: number; gapAtr: number; def: Def; confirmed: boolean; reachedR2: boolean; exceededR2: boolean; noRev: boolean; turnPct: number; excPips: number; excPrice: number; excAtr: number; tTurn: number | null; r25: boolean; r50: boolean; r75: boolean; spreadPips: number; }
const revs: Rev[] = [];

for (const b of breaks) {
  const gap = Math.abs(b.L2 - b.L1);
  for (const def of DEFS) {
    let peakExc = 0, peakPrice = b.L1, prevClose = raw[b.t0]!.mid.close, toward = 0, confirmed = false, tTurn: number | null = null, reachedR2 = false;
    const end = Math.min(b.t0 + HORIZON, n - 1);
    for (let j = b.t0; j <= end; j++) {
      const c = raw[j]!.mid;
      const excNow = b.side === "resistance" ? c.high - b.L1 : b.L1 - c.low;
      if (excNow > peakExc) { peakExc = excNow; peakPrice = b.side === "resistance" ? c.high : c.low; }
      if (peakExc >= gap) reachedR2 = true;
      if (peakExc > 0) {
        if (def === "A" || def === "B") {
          if (j > b.t0) { const tw = b.side === "resistance" ? c.close < prevClose : c.close > prevClose; toward = tw ? toward + 1 : 0; const need = def === "A" ? 1 : 2; if (toward >= need) { confirmed = true; tTurn = j - b.t0; } }
        } else {
          const pull = b.side === "resistance" ? peakPrice - c.low : c.high - peakPrice; // pullback from max excursion
          if (pull >= ATRPULL[def] * b.atr) { confirmed = true; tTurn = j - b.t0; }
        }
      }
      prevClose = c.close;
      if (confirmed) break;
    }
    const turnPct = gap > 0 ? (peakExc / gap) * 100 : NaN;
    revs.push({ time: b.time, year: b.year, side: b.side, k1: b.k1, k2: b.k2, L1: b.L1, L2: b.L2, gapPips: b.gapPips, gapAtr: b.gapAtr, def, confirmed, reachedR2, exceededR2: peakExc > gap, noRev: !confirmed, turnPct, excPips: peakExc / PIP, excPrice: peakPrice, excAtr: peakExc / b.atr, tTurn, r25: turnPct >= 25, r50: turnPct >= 50, r75: turnPct >= 75, spreadPips: b.spreadPips });
  }
}

// ---------- stats helpers ----------
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const q = (a: number[], p: number) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const i = Math.min(s.length - 1, Math.floor(p * s.length)); return s[i]!; };
const median = (a: number[]) => q(a, 0.5);

const sides: Side[] = ["support", "resistance"];
const brkBySide: Record<Side, number> = { support: breaks.filter((b) => b.side === "support").length, resistance: breaks.filter((b) => b.side === "resistance").length };
const L: string[] = [];
const first = raw[startT]?.time, last = raw[n - 1]?.time;
const years = (new Date(last!).getTime() - new Date(first!).getTime()) / (365.25 * 864e5);
const fid = (globalThis as any).__fid;
L.push("EUR/USD 15M — S/R REVERSAL MAP (V5, research-only, PRICE-BEHAVIOR, FROZEN)");
L.push(`Data: OANDA M15 MID+BID+ASK, ${n} bars, ${first} -> ${last} (~${f2(years)}y).`);
L.push(`S/R + detection + R1/R2 freeze UNCHANGED from V4. FIDELITY: support ${f2(fid.vS)}%  resistance ${f2(fid.vR)}%  (V4 81.37/81.56) -> PASS.`);
L.push(`Breaks with a valid next level: support ${brkBySide.support}, resistance ${brkBySide.resistance} | NO_NEXT_SR support ${noNext.support}, resistance ${noNext.resistance}.`);
L.push(`Turn depth = excursion(from L1 toward L2) / |L2-L1| * 100 (center-to-center, raw). Reversal defs A/B=close-count, C/D/E=0.25/0.50/1.00 ATR pullback from max excursion. MID for behaviour.`);
L.push("");

// ---------- distribution + category counts, per side per definition ----------
for (const side of sides) {
  const nb = brkBySide[side];
  L.push("#".repeat(120));
  L.push(`${side.toUpperCase()} — turning-depth distribution (breaks ${nb})`);
  L.push("#".repeat(120));
  L.push(["Def", "Confirmed", "Conf%", "ReachR2", "ExceedR2", "NoRev", "avg", "p25", "p50(med)", "p60", "p70", "p75", "p80", "p90", "p95"].map((s) => s.padStart(10)).join(""));
  for (const def of DEFS) {
    const list = revs.filter((r) => r.side === side && r.def === def);
    const conf = list.filter((r) => r.confirmed);
    const td = conf.map((r) => r.turnPct);
    L.push([`${def}`, `${conf.length}`, f1(pct(conf.length, nb)), `${list.filter((r) => r.reachedR2).length}`, `${list.filter((r) => r.exceededR2).length}`, `${list.filter((r) => r.noRev).length}`, f1(mean(td)), f1(q(td, .25)), f1(q(td, .5)), f1(q(td, .6)), f1(q(td, .7)), f1(q(td, .75)), f1(q(td, .8)), f1(q(td, .9)), f1(q(td, .95))].map((s) => s.padStart(10)).join(""));
  }
  L.push("");
}

// ---------- buckets (per definition, combined side-by-side for C and D as representatives; all defs for combined) ----------
const BUCKETS: Array<[string, (x: number) => boolean]> = [
  ["0-10", (x) => x < 10], ["10-20", (x) => x >= 10 && x < 20], ["20-25", (x) => x >= 20 && x < 25], ["25-30", (x) => x >= 25 && x < 30],
  ["30-40", (x) => x >= 30 && x < 40], ["40-50", (x) => x >= 40 && x < 50], ["50-60", (x) => x >= 50 && x < 60], ["60-70", (x) => x >= 60 && x < 70],
  ["70-75", (x) => x >= 70 && x < 75], ["75-80", (x) => x >= 75 && x < 80], ["80-90", (x) => x >= 80 && x < 90], ["90-100", (x) => x >= 90 && x < 100], ["100+", (x) => x >= 100],
];
for (const def of DEFS) {
  L.push("=".repeat(120));
  L.push(`TURN-DEPTH BUCKETS — reversal def ${def}${def === "C" ? " (0.25 ATR)" : def === "D" ? " (0.50 ATR)" : def === "E" ? " (1.00 ATR)" : def === "A" ? " (1 close)" : " (2 closes)"} — combined support+resistance confirmed reversals`);
  L.push("=".repeat(120));
  const conf = revs.filter((r) => r.def === def && r.confirmed);
  L.push(["Bucket", "Events", "%ofRev", "Cum%", "MedPipPen", "MedAtrPen"].map((s) => s.padStart(12)).join(""));
  let cum = 0;
  for (const [name, test] of BUCKETS) {
    const inb = conf.filter((r) => test(r.turnPct)); cum += inb.length;
    L.push([name, `${inb.length}`, f1(pct(inb.length, conf.length)), f1(pct(cum, conf.length)), f1(median(inb.map((r) => r.excPips))), f2(median(inb.map((r) => r.excAtr)))].map((s) => s.padStart(12)).join(""));
  }
  L.push("");
}

// ---------- KEY QUESTION: 25/50/75/100 — what you sacrifice by waiting (per definition, combined) ----------
L.push("=".repeat(120));
L.push("KEY QUESTION — of setups that CONFIRM a reversal, share that reached each depth before turning (combined; per definition)");
L.push("=".repeat(120));
L.push(["Def", "rev<25%", "reach25%", "rev25-50", "reach50%", "rev50-75", "reach75%", "reachR2(100)"].map((s) => s.padStart(13)).join(""));
for (const def of DEFS) {
  const conf = revs.filter((r) => r.def === def && r.confirmed); const tot = conf.length;
  const before25 = conf.filter((r) => r.turnPct < 25).length, reach25 = conf.filter((r) => r.turnPct >= 25).length;
  const b2550 = conf.filter((r) => r.turnPct >= 25 && r.turnPct < 50).length, reach50 = conf.filter((r) => r.turnPct >= 50).length;
  const b5075 = conf.filter((r) => r.turnPct >= 50 && r.turnPct < 75).length, reach75 = conf.filter((r) => r.turnPct >= 75).length;
  const reach100 = conf.filter((r) => r.turnPct >= 100).length;
  L.push([`${def}`, f1(pct(before25, tot)), f1(pct(reach25, tot)), f1(pct(b2550, tot)), f1(pct(reach50, tot)), f1(pct(b5075, tot)), f1(pct(reach75, tot)), f1(pct(reach100, tot))].map((s) => s.padStart(13)).join(""));
}
L.push("Read: 'reach25%' = of confirmed reversals, % whose max excursion reached >=25% of the gap (i.e. a 25% entry would have been filled before the turn). 'rev<25%' = would have reversed before a 25% entry.");
L.push("");

// ---------- GAP-SIZE breakdown (does a wider gap => larger % traveled?) ----------
const GAPB: Array<[string, (g: number) => boolean]> = [["0-5", (g) => g <= 5], ["5-10", (g) => g > 5 && g <= 10], ["10-15", (g) => g > 10 && g <= 15], ["15-20", (g) => g > 15 && g <= 20], ["20-30", (g) => g > 20 && g <= 30], ["30+", (g) => g > 30]];
for (const def of ["C", "D"] as Def[]) {
  L.push("=".repeat(120));
  L.push(`GAP-SIZE breakdown — reversal def ${def} (combined). Does a wider gap => larger % of gap traveled before the turn?`);
  L.push("=".repeat(120));
  L.push(["GapBucket", "Confirmed", "%ofAll", "medDepth%", "p75Depth%", "p90Depth%", "medPipPen", "reach25%", "reach50%", "reach75%", "reachR2%"].map((s) => s.padStart(11)).join(""));
  const confAll = revs.filter((r) => r.def === def && r.confirmed);
  for (const [name, test] of GAPB) {
    const c = confAll.filter((r) => test(r.gapPips)); const td = c.map((r) => r.turnPct);
    L.push([name, `${c.length}`, f1(pct(c.length, confAll.length)), f1(median(td)), f1(q(td, .75)), f1(q(td, .9)), f1(median(c.map((r) => r.excPips))), f1(pct(c.filter((r) => r.r25).length, c.length)), f1(pct(c.filter((r) => r.r50).length, c.length)), f1(pct(c.filter((r) => r.r75).length, c.length)), f1(pct(c.filter((r) => r.reachedR2).length, c.length))].map((s) => s.padStart(11)).join(""));
  }
  L.push("");
}

// ---------- S/R TYPE breakdown ----------
L.push("=".repeat(120));
L.push("S/R TYPE breakdown (def C, 0.25 ATR) — keep range->swing separate from swing->range");
L.push("=".repeat(120));
L.push(["combo", "Confirmed", "medDepth%", "p75Depth%", "p90Depth%", "reach25%", "reach50%", "reach75%", "reachR2%"].map((s) => s.padStart(12)).join(""));
for (const [a, bk] of [["range", "swing"], ["swing", "range"]] as Array<[Kind, Kind]>) {
  const c = revs.filter((r) => r.def === "C" && r.confirmed && r.k1 === a && r.k2 === bk); const td = c.map((r) => r.turnPct);
  L.push([`${a}->${bk}`, `${c.length}`, f1(median(td)), f1(q(td, .75)), f1(q(td, .9)), f1(pct(c.filter((r) => r.r25).length, c.length)), f1(pct(c.filter((r) => r.r50).length, c.length)), f1(pct(c.filter((r) => r.r75).length, c.length)), f1(pct(c.filter((r) => r.reachedR2).length, c.length))].map((s) => s.padStart(12)).join(""));
}
L.push("");

// ---------- support vs resistance similarity (def C median depth) ----------
{
  const s = median(revs.filter((r) => r.side === "support" && r.def === "C" && r.confirmed).map((r) => r.turnPct));
  const rr = median(revs.filter((r) => r.side === "resistance" && r.def === "C" && r.confirmed).map((r) => r.turnPct));
  L.push(`SUPPORT vs RESISTANCE median turn depth (def C): support ${f1(s)}%  resistance ${f1(rr)}%  -> ${Math.abs(s - rr) <= 3 ? "similar (combine OK)" : "differ"}.`);
  L.push("");
}

const report = L.join("\n");
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-reversal-map-report.txt"), report + "\n");
console.log(report.split("\n").slice(0, 6).join("\n"));

// ---------- event CSV (one row per break x definition) ----------
const csv: string[] = [];
csv.push(["timestamp", "side", "sr1_price", "sr1_type", "sr2_price", "sr2_type", "gap_pips", "gap_atr", "max_excursion_price", "max_excursion_pips", "turn_depth_pct", "reversal_definition", "reversal_confirmed", "time_to_turn_bars", "reached_25", "reached_50", "reached_75", "reached_r2", "exceeded_r2", "spread_pips"].join(","));
for (const r of revs) csv.push([r.time, r.side, r.L1.toFixed(5), r.k1, r.L2.toFixed(5), r.k2, r.gapPips.toFixed(2), r.gapAtr.toFixed(3), r.excPrice.toFixed(5), r.excPips.toFixed(2), Number.isFinite(r.turnPct) ? r.turnPct.toFixed(2) : "", r.def, r.confirmed ? "yes" : "no", r.tTurn ?? "", r.r25 ? "yes" : "no", r.r50 ? "yes" : "no", r.r75 ? "yes" : "no", r.reachedR2 ? "yes" : "no", r.exceededR2 ? "yes" : "no", r.spreadPips.toFixed(2)].join(","));
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-reversal-map-events.csv"), csv.join("\n") + "\n");
console.error(`[written] eurusd-15m-sr-reversal-map-report.txt | eurusd-15m-sr-reversal-map-events.csv (${revs.length} rows)`);

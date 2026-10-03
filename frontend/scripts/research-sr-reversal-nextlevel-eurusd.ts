/**
 * EUR/USD 15M — S/R NEXT-LEVEL % ENTRY TEST (V4, research-only, NO trading, FROZEN).
 *
 * Question: should entry location be a PERCENTAGE of the distance from the current
 * S/R (R1/S1) to the NEXT S/R (R2/S2), instead of a fixed pip offset (V2/V3)?
 *
 * S/R + entry detection UNCHANGED from V1/V2/V3 (verbatim): computeSupportResistanceLevels
 * (via assessMarketCondition), NEAR_* detection, touchAtr zones, frozen levels,
 * arm/disarm de-dup, WINDOW=220, HORIZON=96, OANDA M15 MID+BID+ASK, chronological
 * no-lookahead entry (scan t0+1..), LONG entry@ASK exit@BID, SHORT entry@BID exit@ASK.
 *
 * NEXT LEVEL (indicator-faithful): the project only ever exposes TWO resistance
 * levels {rangeHigh, swingHigh} and TWO support levels {rangeLow, swingLow}. R1/S1
 * is the nearer one (exactly the level V1-V3 detect). R2/S2 = the OTHER frozen
 * candidate, iff it lies strictly beyond R1/S1. No extra swings are invented. Hence
 * only range->swing and swing->range pairs can exist; range->range / swing->swing
 * are structurally impossible and are reported as such (not forced).
 *   If no second level beyond R1/S1 exists at freeze time -> NO_NEXT_SR (excluded
 *   from the % test, frequency reported).
 *
 * GAP / BOUNDARIES (S/R is an AREA, so measure edge-to-open-space-to-edge):
 *   Resistance: gap start = R1 outer/top (R1 + w);  gap end = R2 near/bottom (R2 - w).
 *   Support   : gap start = S1 outer/bottom (S1 - w); gap end = S2 near/top   (S2 + w).
 *   w = touchAtr*ATR (one frozen ATR per snapshot).  0% = start (== V3's 0-pip edge),
 *   100% = end (the far zone's near edge).  entry(f) = start + f*(end-start).
 *   If the boundary gap <= 0 (zones overlap) the pair is recorded but EXCLUDED from
 *   the % test (frequency reported as NEG/OVERLAP gap). Center gap (R2-R1) also logged.
 *
 * Two tests per % entry: (1) forward price behaviour (reclaim R1 vs reach R2 vs
 * neither, MFE/MAE, times); (2) fixed 1:1 RR (5/8/10/12/15) with V3 execution.
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

const PERCENTS = [0, 10, 25, 50, 75, 100];
const RR_SIZES = [5, 8, 10, 12, 15];
const GAP_BUCKETS: Array<[string, (g: number) => boolean]> = [
  ["0-5", (g) => g > 0 && g <= 5], ["5-10", (g) => g > 5 && g <= 10], ["10-15", (g) => g > 10 && g <= 15],
  ["15-20", (g) => g > 15 && g <= 20], ["20-30", (g) => g > 20 && g <= 30], ["30+", (g) => g > 30],
];

type Side = "support" | "resistance";
type Kind = "range" | "swing";
type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };

const raw: RC[] = JSON.parse(fs.readFileSync(CACHE, "utf8"));
const n = raw.length;
const mids: Candle[] = raw.map((c) => ({ time: c.time, open: c.mid.open, high: c.mid.high, low: c.mid.low, close: c.mid.close, volume: 0, complete: true }));

interface Encounter {
  t0: number; time: string; year: number; side: Side; atr: number;
  L1: number; k1: Kind; L2: number | null; k2: Kind | null; // R1/S1, R2/S2 (frozen)
  edge1: number; // outer edge of L1 (== gap start)
  hasNext: boolean; gapCenterPips: number; gapBoundPips: number; gapAtr: number; start: number; end: number;
}

// ---------- encounter detection: verbatim from V1/V2/V3, + freeze R2/S2 from same snapshot ----------
const encounters: Encounter[] = [];
let armedR = true, armedS = true; const startT = WINDOW;
for (let t = startT; t < n; t++) {
  const window = mids.slice(t - WINDOW + 1, t + 1);
  const assessment = assessMarketCondition({ candles: window, instrument: INSTRUMENT, timeframe: TIMEFRAME });
  const levels = assessment.levels; if (!levels) continue;
  const loc = assessment.location; const current = levels.current; const A = atr14Of(window); if (!(A > 0)) continue;
  const w = TOUCH_ATR * A;
  const nearR = loc === "NEAR_RESISTANCE", nearS = loc === "NEAR_SUPPORT";
  if (nearR && armedR) {
    const cand = [levels.rangeHigh, levels.swingHigh].filter((x): x is number => x !== null && x >= current);
    if (cand.length) {
      const L1 = cand.reduce((a, b) => (b - current < a - current ? b : a));
      const k1: Kind = L1 === levels.rangeHigh ? "range" : "swing";
      // R2 = the OTHER exposed resistance, iff strictly above R1
      const other = k1 === "range" ? levels.swingHigh : levels.rangeHigh;
      const otherKind: Kind = k1 === "range" ? "swing" : "range";
      const L2 = other !== null && other > L1 ? other : null; const k2 = L2 !== null ? otherKind : null;
      const edge1 = L1 + w; const start = edge1, end = L2 !== null ? L2 - w : NaN;
      encounters.push({ t0: t, time: raw[t]!.time, year: new Date(raw[t]!.time).getUTCFullYear(), side: "resistance", atr: A, L1, k1, L2, k2, edge1, hasNext: L2 !== null, gapCenterPips: L2 !== null ? (L2 - L1) / PIP : NaN, gapBoundPips: L2 !== null ? (end - start) / PIP : NaN, gapAtr: L2 !== null ? (L2 - L1) / A : NaN, start, end });
      armedR = false;
    }
  } else if (!nearR) armedR = true;
  if (nearS && armedS) {
    const cand = [levels.rangeLow, levels.swingLow].filter((x): x is number => x !== null && x <= current);
    if (cand.length) {
      const L1 = cand.reduce((a, b) => (current - b < current - a ? b : a));
      const k1: Kind = L1 === levels.rangeLow ? "range" : "swing";
      const other = k1 === "range" ? levels.swingLow : levels.rangeLow;
      const otherKind: Kind = k1 === "range" ? "swing" : "range";
      const L2 = other !== null && other < L1 ? other : null; const k2 = L2 !== null ? otherKind : null;
      const edge1 = L1 - w; const start = edge1, end = L2 !== null ? L2 + w : NaN;
      encounters.push({ t0: t, time: raw[t]!.time, year: new Date(raw[t]!.time).getUTCFullYear(), side: "support", atr: A, L1, k1, L2, k2, edge1, hasNext: L2 !== null, gapCenterPips: L2 !== null ? (L1 - L2) / PIP : NaN, gapBoundPips: L2 !== null ? (start - end) / PIP : NaN, gapAtr: L2 !== null ? (L1 - L2) / A : NaN, start, end });
      armedS = false;
    }
  } else if (!nearS) armedS = true;
}

// ---------- V1/V2/V3 fidelity check ----------
const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
const v1: Record<Side, { s: number; t: number }> = { support: { s: 0, t: 0 }, resistance: { s: 0, t: 0 } };
for (const e of encounters) {
  const w = TOUCH_ATR * e.atr, top = e.L1 + w, bot = e.L1 - w; let bb = 0, adv = e.side === "resistance" ? -Infinity : Infinity, done = false, ok = false;
  const end = Math.min(e.t0 + HORIZON, n - 1);
  for (let j = e.t0; j <= end && !done; j++) { const c = raw[j]!.mid; adv = e.side === "resistance" ? Math.max(adv, c.high) : Math.min(adv, c.low); const bc = e.side === "resistance" ? c.close - e.L1 : e.L1 - c.close; if (bc > w) bb++; else bb = 0; const acc = bb >= ACCEPT_MIN_BARS && bc / e.atr >= ACCEPT_MIN_DIST_ATR; const pen = (e.side === "resistance" ? adv - e.L1 : e.L1 - adv) >= MIN_PEN_ATR * e.atr; const ins = e.side === "resistance" ? c.close <= top : c.close >= bot; if (acc) done = true; else if (pen && ins) { ok = true; done = true; } }
  v1[e.side].t++; if (ok) v1[e.side].s++;
}
const v1S = pct(v1.support.s, v1.support.t), v1R = pct(v1.resistance.s, v1.resistance.t);
if (!(v1S >= 78 && v1S <= 84 && v1R >= 78 && v1R <= 84)) { console.error(`FIDELITY FAILED: ${v1S.toFixed(2)}/${v1R.toFixed(2)}. STOP.`); process.exit(1); }

// ---------- simulate: forward behaviour + fixed 1:1 RR, per (encounter, percentage) ----------
type Outcome = "win" | "loss" | "ambiguous" | "timeout";
interface Ev {
  time: string; year: number; side: Side; L1: number; k1: Kind; L2: number; k2: Kind; gapPips: number; gapAtr: number;
  pctLevel: number; intended: number; fill: number; spreadPips: number; triggered: boolean;
  reclaimR1: boolean; reachedR2: boolean; firstReclaim: boolean; mfe: number; mae: number; tRev: number | null; tR2: number | null;
  rr: Record<number, { outcome: Outcome; hold: number }>;
}
const evs: Ev[] = [];
const eligibleBySide: Record<Side, number> = { support: 0, resistance: 0 };
const noNext: Record<Side, number> = { support: 0, resistance: 0 };
const negGap: Record<Side, number> = { support: 0, resistance: 0 };

for (const e of encounters) {
  if (!e.hasNext) { noNext[e.side]++; continue; }
  if (!(e.gapBoundPips > 0)) { negGap[e.side]++; continue; } // zones overlap -> excluded from % test
  eligibleBySide[e.side]++;
  const w = TOUCH_ATR * e.atr, top1 = e.L1 + w, bot1 = e.L1 - w;
  const r2near = e.side === "resistance" ? e.L2! - w : e.L2! + w; // R2 near boundary (== 100% level)
  for (const P of PERCENTS) {
    const f = P / 100;
    const intended = e.start + f * (e.end - e.start);
    // entry trigger (no lookahead): resistance rises to intended (mid.high>=), support falls (mid.low<=)
    let entryBar = -1; const scanEnd = Math.min(e.t0 + HORIZON, n - 1);
    for (let j = e.t0 + 1; j <= scanEnd; j++) { const m = raw[j]!.mid; if (e.side === "resistance" ? m.high >= intended : m.low <= intended) { entryBar = j; break; } }
    const base: Ev = { time: e.time, year: e.year, side: e.side, L1: e.L1, k1: e.k1, L2: e.L2!, k2: e.k2!, gapPips: e.gapBoundPips, gapAtr: e.gapAtr, pctLevel: P, intended, fill: NaN, spreadPips: NaN, triggered: false, reclaimR1: false, reachedR2: false, firstReclaim: false, mfe: NaN, mae: NaN, tRev: null, tR2: null, rr: {} };
    if (entryBar < 0) { evs.push(base); continue; }
    const eb = raw[entryBar]!; const spread = eb.ask.close - eb.bid.close;
    const fill = e.side === "resistance" ? intended - (eb.mid.close - eb.bid.close) : intended + (eb.ask.close - eb.mid.close);
    base.triggered = true; base.fill = fill; base.spreadPips = spread / PIP;
    // ---- FIRST TEST: forward behaviour from entry over HORIZON ----
    const resEnd = Math.min(entryBar + HORIZON, n - 1);
    let bestFav = -Infinity, worstAdv = -Infinity, tRev: number | null = null, tR2: number | null = null;
    for (let j = entryBar; j <= resEnd; j++) {
      const c = raw[j]!;
      const favNow = e.side === "resistance" ? fill - c.ask.low : c.bid.high - fill;
      const advNow = e.side === "resistance" ? c.ask.high - fill : fill - c.bid.low;
      if (favNow > bestFav) bestFav = favNow; if (advNow > worstAdv) worstAdv = advNow;
      // reclaim R1: MID close back inside R1 zone (resistance: <= top1; support: >= bot1); require j>entry
      if (tRev === null && j > entryBar) { const rec = e.side === "resistance" ? c.mid.close <= top1 : c.mid.close >= bot1; if (rec) tRev = j - entryBar; }
      // reach R2 near boundary (resistance: high>=r2near; support: low<=r2near)
      if (tR2 === null) { const hit = e.side === "resistance" ? c.mid.high >= r2near : c.mid.low <= r2near; if (hit) tR2 = j - entryBar; }
    }
    base.reclaimR1 = tRev !== null; base.reachedR2 = tR2 !== null; base.tRev = tRev; base.tR2 = tR2;
    base.firstReclaim = tRev !== null && (tR2 === null || tRev <= tR2);
    base.mfe = bestFav / PIP; base.mae = worstAdv / PIP;
    // ---- SECOND TEST: fixed 1:1 RR from executable fill (V3 rules) ----
    for (const rr of RR_SIZES) {
      const tp = e.side === "resistance" ? fill - rr * PIP : fill + rr * PIP;
      const sl = e.side === "resistance" ? fill + rr * PIP : fill - rr * PIP;
      let outcome: Outcome = "timeout", hold = HORIZON;
      for (let j = entryBar + 1; j <= resEnd; j++) {
        const c = raw[j]!; let hitTP = false, hitSL = false;
        if (e.side === "resistance") { hitTP = c.ask.low <= tp; hitSL = c.ask.high >= sl; } else { hitTP = c.bid.high >= tp; hitSL = c.bid.low <= sl; }
        if (hitTP && hitSL) { outcome = "ambiguous"; hold = j - entryBar; break; }
        if (hitTP) { outcome = "win"; hold = j - entryBar; break; }
        if (hitSL) { outcome = "loss"; hold = j - entryBar; break; }
      }
      base.rr[rr] = { outcome, hold };
    }
    evs.push(base);
  }
}

// ---------- aggregation helpers ----------
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "-");
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

function rrStats(list: Ev[], rr: number, eligible: number) {
  const trig = list.filter((e) => e.triggered);
  const os = trig.map((e) => e.rr[rr]!.outcome);
  const wins = os.filter((o) => o === "win").length, losses = os.filter((o) => o === "loss").length, ambig = os.filter((o) => o === "ambiguous").length, tmout = os.filter((o) => o === "timeout").length;
  const resolved = wins + losses;
  return { entries: trig.length, wins, losses, ambig, tmout, resolved, wr: pct(wins, resolved), wrBest: pct(wins + ambig, resolved + ambig), wrWorst: pct(wins, resolved + ambig), expRes: resolved ? (wins - losses) / resolved : NaN, expAll: trig.length ? (wins - losses) / trig.length : NaN, netRper1k: eligible ? ((wins - losses) / eligible) * 1000 : NaN, winsPer1k: eligible ? (wins / eligible) * 1000 : NaN, avgSpread: mean(trig.map((e) => e.spreadPips)), medSpread: median(trig.map((e) => e.spreadPips)), avgHold: mean(trig.map((e) => e.rr[rr]!.hold)), medHold: median(trig.map((e) => e.rr[rr]!.hold)) };
}

const sides: Side[] = ["support", "resistance"];
const L: string[] = [];
const first = raw[startT]?.time, last = raw[n - 1]?.time;
const years = (new Date(last!).getTime() - new Date(first!).getTime()) / (365.25 * 864e5);
L.push("EUR/USD 15M — S/R NEXT-LEVEL % ENTRY TEST (V4, research-only, NO trading, FROZEN)");
L.push(`Data: OANDA M15 MID+BID+ASK, ${n} bars, ${first} -> ${last} (~${f2(years)}y).`);
L.push(`S/R + entry detection UNCHANGED from V1-V3. Total encounters: support ${encounters.filter((e) => e.side === "support").length}, resistance ${encounters.filter((e) => e.side === "resistance").length}.`);
L.push(`FIDELITY (project reclaim among ALL encounters from t0): support ${f2(v1S)}%  resistance ${f2(v1R)}%  (V1 81.06/81.08) -> PASS.`);
L.push(`Indicator exposes only {range,swing} per side -> R2/S2 is the OTHER frozen level beyond R1/S1. Only range->swing & swing->range pairs are structurally possible.`);
L.push(`Gap = boundary-to-boundary: resistance (R1+w)->(R2-w); support (S1-w)->(S2+w); w=touchAtr*ATR. 0%=near edge (==V3 0-pip), 100%=far zone near edge.`);
L.push(`Execution: LONG entry@ASK exit@BID; SHORT entry@BID exit@ASK. TP/SL fixed pips from EXECUTABLE ENTRY. Spread once. 96-bar hold after entry. Same-bar TP+SL=ambiguous.`);
for (const s of sides) L.push(`  ${s}: eligible (has next level & positive gap) ${eligibleBySide[s]} | NO_NEXT_SR ${noNext[s]} (${f2(pct(noNext[s], noNext[s] + eligibleBySide[s] + negGap[s]))}%) | overlap/neg-gap excluded ${negGap[s]} (${f2(pct(negGap[s], noNext[s] + eligibleBySide[s] + negGap[s]))}%)`);
L.push("");

// ---------- FIRST TEST: forward behaviour per percentage ----------
for (const side of sides) {
  const elig = eligibleBySide[side];
  L.push("#".repeat(120));
  L.push(`FIRST TEST — ${side.toUpperCase()} -> ${side === "support" ? "LONG" : "SHORT"} forward behaviour (eligible encounters ${elig})`);
  L.push("#".repeat(120));
  L.push(["%toNext", "Entries", "EntryR%", "AvgGap", "MedGap", "AvgGapATR", "ReclaimR1%", "ReachR2%", "R1first%", "R2first%", "Neither%", "AvgMFE", "AvgMAE", "MedTrev", "MedTr2"].map((s) => s.padStart(10)).join(""));
  for (const P of PERCENTS) {
    const list = evs.filter((e) => e.side === side && e.pctLevel === P);
    const trig = list.filter((e) => e.triggered);
    const gaps = trig.map((e) => e.gapPips), gapsA = trig.map((e) => e.gapAtr);
    const rec = trig.filter((e) => e.reclaimR1).length, r2 = trig.filter((e) => e.reachedR2).length;
    const r1first = trig.filter((e) => e.firstReclaim).length;
    const r2first = trig.filter((e) => e.reachedR2 && !e.firstReclaim).length;
    const neither = trig.filter((e) => !e.reclaimR1 && !e.reachedR2).length;
    L.push([`${P}%`, `${trig.length}`, f2(pct(trig.length, elig)), f2(mean(gaps)), f2(median(gaps)), f2(mean(gapsA)), f2(pct(rec, trig.length)), f2(pct(r2, trig.length)), f2(pct(r1first, trig.length)), f2(pct(r2first, trig.length)), f2(pct(neither, trig.length)), f2(mean(trig.map((e) => e.mfe))), f2(mean(trig.map((e) => e.mae))), f2(median(trig.filter((e) => e.tRev != null).map((e) => e.tRev!))), f2(median(trig.filter((e) => e.tR2 != null).map((e) => e.tR2!)))].map((s) => s.padStart(10)).join(""));
  }
  L.push("");
}

// ---------- SECOND TEST: 1:1 RR, per TP/SL size, percentages side by side ----------
for (const side of sides) {
  const elig = eligibleBySide[side];
  L.push("#".repeat(120));
  L.push(`SECOND TEST — ${side.toUpperCase()} -> ${side === "support" ? "LONG" : "SHORT"} fixed 1:1 RR (eligible ${elig})`);
  L.push("#".repeat(120));
  for (const rr of RR_SIZES) {
    L.push(`--- ${rr}/${rr} pips ---   [%toNext | Entries | WR% | Worst% | Best% | ExpR_all | R1Recl% | R2Hit% | Win/1k | NetR/1k | AvgSprd]`);
    for (const P of PERCENTS) {
      const list = evs.filter((e) => e.side === side && e.pctLevel === P);
      const s = rrStats(list, rr, elig);
      const trig = list.filter((e) => e.triggered);
      const recl = pct(trig.filter((e) => e.reclaimR1).length, trig.length), r2 = pct(trig.filter((e) => e.reachedR2).length, trig.length);
      L.push([`${P}%`, `${s.entries}`, f2(s.wr), f2(s.wrWorst), f2(s.wrBest), f3(s.expAll), f2(recl), f2(r2), f2(s.winsPer1k), f2(s.netRper1k), f2(s.avgSpread)].map((x) => x.padStart(9)).join(""));
    }
    L.push("");
  }
}

// ---------- support vs resistance agreement (WR gap at 10/10) ----------
L.push("=".repeat(120));
L.push("SUPPORT vs RESISTANCE agreement — resolved WR gap (pp) per %, at each RR size");
L.push("=".repeat(120));
L.push(["%\\RR", ...RR_SIZES.map((r) => `${r}/${r}`)].map((s) => s.padStart(12)).join(""));
let maxGap = 0;
for (const P of PERCENTS) {
  const cells = RR_SIZES.map((rr) => { const s = rrStats(evs.filter((e) => e.side === "support" && e.pctLevel === P), rr, 1).wr; const r = rrStats(evs.filter((e) => e.side === "resistance" && e.pctLevel === P), rr, 1).wr; maxGap = Math.max(maxGap, Math.abs(s - r)); return f2(s - r); });
  L.push([`${P}%`, ...cells].map((s) => s.padStart(12)).join(""));
}
L.push(`Max |support-resistance| WR gap: ${f2(maxGap)} pp -> ${maxGap <= 3 ? "COMBINE JUSTIFIED" : "DO NOT fully combine"}.`);
L.push("");

// ---------- COMBINED compact (all % x RR) ----------
const eligAll = eligibleBySide.support + eligibleBySide.resistance;
L.push("=".repeat(120));
L.push(`COMBINED (support+resistance) — all ${PERCENTS.length}x${RR_SIZES.length} combinations (eligible ${eligAll})`);
L.push("=".repeat(120));
L.push(["%toNext", "RR", "Entries", "Resolv", "WR%", "Worst%", "Best%", "ExpR_all", "Win/1k", "NetR/1k", "Ambig%", "Tmout%", "R1Recl%", "R2Hit%"].map((s) => s.padStart(9)).join(""));
for (const P of PERCENTS) for (const rr of RR_SIZES) {
  const list = evs.filter((e) => e.pctLevel === P); const s = rrStats(list, rr, eligAll); const trig = list.filter((e) => e.triggered);
  L.push([`${P}%`, `${rr}/${rr}`, `${s.entries}`, `${s.resolved}`, f2(s.wr), f2(s.wrWorst), f2(s.wrBest), f3(s.expAll), f2(s.winsPer1k), f2(s.netRper1k), f2(pct(s.ambig, s.entries)), f2(pct(s.tmout, s.entries)), f2(pct(trig.filter((e) => e.reclaimR1).length, trig.length)), f2(pct(trig.filter((e) => e.reachedR2).length, trig.length))].map((x) => x.padStart(9)).join(""));
}
L.push("");

// ---------- GAP-SIZE breakdown (combined, at 10/10) ----------
L.push("=".repeat(120));
L.push("GAP-SIZE breakdown (combined, boundary gap pips) — WR% & ExpR_all at 10/10, and at 25% entry across RR");
L.push("=".repeat(120));
L.push(["GapBucket", "Pairs%", "AvgGapATR", ...PERCENTS.map((p) => `${p}%WR`)].map((s) => s.padStart(11)).join("") + "   (WR at 10/10 by % entry)");
const trigAll10 = evs.filter((e) => e.triggered);
for (const [name, test] of GAP_BUCKETS) {
  const inBucket = evs.filter((e) => e.pctLevel === 0 && e.triggered && test(e.gapPips)); // count basis: entries whose gap in bucket
  const cells = PERCENTS.map((P) => { const list = evs.filter((e) => e.pctLevel === P && e.triggered && test(e.gapPips)); return f2(rrStats(list, 10, 1).wr); });
  L.push([name, f2(pct(inBucket.length, evs.filter((e) => e.pctLevel === 0 && e.triggered).length)), f2(mean(evs.filter((e) => e.pctLevel === 0 && e.triggered && test(e.gapPips)).map((e) => e.gapAtr))), ...cells].map((s) => s.padStart(11)).join(""));
}
L.push("");

// ---------- S/R TYPE COMBINATION breakdown ----------
L.push("=".repeat(120));
L.push("S/R TYPE COMBINATION (k1->k2) — only range->swing & swing->range exist. WR% at 10/10 by % entry (combined)");
L.push("=".repeat(120));
const combos: Array<[Kind, Kind]> = [["range", "swing"], ["swing", "range"]];
L.push(["combo", "Entries@0%", ...PERCENTS.map((p) => `${p}%WR`)].map((s) => s.padStart(12)).join(""));
for (const [a, b] of combos) {
  const base = evs.filter((e) => e.pctLevel === 0 && e.triggered && e.k1 === a && e.k2 === b).length;
  const cells = PERCENTS.map((P) => f2(rrStats(evs.filter((e) => e.pctLevel === P && e.triggered && e.k1 === a && e.k2 === b), 10, 1).wr));
  L.push([`${a}->${b}`, `${base}`, ...cells].map((s) => s.padStart(12)).join(""));
}
L.push("(range->range and swing->swing are structurally impossible: the indicator exposes only one range and one swing level per side.)");
L.push("");

// ---------- candidate filter + stability for any +EV combined cohort ----------
const PERIODS: Array<[string, (y: number) => boolean]> = [["2013-2016", (y) => y <= 2016], ["2017-2020", (y) => y >= 2017 && y <= 2020], ["2021-2023", (y) => y >= 2021 && y <= 2023], ["2024-2026", (y) => y >= 2024]];
L.push("=".repeat(120));
L.push("CANDIDATE FILTER (combined): resolved WR>50%, ExpR_all>0, >=1000 resolved, +EV majority years, S/R agree(<=3pp), ambiguity<edge");
L.push("=".repeat(120));
const cands: string[] = [];
for (const P of PERCENTS) for (const rr of RR_SIZES) {
  const list = evs.filter((e) => e.pctLevel === P); const c = rrStats(list, rr, eligAll);
  if (!(c.wr > 50 && c.expAll > 0 && c.resolved >= 1000)) continue;
  const yrs = [...new Set(evs.map((e) => e.year))].sort();
  const posY = yrs.filter((y) => { const s = rrStats(evs.filter((e) => e.pctLevel === P && e.year === y), rr, 1); return s.expRes > 0; }).length;
  const sWR = rrStats(evs.filter((e) => e.side === "support" && e.pctLevel === P), rr, 1).wr, rWR = rrStats(evs.filter((e) => e.side === "resistance" && e.pctLevel === P), rr, 1).wr;
  const agree = Math.abs(sWR - rWR) <= 3; const ambigOk = pct(c.ambig, c.entries) < (c.wr - 50); const pass = posY > yrs.length / 2 && agree && ambigOk;
  L.push(`${pass ? "PASS" : "----"} ${P}% ${rr}/${rr}: WR ${f2(c.wr)}% ExpR_all ${f3(c.expAll)} NetR/1k ${f2(c.netRper1k)} resolved ${c.resolved} | +EV yrs ${posY}/${yrs.length} | S/R gap ${f2(Math.abs(sWR - rWR))}pp | ambig ${f2(pct(c.ambig, c.entries))}%`);
  if (pass) {
    cands.push(`${P}% ${rr}/${rr} (WR ${f2(c.wr)}%, NetR/1k ${f2(c.netRper1k)}, resolved ${c.resolved})`);
    for (const [pn, pt] of PERIODS) { const s = rrStats(evs.filter((e) => e.pctLevel === P && pt(e.year)), rr, 1); L.push(`      ${pn}: resolved ${s.resolved} WR ${f2(s.wr)}% ExpR_res ${f3(s.expRes)}`); }
  }
}
L.push("");
L.push("STRONGEST CANDIDATES (raw stats, no final rule chosen):");
if (cands.length) cands.forEach((s) => L.push(`  * ${s}`)); else L.push("  (none passed all gates)");
L.push("");

const report = L.join("\n");
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-nextlevel-report.txt"), report + "\n");
console.log(report.split("\n").slice(0, 9).join("\n"));

// ---------- event-level CSV (one row per encounter x percentage x RR) ----------
const csv: string[] = [];
csv.push(["timestamp", "pair", "side", "sr1_price", "sr1_type", "sr2_price", "sr2_type", "gap_pips", "gap_atr", "percentage", "intended_entry", "executable_entry", "entry_triggered", "spread_pips", "r1_reclaimed", "r2_reached", "mfe_pips", "mae_pips", "rr_pips", "outcome", "hold_bars"].join(","));
for (const e of evs) {
  if (!e.triggered) { csv.push([e.time, "EUR_USD", e.side, e.L1.toFixed(5), e.k1, e.L2.toFixed(5), e.k2, e.gapPips.toFixed(2), e.gapAtr.toFixed(3), e.pctLevel, e.intended.toFixed(5), "", "no", "", "", "", "", "", "", "", ""].join(",")); continue; }
  for (const rr of RR_SIZES) { const o = e.rr[rr]!; csv.push([e.time, "EUR_USD", e.side, e.L1.toFixed(5), e.k1, e.L2.toFixed(5), e.k2, e.gapPips.toFixed(2), e.gapAtr.toFixed(3), e.pctLevel, e.intended.toFixed(5), e.fill.toFixed(5), "yes", e.spreadPips.toFixed(2), e.reclaimR1 ? "yes" : "no", e.reachedR2 ? "yes" : "no", e.mfe.toFixed(2), e.mae.toFixed(2), rr, o.outcome, o.hold].join(",")); }
}
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-nextlevel-events.csv"), csv.join("\n") + "\n");
console.error(`[written] eurusd-15m-sr-nextlevel-report.txt | eurusd-15m-sr-nextlevel-events.csv (${evs.length} entry-events)`);

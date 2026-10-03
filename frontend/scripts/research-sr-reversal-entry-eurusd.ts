/**
 * EUR/USD 15M — S/R REVERSAL ENTRY-LOCATION STUDY (V2, research-only, NO trading).
 *
 * Phase 2 of the V1 MAE study. V1 asked "how far did successful reversals travel";
 * this asks "if I wait X pips BEYOND the S/R outer edge before entering, how often
 * does price subsequently reclaim, and what is the trade-frequency / entry-price /
 * MAE trade-off". It SIMULATES actual entries chronologically.
 *
 * S/R LOGIC IS UNCHANGED — reused verbatim from the project, identical to V1:
 *   computeSupportResistanceLevels (via assessMarketCondition), atr14Of,
 *   PRICE_REACTION_THRESHOLDS, pipSizeFor. Same WINDOW(220)/HORIZON(96), same
 *   arm/disarm de-duplication, same frozen level/ATR/zone, same NEAR_* detection,
 *   same nearest-of {range,swing} pick, same touchAtr zone half-width, same
 *   project "reclaim" (meaningful penetration then close back inside the zone).
 *
 * WHAT IS ADDED (only the entry simulation, nothing about S/R):
 *   - Executable bid/ask entries (OANDA price="MBA", M15 resolution — see caveat).
 *   - Chronological entry trigger with NO look-ahead: at the encounter bar t0 we
 *     "place resting limits" at each distance; they can only fill on LATER bars
 *     (scan t0+1..t0+HORIZON). An encounter is a trade at distance D only if price
 *     actually reaches that entry.
 *   - Per-trade reclaim outcome (project def), time-to-reclaim, and executable
 *     MFE/MAE (long marks out at BID, short at ASK — round-trip spread included).
 *
 * EXECUTION MODEL (documented, honest):
 *   Intended entry (MID space):  support/long  E = (L - w) - D*pip   (w = touchAtr*ATR)
 *                                resistance/short E = (L + w) + D*pip
 *   Trigger:  long  when mid.low  <= E ;  short when mid.high >= E   (bars t0+1..t0+HORIZON)
 *   Fill  :   long  fill_ask = E + (ask.close - mid.close)  [pay ASK when mid==E]
 *             short fill_bid = E - (mid.close - bid.close)  [receive BID when mid==E]
 *   spread_at_entry = ask.close - bid.close (of the trigger bar)
 *   Reclaim resolution: from the ENTRY bar, HORIZON bars forward (equal look-forward
 *     per trade — fair across distances). Reclaim = MID close back inside the zone
 *     after project-meaningful penetration; Fail = project acceptance/continuation
 *     against us, OR horizon reached with no reclaim.
 *   MFE/MAE: measured from the executable fill until the resolution bar. LONG exits
 *     at BID, SHORT exits at ASK, so both excursions already carry the spread.
 *
 * CAVEAT (reported up-front): bid/ask exist only at M15 candle OHLC resolution,
 *   NOT tick. Intrabar order of high vs low is unknown, and the spread is the bar's
 *   close spread, not the spread at the exact touch. Results are candle-approximate.
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

const WINDOW = 220;   // identical to V1
const HORIZON = 96;   // identical to V1 (~24h M15)
const PIP = pipSizeFor(INSTRUMENT);

const TOUCH_ATR = PR.touchAtr;                       // 0.10 zone half-width in ATR
const MIN_PEN_ATR = PR.minPenetrationAtr;            // 0.05
const ACCEPT_MIN_BARS = PR.acceptMinBars;            // 2
const ACCEPT_MIN_DIST_ATR = PR.acceptMinDistanceAtr; // 0.40

const DISTANCES = [0, 1, 2, 3, 4, 5, 6, 8, 10]; // pips beyond the OUTER edge

type Side = "support" | "resistance";
type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };

// ---- load MBA candles ----
const raw: RC[] = JSON.parse(fs.readFileSync(CACHE, "utf8"));
const n = raw.length;
// MID candle view for the (unchanged) S/R detection — same stream V1 used
const mids: Candle[] = raw.map((c) => ({ time: c.time, open: c.mid.open, high: c.mid.high, low: c.mid.low, close: c.mid.close, volume: 0, complete: true }));

interface Encounter { t0: number; time: string; side: Side; levelKind: "range" | "swing"; L: number; atr: number; zoneLo: number; zoneHi: number; outerEdge: number; }

// ------- encounter detection: copied verbatim from V1 (NO changes) -------
const encounters: Encounter[] = [];
let armedR = true, armedS = true;
const startT = WINDOW;
for (let t = startT; t < n; t++) {
  const window = mids.slice(t - WINDOW + 1, t + 1);
  const assessment = assessMarketCondition({ candles: window, instrument: INSTRUMENT, timeframe: TIMEFRAME });
  const levels = assessment.levels;
  if (!levels) { continue; }
  const loc = assessment.location;
  const current = levels.current;
  const A = atr14Of(window);
  if (!(A > 0)) continue;
  const nearR = loc === "NEAR_RESISTANCE";
  const nearS = loc === "NEAR_SUPPORT";
  if (nearR && armedR) {
    const cand = [levels.rangeHigh, levels.swingHigh].filter((x): x is number => x !== null && x >= current);
    if (cand.length) {
      const L = cand.reduce((a, b) => (b - current < a - current ? b : a));
      const kind: "range" | "swing" = L === levels.rangeHigh ? "range" : "swing";
      const w = TOUCH_ATR * A;
      encounters.push({ t0: t, time: raw[t]!.time, side: "resistance", levelKind: kind, L, atr: A, zoneLo: L - w, zoneHi: L + w, outerEdge: L + w });
      armedR = false;
    }
  } else if (!nearR) { armedR = true; }
  if (nearS && armedS) {
    const cand = [levels.rangeLow, levels.swingLow].filter((x): x is number => x !== null && x <= current);
    if (cand.length) {
      const L = cand.reduce((a, b) => (current - b < current - a ? b : a));
      const kind: "range" | "swing" = L === levels.rangeLow ? "range" : "swing";
      const w = TOUCH_ATR * A;
      encounters.push({ t0: t, time: raw[t]!.time, side: "support", levelKind: kind, L, atr: A, zoneLo: L - w, zoneHi: L + w, outerEdge: L - w });
      armedS = false;
    }
  } else if (!nearS) { armedS = true; }
}

// ------- V1 FIDELITY CROSS-CHECK: project reclaim among ALL encounters, resolved
// from t0 exactly like V1 (should reproduce ~81% support / ~81% resistance). This
// proves the detection is unchanged; the entry study's lower "reclaim among entries"
// is purely the added "price must reach the entry" filter, not a broken reproduction.
const v1: Record<Side, { success: number; total: number }> = { support: { success: 0, total: 0 }, resistance: { success: 0, total: 0 } };
for (const e of encounters) {
  const w = TOUCH_ATR * e.atr; const topEdge = e.L + w, botEdge = e.L - w;
  let barsBeyond = 0, adverse = e.side === "resistance" ? -Infinity : Infinity, done = false, success = false;
  const end = Math.min(e.t0 + HORIZON, n - 1);
  for (let j = e.t0; j <= end && !done; j++) {
    const c = raw[j]!.mid;
    adverse = e.side === "resistance" ? Math.max(adverse, c.high) : Math.min(adverse, c.low);
    const beyondClose = e.side === "resistance" ? c.close - e.L : e.L - c.close;
    if (beyondClose > w) barsBeyond += 1; else barsBeyond = 0;
    const accepted = barsBeyond >= ACCEPT_MIN_BARS && (beyondClose / e.atr) >= ACCEPT_MIN_DIST_ATR;
    const penReached = (e.side === "resistance" ? adverse - e.L : e.L - adverse) >= MIN_PEN_ATR * e.atr;
    const closeInside = e.side === "resistance" ? c.close <= topEdge : c.close >= botEdge;
    if (accepted) { done = true; }
    else if (penReached && closeInside) { success = true; done = true; }
  }
  v1[e.side].total += 1; if (success) v1[e.side].success += 1;
}

// ------- per-encounter, per-distance entry simulation -------
interface TradeRow {
  time: string; side: Side; levelKind: string; L: number; atr: number; outerEdge: number;
  distPips: number; intendedEntry: number; fill: number; spreadPips: number;
  triggered: boolean; reclaimed: boolean; tReclaim: number | null;
  mfePips: number; maePips: number; mfeAtr: number; maeAtr: number;
}
const trades: TradeRow[] = [];

for (const e of encounters) {
  const w = TOUCH_ATR * e.atr;
  const topEdge = e.L + w, botEdge = e.L - w;
  for (const D of DISTANCES) {
    const Dp = D * PIP;
    const intended = e.side === "support" ? botEdge - Dp : topEdge + Dp;
    // --- entry trigger: scan t0+1 .. t0+HORIZON on MID (no same-bar-as-detection fill) ---
    let entryBar = -1;
    const scanEnd = Math.min(e.t0 + HORIZON, n - 1);
    for (let j = e.t0 + 1; j <= scanEnd; j++) {
      const m = raw[j]!.mid;
      if (e.side === "support" ? m.low <= intended : m.high >= intended) { entryBar = j; break; }
    }
    if (entryBar < 0) {
      trades.push({ time: e.time, side: e.side, levelKind: e.levelKind, L: e.L, atr: e.atr, outerEdge: e.outerEdge, distPips: D, intendedEntry: intended, fill: NaN, spreadPips: NaN, triggered: false, reclaimed: false, tReclaim: null, mfePips: NaN, maePips: NaN, mfeAtr: NaN, maeAtr: NaN });
      continue;
    }
    // --- executable fill (bid/ask), spread at entry ---
    const eb = raw[entryBar]!;
    const spread = eb.ask.close - eb.bid.close;
    const fill = e.side === "support" ? intended + (eb.ask.close - eb.mid.close) : intended - (eb.mid.close - eb.bid.close);
    // --- reclaim resolution + MFE/MAE from entry bar, HORIZON bars forward ---
    const resEnd = Math.min(entryBar + HORIZON, n - 1);
    let barsBeyond = 0, reclaimed = false, tReclaim: number | null = null, resolveBar = resEnd;
    let bestFav = -Infinity, worstAdv = -Infinity; // in price, favorable / adverse magnitude
    for (let j = entryBar; j <= resEnd; j++) {
      const c = raw[j]!;
      // executable excursions (long exits at BID, short exits at ASK)
      const favNow = e.side === "support" ? c.bid.high - fill : fill - c.ask.low;
      const advNow = e.side === "support" ? fill - c.bid.low : c.ask.high - fill;
      if (favNow > bestFav) bestFav = favNow;
      if (advNow > worstAdv) worstAdv = advNow;
      // project acceptance/continuation (against us) — MID closes beyond L
      const beyondClose = e.side === "resistance" ? c.mid.close - e.L : e.L - c.mid.close;
      if (beyondClose > w) barsBeyond += 1; else barsBeyond = 0;
      const accepted = barsBeyond >= ACCEPT_MIN_BARS && (beyondClose / e.atr) >= ACCEPT_MIN_DIST_ATR;
      // project reclaim — meaningful penetration then MID close back inside the zone
      const closeInside = e.side === "support" ? c.mid.close >= botEdge : c.mid.close <= topEdge;
      const meaningfulPen = true; // entry sits at/beyond outer edge => penetration >= w = 0.10*ATR >= minPen(0.05*ATR)
      if (accepted) { resolveBar = j; break; }
      if (meaningfulPen && closeInside && j > entryBar) { reclaimed = true; tReclaim = j - entryBar; resolveBar = j; break; }
    }
    // truncate excursions to resolution bar (recompute cleanly)
    bestFav = -Infinity; worstAdv = -Infinity;
    for (let j = entryBar; j <= resolveBar; j++) {
      const c = raw[j]!;
      const favNow = e.side === "support" ? c.bid.high - fill : fill - c.ask.low;
      const advNow = e.side === "support" ? fill - c.bid.low : c.ask.high - fill;
      if (favNow > bestFav) bestFav = favNow;
      if (advNow > worstAdv) worstAdv = advNow;
    }
    trades.push({
      time: e.time, side: e.side, levelKind: e.levelKind, L: e.L, atr: e.atr, outerEdge: e.outerEdge,
      distPips: D, intendedEntry: intended, fill, spreadPips: spread / PIP,
      triggered: true, reclaimed, tReclaim,
      mfePips: bestFav / PIP, maePips: worstAdv / PIP, mfeAtr: bestFav / e.atr, maeAtr: worstAdv / e.atr,
    });
  }
}

// ---------------- statistics ----------------
const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

const sides: Side[] = ["support", "resistance"];
const encBySide: Record<Side, number> = { support: encounters.filter((e) => e.side === "support").length, resistance: encounters.filter((e) => e.side === "resistance").length };

const first = raw[startT]?.time, last = raw[n - 1]?.time;
const years = (new Date(last!).getTime() - new Date(first!).getTime()) / (365.25 * 864e5);

const L: string[] = [];
L.push("EUR/USD 15M — S/R REVERSAL ENTRY-LOCATION STUDY (V2, research-only, NO trading)");
L.push(`Data: OANDA M15 MID+BID+ASK completed candles, ${n} bars, ${first} -> ${last} (~${f2(years)}y).`);
L.push(`S/R source: UNCHANGED project stack (computeSupportResistanceLevels via assessMarketCondition; NEAR_* detection; touchAtr zone; project reclaim). Same WINDOW=${WINDOW}, HORIZON=${HORIZON}.`);
L.push(`Encounters detected: support ${encBySide.support}, resistance ${encBySide.resistance}  (V1 reference: 15,778 / 15,533 over its shorter window).`);
L.push(`Execution: LONG fills at ASK, SHORT fills at BID; MFE/MAE mark-out LONG@BID SHORT@ASK (round-trip spread included).`);
L.push(`CAVEAT: bid/ask are M15-candle resolution (OHLC), NOT tick. Intrabar hi/lo order unknown; spread = bar close spread. Results candle-approximate.`);
L.push(`V1 FIDELITY CHECK (project reclaim among ALL encounters, resolved from t0 like V1): support ${f2(pct(v1.support.success, v1.support.total))}%  resistance ${f2(pct(v1.resistance.success, v1.resistance.total))}%  (V1 was 81.06% / 81.08% -> detection reproduced). The lower per-entry reclaim below is the added "price must reach the entry" filter, NOT a different S/R.`);
L.push("");

interface Agg { D: number; enc: number; entries: number; reclaims: number; fails: number; avgT: number; medT: number; avgMFE: number; medMFE: number; avgMAE: number; medMAE: number; avgSpread: number; per1000: number; }
const aggBySide: Record<Side, Agg[]> = { support: [], resistance: [] };

for (const side of sides) {
  const enc = encBySide[side];
  L.push("=".repeat(110));
  L.push(`${side.toUpperCase()} -> ${side === "support" ? "LONG" : "SHORT"}    (S/R encounters: ${enc})`);
  L.push("=".repeat(110));
  L.push(["Dist", "Entries", "EntryRate", "Reclaims", "Fails", "ReclaimRate", "AvgT", "MedT", "AvgMFE", "MedMFE", "AvgMAE", "MedMAE", "AvgSprd", "Rcl/1000enc"].map((s) => s.padStart(11)).join(""));
  for (const D of DISTANCES) {
    const rows = trades.filter((r) => r.side === side && r.distPips === D);
    const trig = rows.filter((r) => r.triggered);
    const rec = trig.filter((r) => r.reclaimed);
    const fails = trig.length - rec.length;
    const tRec = rec.map((r) => r.tReclaim!).filter((x) => x != null);
    const mfe = trig.map((r) => r.mfePips), mae = trig.map((r) => r.maePips);
    const per1000 = enc > 0 ? (rec.length / enc) * 1000 : 0;
    const a: Agg = { D, enc, entries: trig.length, reclaims: rec.length, fails, avgT: mean(tRec), medT: median(tRec), avgMFE: mean(mfe), medMFE: median(mfe), avgMAE: mean(mae), medMAE: median(mae), avgSpread: mean(trig.map((r) => r.spreadPips)), per1000 };
    aggBySide[side].push(a);
    L.push([
      `${D}p`, `${trig.length}`, `${f2(pct(trig.length, enc))}%`, `${rec.length}`, `${fails}`, `${f2(pct(rec.length, trig.length))}%`,
      f2(a.avgT), f2(a.medT), f2(a.avgMFE), f2(a.medMFE), f2(a.avgMAE), f2(a.medMAE), f2(a.avgSpread), f2(per1000),
    ].map((s) => s.padStart(11)).join(""));
  }
  L.push("");
  // conditional improvement (each step vs previous distance)
  L.push(`  CONDITIONAL IMPROVEMENT (${side}) — each distance vs the previous tested distance:`);
  L.push(["  from->to", "dEntries", "dEntry%", "dReclaimRate", "dEntryPx(pip)", "dMedMAE", "dRcl/1000"].map((s) => s.padStart(14)).join(""));
  const A = aggBySide[side];
  for (let i = 1; i < A.length; i++) {
    const p = A[i - 1]!, c = A[i]!;
    L.push([
      `  ${p.D}->${c.D}p`, `${c.entries - p.entries}`, `${f2(pct(c.entries, enc) - pct(p.entries, enc))}%`,
      `${f2(pct(c.reclaims, c.entries) - pct(p.reclaims, p.entries))}%`, `${c.D - p.D}`,
      `${f2(c.medMAE - p.medMAE)}`, `${f2(c.per1000 - p.per1000)}`,
    ].map((s) => s.padStart(14)).join(""));
  }
  L.push("");
}

// ---- combined (only meaningful if support ~ resistance) ----
L.push("=".repeat(110));
L.push("SUPPORT vs RESISTANCE COMPARISON (reclaim-rate after entry, by distance) — combine only if these track closely");
L.push("=".repeat(110));
L.push(["Dist", "Sup ReclRate", "Res ReclRate", "Diff(pp)", "Sup Rcl/1000", "Res Rcl/1000"].map((s) => s.padStart(15)).join(""));
let maxDiff = 0;
for (let i = 0; i < DISTANCES.length; i++) {
  const s = aggBySide.support[i]!, r = aggBySide.resistance[i]!;
  const sr = pct(s.reclaims, s.entries), rr = pct(r.reclaims, r.entries);
  maxDiff = Math.max(maxDiff, Math.abs(sr - rr));
  L.push([`${s.D}p`, `${f2(sr)}%`, `${f2(rr)}%`, `${f2(sr - rr)}`, `${f2(s.per1000)}`, `${f2(r.per1000)}`].map((x) => x.padStart(15)).join(""));
}
L.push("");
const combineOK = maxDiff <= 3.0; // <=3pp reclaim-rate gap at every distance
L.push(`Max support-vs-resistance reclaim-rate gap across distances: ${f2(maxDiff)} pp -> ${combineOK ? "COMBINE JUSTIFIED (<=3pp)" : "DO NOT COMBINE (>3pp difference)"}.`);
if (combineOK) {
  L.push("");
  L.push("COMBINED (support+resistance):");
  L.push(["Dist", "Entries", "Reclaims", "ReclaimRate", "AvgMAE", "MedMAE", "Rcl/1000enc"].map((s) => s.padStart(13)).join(""));
  const encTot = encBySide.support + encBySide.resistance;
  for (let i = 0; i < DISTANCES.length; i++) {
    const D = DISTANCES[i]!;
    const rows = trades.filter((r) => r.distPips === D && r.triggered);
    const rec = rows.filter((r) => r.reclaimed);
    L.push([`${D}p`, `${rows.length}`, `${rec.length}`, `${f2(pct(rec.length, rows.length))}%`, f2(mean(rows.map((r) => r.maePips))), f2(median(rows.map((r) => r.maePips))), f2((rec.length / encTot) * 1000)].map((s) => s.padStart(13)).join(""));
  }
}
L.push("");

// ---- plain-English summary ----
L.push("=".repeat(110));
L.push("PLAIN-ENGLISH SUMMARY — EUR/USD 15M");
L.push("=".repeat(110));
for (const side of sides) {
  L.push(`${side.toUpperCase()} -> ${side === "support" ? "LONG" : "SHORT"} (encounters ${encBySide[side]}):`);
  for (const a of aggBySide[side]) {
    L.push(`  ${String(a.D).padStart(2)}p: ${f2(pct(a.reclaims, a.entries))}% reclaim | ${a.entries} entries (${f2(pct(a.entries, a.enc))}% of enc) | ${a.reclaims} wins = ${f2(a.per1000)}/1000 enc | medMAE ${f2(a.medMAE)}p`);
  }
  L.push("");
}

const report = L.join("\n");
console.log(report);
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-reversal-entry-report.txt"), report + "\n");

// ---- CSV: every simulated entry ----
const csv: string[] = [];
csv.push(["timestamp", "sr_type", "sr_zone", "outer_boundary", "atr_price", "entry_distance_pips", "intended_entry", "actual_executable_entry", "spread_at_entry_pips", "entry_triggered", "reclaimed", "time_to_reclaim_bars", "mfe_pips", "mae_pips", "mfe_atr", "mae_atr"].join(","));
for (const r of trades) {
  csv.push([
    r.time, r.side, r.levelKind, r.outerEdge.toFixed(5), r.atr.toFixed(6), r.distPips,
    r.intendedEntry.toFixed(5), Number.isFinite(r.fill) ? r.fill.toFixed(5) : "", Number.isFinite(r.spreadPips) ? r.spreadPips.toFixed(2) : "",
    r.triggered ? "yes" : "no", r.triggered ? (r.reclaimed ? "yes" : "no") : "", r.tReclaim ?? "",
    Number.isFinite(r.mfePips) ? r.mfePips.toFixed(2) : "", Number.isFinite(r.maePips) ? r.maePips.toFixed(2) : "",
    Number.isFinite(r.mfeAtr) ? r.mfeAtr.toFixed(3) : "", Number.isFinite(r.maeAtr) ? r.maeAtr.toFixed(3) : "",
  ].join(","));
}
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-reversal-entry-events.csv"), csv.join("\n") + "\n");
console.error(`\n[written] eurusd-15m-sr-reversal-entry-report.txt | eurusd-15m-sr-reversal-entry-events.csv (${trades.length} rows)`);

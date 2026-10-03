/**
 * EUR/USD 15M — S/R FIXED-RR ENTRY TEST (V3, research-only, NO trading, FROZEN).
 *
 * Builds on V2 with the S/R + entry-detection systems UNCHANGED. Reused verbatim:
 *   computeSupportResistanceLevels (via assessMarketCondition), NEAR_* detection,
 *   touchAtr zones, frozen levels, arm/disarm de-dup, WINDOW=220, HORIZON=96,
 *   OANDA M15 MID+BID+ASK, chronological no-lookahead entry (scan t0+1..),
 *   LONG fills at ASK / SHORT fills at BID.
 *
 * V3 replaces the "return-to-S/R" outcome with FIXED 1:1 RR trade resolution:
 *   TP/SL are placed a fixed pip distance from the ACTUAL executable entry (NOT S/R).
 *   LONG: entry ASK; TP/SL checked on BID.   SHORT: entry BID; TP/SL checked on ASK.
 *   Spread enters once (via ASK entry / opposite-side exit) — never subtracted again.
 *   96-bar max hold AFTER the entry bar.
 *
 * Intrabar ambiguity: M15 OHLC (not tick) => if TP and SL are both inside the same
 *   candle the order is unknown -> AMBIGUOUS (excluded from resolved WR; best/worst
 *   bounds reported). Timeout (neither hit in 96 bars) is neither win nor loss in
 *   resolved WR, but counts as 0R in the all-triggered expectancy.
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

const DISTANCES = [0, 1, 2, 3, 4, 5, 6, 8, 10];
const RR_SIZES = [5, 8, 10, 12, 15]; // pip TP == pip SL (1:1)

type Side = "support" | "resistance";
type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };

const raw: RC[] = JSON.parse(fs.readFileSync(CACHE, "utf8"));
const n = raw.length;
const mids: Candle[] = raw.map((c) => ({ time: c.time, open: c.mid.open, high: c.mid.high, low: c.mid.low, close: c.mid.close, volume: 0, complete: true }));

interface Encounter { t0: number; time: string; side: Side; levelKind: "range" | "swing"; L: number; atr: number; outerEdge: number; }

// ---------- encounter detection: copied verbatim from V1/V2 (UNCHANGED) ----------
const encounters: Encounter[] = [];
let armedR = true, armedS = true;
const startT = WINDOW;
for (let t = startT; t < n; t++) {
  const window = mids.slice(t - WINDOW + 1, t + 1);
  const assessment = assessMarketCondition({ candles: window, instrument: INSTRUMENT, timeframe: TIMEFRAME });
  const levels = assessment.levels; if (!levels) continue;
  const loc = assessment.location; const current = levels.current; const A = atr14Of(window); if (!(A > 0)) continue;
  const nearR = loc === "NEAR_RESISTANCE", nearS = loc === "NEAR_SUPPORT";
  if (nearR && armedR) {
    const cand = [levels.rangeHigh, levels.swingHigh].filter((x): x is number => x !== null && x >= current);
    if (cand.length) { const L = cand.reduce((a, b) => (b - current < a - current ? b : a)); const kind = L === levels.rangeHigh ? "range" : "swing"; encounters.push({ t0: t, time: raw[t]!.time, side: "resistance", levelKind: kind, L, atr: A, outerEdge: L + TOUCH_ATR * A }); armedR = false; }
  } else if (!nearR) armedR = true;
  if (nearS && armedS) {
    const cand = [levels.rangeLow, levels.swingLow].filter((x): x is number => x !== null && x <= current);
    if (cand.length) { const L = cand.reduce((a, b) => (current - b < current - a ? b : a)); const kind = L === levels.rangeLow ? "range" : "swing"; encounters.push({ t0: t, time: raw[t]!.time, side: "support", levelKind: kind, L, atr: A, outerEdge: L - TOUCH_ATR * A }); armedS = false; }
  } else if (!nearS) armedS = true;
}

// ---------- V1/V2 fidelity check (project reclaim among ALL encounters from t0) ----------
const v1: Record<Side, { s: number; t: number }> = { support: { s: 0, t: 0 }, resistance: { s: 0, t: 0 } };
for (const e of encounters) {
  const w = TOUCH_ATR * e.atr, top = e.L + w, bot = e.L - w; let bb = 0, adv = e.side === "resistance" ? -Infinity : Infinity, done = false, ok = false;
  const end = Math.min(e.t0 + HORIZON, n - 1);
  for (let j = e.t0; j <= end && !done; j++) { const c = raw[j]!.mid; adv = e.side === "resistance" ? Math.max(adv, c.high) : Math.min(adv, c.low); const bc = e.side === "resistance" ? c.close - e.L : e.L - c.close; if (bc > w) bb++; else bb = 0; const acc = bb >= ACCEPT_MIN_BARS && bc / e.atr >= ACCEPT_MIN_DIST_ATR; const pen = (e.side === "resistance" ? adv - e.L : e.L - adv) >= MIN_PEN_ATR * e.atr; const ins = e.side === "resistance" ? c.close <= top : c.close >= bot; if (acc) done = true; else if (pen && ins) { ok = true; done = true; } }
  v1[e.side].t++; if (ok) v1[e.side].s++;
}
const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
const v1S = pct(v1.support.s, v1.support.t), v1R = pct(v1.resistance.s, v1.resistance.t);
const FIDELITY_OK = v1S >= 78 && v1S <= 84 && v1R >= 78 && v1R <= 84;
if (!FIDELITY_OK) { console.error(`FIDELITY FAILED: support ${v1S.toFixed(2)}% resistance ${v1R.toFixed(2)}% (expected ~81%). STOP.`); process.exit(1); }

// ---------- V3 trade resolution ----------
type Outcome = "win" | "loss" | "ambiguous" | "timeout";
interface Trade { time: string; year: number; side: Side; dist: number; rr: number; entry: number; spreadPips: number; outcome: Outcome; holdBars: number; }
const trades: Trade[] = [];

for (const e of encounters) {
  const w = TOUCH_ATR * e.atr, top = e.L + w, bot = e.L - w;
  for (const D of DISTANCES) {
    const intended = e.side === "support" ? bot - D * PIP : top + D * PIP;
    // entry trigger: chronological, no-lookahead (scan t0+1..t0+HORIZON) on MID reaching the level
    let entryBar = -1; const scanEnd = Math.min(e.t0 + HORIZON, n - 1);
    for (let j = e.t0 + 1; j <= scanEnd; j++) { const m = raw[j]!.mid; if (e.side === "support" ? m.low <= intended : m.high >= intended) { entryBar = j; break; } }
    if (entryBar < 0) continue; // never triggered -> not a trade
    const eb = raw[entryBar]!;
    const spread = eb.ask.close - eb.bid.close;
    // executable fill: LONG pays ASK, SHORT receives BID (spread enters here, once)
    const fill = e.side === "support" ? intended + (eb.ask.close - eb.mid.close) : intended - (eb.mid.close - eb.bid.close);
    for (const rr of RR_SIZES) {
      const tp = e.side === "support" ? fill + rr * PIP : fill - rr * PIP;
      const sl = e.side === "support" ? fill - rr * PIP : fill + rr * PIP;
      // resolution: 96 bars AFTER entry; exits on the OPPOSITE side (LONG->BID, SHORT->ASK)
      let outcome: Outcome = "timeout"; let holdBars = HORIZON; const resEnd = Math.min(entryBar + HORIZON, n - 1);
      for (let j = entryBar + 1; j <= resEnd; j++) {
        const c = raw[j]!; let hitTP = false, hitSL = false;
        if (e.side === "support") { hitTP = c.bid.high >= tp; hitSL = c.bid.low <= sl; }
        else { hitTP = c.ask.low <= tp; hitSL = c.ask.high >= sl; }
        if (hitTP && hitSL) { outcome = "ambiguous"; holdBars = j - entryBar; break; }
        if (hitTP) { outcome = "win"; holdBars = j - entryBar; break; }
        if (hitSL) { outcome = "loss"; holdBars = j - entryBar; break; }
      }
      trades.push({ time: e.time, year: new Date(e.time).getUTCFullYear(), side: e.side, dist: D, rr, entry: fill, spreadPips: spread / PIP, outcome, holdBars });
    }
  }
}

// ---------- aggregation ----------
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "-");
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const encBySide: Record<Side, number> = { support: encounters.filter((e) => e.side === "support").length, resistance: encounters.filter((e) => e.side === "resistance").length };

interface Cohort {
  side: Side | "combined"; dist: number; rr: number; enc: number; entries: number;
  wins: number; losses: number; ambig: number; timeouts: number; resolved: number;
  wr: number; wrBest: number; wrWorst: number; pf: number; expResolved: number; expAll: number;
  avgSpread: number; medSpread: number; avgHold: number; medHold: number; maxDD: number; winsPer1k: number; netRper1k: number;
}
function cohortOf(list: Trade[], enc: number, side: Cohort["side"], dist: number, rr: number): Cohort {
  const entries = list.length;
  const wins = list.filter((t) => t.outcome === "win").length;
  const losses = list.filter((t) => t.outcome === "loss").length;
  const ambig = list.filter((t) => t.outcome === "ambiguous").length;
  const timeouts = list.filter((t) => t.outcome === "timeout").length;
  const resolved = wins + losses;
  const wr = pct(wins, resolved), wrBest = pct(wins + ambig, resolved + ambig), wrWorst = pct(wins, resolved + ambig);
  const pf = losses > 0 ? wins / losses : (wins > 0 ? Infinity : NaN); // 1:1 => PF = wins/losses
  const expResolved = resolved > 0 ? (wins - losses) / resolved : NaN; // R
  const expAll = entries > 0 ? (wins - losses) / entries : NaN; // timeouts=0R, ambiguous excluded from numerator
  // chronological max drawdown in R over RESOLVED trades (win=+1,loss=-1)
  const seq = [...list].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0)).filter((t) => t.outcome === "win" || t.outcome === "loss");
  let eq = 0, peak = 0, maxDD = 0; for (const t of seq) { eq += t.outcome === "win" ? 1 : -1; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq); }
  const winsPer1k = enc > 0 ? (wins / enc) * 1000 : NaN;
  const netRper1k = enc > 0 ? ((wins - losses) / enc) * 1000 : NaN;
  return { side, dist, rr, enc, entries, wins, losses, ambig, timeouts, resolved, wr, wrBest, wrWorst, pf, expResolved, expAll, avgSpread: mean(list.map((t) => t.spreadPips)), medSpread: median(list.map((t) => t.spreadPips)), avgHold: mean(list.map((t) => t.holdBars)), medHold: median(list.map((t) => t.holdBars)), maxDD, winsPer1k, netRper1k };
}

const sides: Side[] = ["support", "resistance"];
const cohorts: Cohort[] = [];
for (const side of sides) for (const D of DISTANCES) for (const rr of RR_SIZES) cohorts.push(cohortOf(trades.filter((t) => t.side === side && t.dist === D && t.rr === rr), encBySide[side], side, D, rr));
// combined
for (const D of DISTANCES) for (const rr of RR_SIZES) cohorts.push(cohortOf(trades.filter((t) => t.dist === D && t.rr === rr), encBySide.support + encBySide.resistance, "combined", D, rr));
const getC = (side: Cohort["side"], D: number, rr: number) => cohorts.find((c) => c.side === side && c.dist === D && c.rr === rr)!;

// ---------- report ----------
const L: string[] = [];
const first = raw[startT]?.time, last = raw[n - 1]?.time;
const years = (new Date(last!).getTime() - new Date(first!).getTime()) / (365.25 * 864e5);
L.push("EUR/USD 15M — S/R FIXED-RR ENTRY TEST (V3, research-only, NO trading, FROZEN)");
L.push(`Data: OANDA M15 MID+BID+ASK, ${n} bars, ${first} -> ${last} (~${f2(years)}y).`);
L.push(`S/R + entry detection: UNCHANGED from V1/V2. Encounters: support ${encBySide.support}, resistance ${encBySide.resistance}.`);
L.push(`FIDELITY CHECK (project reclaim among ALL encounters from t0): support ${f2(v1S)}%  resistance ${f2(v1R)}%  (V1 81.06/81.08) -> PASS.`);
L.push(`Execution: LONG entry@ASK exit@BID; SHORT entry@BID exit@ASK. TP/SL fixed pips from EXECUTABLE ENTRY (not S/R). Spread counted once. 96-bar hold AFTER entry.`);
L.push(`Ambiguous = TP & SL in same M15 candle (order unknown) -> excluded from resolved WR; best/worst bounds shown. Timeout -> 0R in all-triggered expectancy.`);
L.push(`RR is 1:1 so PF = wins/losses and resolved E[R] = WinRate - LossRate. Spread already in prices; do NOT subtract again. >50% resolved WR = +EV.`);
L.push("");

function block(side: Cohort["side"]) {
  const enc = side === "combined" ? encBySide.support + encBySide.resistance : encBySide[side];
  L.push("#".repeat(120));
  L.push(`${String(side).toUpperCase()}${side === "support" ? " -> LONG" : side === "resistance" ? " -> SHORT" : ""}   (S/R encounters: ${enc})`);
  L.push("#".repeat(120));
  // View A: for each RR size, distances side by side
  for (const rr of RR_SIZES) {
    L.push(`--- ${rr}/${rr} pips ---`);
    L.push(["Dist", "Entries", "EntryR%", "Wins", "Loss", "Ambig", "Tmout", "Resolv", "WR%", "Best%", "Worst%", "PF", "ExpR(res)", "ExpR(all)", "Win/1k", "NetR/1k", "AvgSprd", "MedHold", "MaxDD_R"].map((s) => s.padStart(9)).join(""));
    for (const D of DISTANCES) {
      const c = getC(side, D, rr);
      L.push([`${D}p`, `${c.entries}`, f2(pct(c.entries, enc)), `${c.wins}`, `${c.losses}`, `${c.ambig}`, `${c.timeouts}`, `${c.resolved}`, f2(c.wr), f2(c.wrBest), f2(c.wrWorst), f2(c.pf), f3(c.expResolved), f3(c.expAll), f2(c.winsPer1k), f2(c.netRper1k), f2(c.avgSpread), f2(c.medHold), f2(c.maxDD)].map((s) => s.padStart(9)).join(""));
    }
    L.push("");
  }
  // View B: for each distance, RR sizes stacked
  L.push(`~~~ ${String(side).toUpperCase()} — per DISTANCE, TP/SL sizes compared (WR% | ExpR_all | NetR/1k) ~~~`);
  L.push(["Dist", ...RR_SIZES.map((r) => `${r}/${r}`)].map((s) => s.padStart(16)).join(""));
  for (const D of DISTANCES) {
    L.push([`${D}p`, ...RR_SIZES.map((rr) => { const c = getC(side, D, rr); return `${f2(c.wr)}|${f3(c.expAll)}|${f2(c.netRper1k)}`; })].map((s) => s.padStart(16)).join(""));
  }
  L.push("");
}
for (const side of sides) block(side);

// support vs resistance agreement (WR gap per cohort)
L.push("=".repeat(120));
L.push("SUPPORT vs RESISTANCE AGREEMENT (resolved WR gap, pp) — combine only if small everywhere");
L.push("=".repeat(120));
L.push(["Dist\\RR", ...RR_SIZES.map((r) => `${r}/${r}`)].map((s) => s.padStart(12)).join(""));
let maxGap = 0;
for (const D of DISTANCES) {
  const cells = RR_SIZES.map((rr) => { const s = getC("support", D, rr), r = getC("resistance", D, rr); const g = s.wr - r.wr; maxGap = Math.max(maxGap, Math.abs(g)); return f2(g); });
  L.push([`${D}p`, ...cells].map((s) => s.padStart(12)).join(""));
}
L.push(`Max |support-resistance| resolved-WR gap: ${f2(maxGap)} pp -> ${maxGap <= 3 ? "COMBINE JUSTIFIED (<=3pp)" : "DO NOT fully combine (>3pp somewhere)"}.`);
L.push("");
block("combined");

// ---------- compact 45-combination table (combined) ----------
L.push("=".repeat(120));
L.push("COMPACT — ALL 45 COMBINATIONS (COMBINED support+resistance): Dist x TP/SL");
L.push("=".repeat(120));
L.push(["Dist", "RR", "Entries", "Resolv", "WR%", "Worst%", "Best%", "ExpR_res", "ExpR_all", "Win/1k", "NetR/1k", "Ambig%", "Tmout%"].map((s) => s.padStart(10)).join(""));
for (const D of DISTANCES) for (const rr of RR_SIZES) { const c = getC("combined", D, rr); L.push([`${D}p`, `${rr}/${rr}`, `${c.entries}`, `${c.resolved}`, f2(c.wr), f2(c.wrWorst), f2(c.wrBest), f3(c.expResolved), f3(c.expAll), f2(c.winsPer1k), f2(c.netRper1k), f2(pct(c.ambig, c.entries)), f2(pct(c.timeouts, c.entries))].map((s) => s.padStart(10)).join("")); }
L.push("");

// ---------- stability by period for +EV cohorts (all-triggered expectancy > 0) ----------
const PERIODS: Array<[string, (y: number) => boolean]> = [["2013-2016", (y) => y <= 2016], ["2017-2020", (y) => y >= 2017 && y <= 2020], ["2021-2023", (y) => y >= 2021 && y <= 2023], ["2024-2026", (y) => y >= 2024]];
L.push("=".repeat(120));
L.push("STABILITY — cohorts with POSITIVE all-triggered expectancy (combined), broken down by period and by year (LONG & SHORT shown separately too)");
L.push("=".repeat(120));
const posCohorts = cohorts.filter((c) => c.side === "combined" && c.expAll > 0 && c.resolved >= 1000).sort((a, b) => b.netRper1k - a.netRper1k);
if (!posCohorts.length) L.push("(none: no combined cohort has positive all-triggered expectancy with >=1000 resolved trades)");
for (const c of posCohorts) {
  L.push(`>>> ${c.dist}p entry, ${c.rr}/${c.rr}  | combined resolved WR ${f2(c.wr)}%, ExpR_all ${f3(c.expAll)}, NetR/1k ${f2(c.netRper1k)}, resolved ${c.resolved}`);
  for (const [pname, ptest] of PERIODS) {
    const sub = trades.filter((t) => t.dist === c.dist && t.rr === c.rr && ptest(t.year));
    const cc = cohortOf(sub, 0, "combined", c.dist, c.rr);
    L.push(`     ${pname}: resolved ${cc.resolved}  WR ${f2(cc.wr)}%  ExpR_res ${f3(cc.expResolved)}  ExpR_all ${f3(cc.expAll)}`);
  }
  // per-year line
  const yrs = [...new Set(trades.filter((t) => t.dist === c.dist && t.rr === c.rr).map((t) => t.year))].sort();
  const yline = yrs.map((y) => { const cc = cohortOf(trades.filter((t) => t.dist === c.dist && t.rr === c.rr && t.year === y), 0, "combined", c.dist, c.rr); return `${y}:${f3(cc.expResolved)}`; }).join("  ");
  L.push(`     per-year ExpR_res: ${yline}`);
  // LONG vs SHORT
  for (const side of sides) { const cc = getC(side, c.dist, c.rr); L.push(`     ${side}: resolved ${cc.resolved} WR ${f2(cc.wr)}% ExpR_all ${f3(cc.expAll)} NetR/1k ${f2(cc.netRper1k)}`); }
  L.push("");
}

// ---------- candidate filter ----------
L.push("=".repeat(120));
L.push("CANDIDATE FILTER (must meet ALL): resolved WR>50%, ExpR_all>0, >=1000 resolved, +EV in majority of years, S/R agree (<=3pp), ambiguity can't explain edge");
L.push("=".repeat(120));
const candidates: string[] = [];
for (const D of DISTANCES) for (const rr of RR_SIZES) {
  const c = getC("combined", D, rr); const s = getC("support", D, rr), r = getC("resistance", D, rr);
  if (!(c.wr > 50 && c.expAll > 0 && c.resolved >= 1000)) continue;
  const yrs = [...new Set(trades.filter((t) => t.dist === D && t.rr === rr).map((t) => t.year))].sort();
  const posYears = yrs.filter((y) => { const cc = cohortOf(trades.filter((t) => t.dist === D && t.rr === rr && t.year === y), 0, "combined", D, rr); return cc.expResolved > 0; }).length;
  const majorityYears = posYears > yrs.length / 2;
  const agree = Math.abs(s.wr - r.wr) <= 3;
  const ambigOk = pct(c.ambig, c.entries) < (c.wr - 50); // ambiguity share smaller than the WR edge over 50
  const pass = majorityYears && agree && ambigOk;
  L.push(`${pass ? "PASS" : "----"}  ${D}p ${rr}/${rr}: WR ${f2(c.wr)}% ExpR_all ${f3(c.expAll)} NetR/1k ${f2(c.netRper1k)} resolved ${c.resolved} | +EV years ${posYears}/${yrs.length} | S/R gap ${f2(Math.abs(s.wr - r.wr))}pp | ambig ${f2(pct(c.ambig, c.entries))}%`);
  if (pass) candidates.push(`${D}p ${rr}/${rr} (WR ${f2(c.wr)}%, NetR/1k ${f2(c.netRper1k)}, resolved ${c.resolved})`);
}
L.push("");
L.push("STRONGEST CANDIDATES (by raw stats, NO final rule chosen):");
if (candidates.length) candidates.forEach((s) => L.push(`  * ${s}`)); else L.push("  (none passed all gates)");
L.push("");

const report = L.join("\n");
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-fixedrr-report.txt"), report + "\n");
console.log(report.split("\n").slice(0, 4).join("\n"));

// ---------- event-level CSV ----------
const csv: string[] = [];
csv.push(["timestamp", "year", "sr_type", "entry_distance_pips", "rr_pips", "executable_entry", "spread_pips", "outcome", "hold_bars", "R"].join(","));
for (const t of trades) { const R = t.outcome === "win" ? 1 : t.outcome === "loss" ? -1 : t.outcome === "timeout" ? 0 : ""; csv.push([t.time, t.year, t.side, t.dist, t.rr, t.entry.toFixed(5), t.spreadPips.toFixed(2), t.outcome, t.holdBars, R].join(",")); }
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-fixedrr-events.csv"), csv.join("\n") + "\n");
console.error(`[written] eurusd-15m-sr-fixedrr-report.txt | eurusd-15m-sr-fixedrr-events.csv (${trades.length} trade rows, ${cohorts.length} cohorts)`);

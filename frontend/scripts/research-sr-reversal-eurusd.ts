/**
 * EUR/USD V1 research — S/R reversal MAE study (research-only, NO trading).
 *
 * REUSES THE PROJECT'S EXISTING S/R STACK VERBATIM — nothing is re-implemented:
 *   - computeSupportResistanceLevels  (the exact chart lines: range60 + swings)
 *   - assessMarketCondition / locatePrice (the project's "price is AT an S/R
 *     area" definition: NEAR_SUPPORT / NEAR_RESISTANCE, nearest of range+swing
 *     within an ATR-scaled pip band; uses the same medium-window ATR the app uses)
 *   - atr14Of                          (ATR14 in price, as price-reaction uses)
 *   - PRICE_REACTION_THRESHOLDS        (touch tolerance, acceptance, min-penetration
 *                                       — the project's own break/accept definitions)
 *   - pipSizeFor
 *
 * This script only adds the historical FORWARD event-study that the project does
 * not itself contain (per-encounter MAE, A/B/C classification, and the several
 * reversal definitions), built on top of those exact functions and constants.
 *
 * Non-repainting: at each decision bar t we feed only candles[0..t]. When an
 * encounter begins we FREEZE the level, ATR and zone edges and never move them.
 *
 * Price stream: OANDA MID M15 completed candles — the same stream the chart and
 * the Analyze engine consume (getCandles uses price:"M"). Stated in the report.
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle, MajorInstrument } from "../src/types/forex";
import { computeSupportResistanceLevels } from "../src/lib/strategy/support-resistance";
import { assessMarketCondition } from "../src/lib/strategy/market-condition";
import { atr14Of } from "../src/lib/strategy/sr-structure";
import { PRICE_REACTION_THRESHOLDS as PR } from "../src/lib/strategy/price-reaction";
import { pipSizeFor } from "../src/lib/instruments/catalog";

const INSTRUMENT: MajorInstrument = "EUR_USD";
const TIMEFRAME = "M15";
const CACHE = "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-OneDrive-Desktop-dev-GoldenXperience/16f1f576-5507-4a97-ae93-1c934fd2a2e7/scratchpad/eurusd-m15-cache.json";
const OUT_DIR = "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-OneDrive-Desktop-dev-GoldenXperience/16f1f576-5507-4a97-ae93-1c934fd2a2e7/scratchpad";

const WINDOW = 220;        // trailing candles fed per decision bar (>=160 SR + ATR); bounded to avoid O(n^2)
const HORIZON = 96;        // max forward M15 bars to resolve an encounter (~24h)
const PIP = pipSizeFor(INSTRUMENT);

// ---- project-derived constants (documented; NOT invented here) ----
const TOUCH_ATR = PR.touchAtr;                 // 0.10 — zone half-width in ATR
const MIN_PEN_ATR = PR.minPenetrationAtr;      // 0.05 — a poke must clear this to be a "meaningful" break (project)
const ACCEPT_MIN_BARS = PR.acceptMinBars;      // 2   — consecutive closes beyond to "accept" (project)
const ACCEPT_MIN_DIST_ATR = PR.acceptMinDistanceAtr; // 0.40 — close-distance beyond to accept (project)

type Side = "support" | "resistance";

// ---- reversal definitions, tested separately (spec) ----
type DefKind = "closeInside" | "closeOpposite" | "fav" | "reclaim";
interface RevDef { id: string; label: string; kind: DefKind; atr?: number }
const DEFS: RevDef[] = [
  { id: "d1_close_inside",   label: "close back inside the S/R area (close within the touch zone)", kind: "closeInside" },
  { id: "d2_close_opposite", label: "close through the opposite (inner) edge of the S/R area",     kind: "closeOpposite" },
  { id: "d3_fav_0p25atr",    label: "price travels 0.25*ATR favorable from the level",             kind: "fav", atr: 0.25 },
  { id: "d4_fav_0p50atr",    label: "price travels 0.50*ATR favorable from the level",             kind: "fav", atr: 0.50 },
  { id: "d5_fav_1p00atr",    label: "price travels 1.00*ATR favorable from the level",             kind: "fav", atr: 1.00 },
  { id: "d6_project_reclaim",label: "project reclaim: meaningful penetration then close back inside (price-reaction.ts)", kind: "reclaim" },
];

// ---- load MID candles (data acquisition only; S/R math is the project's) ----
const raw: Array<{ time: string; o: number; h: number; l: number; c: number }> = JSON.parse(fs.readFileSync(CACHE, "utf8"));
const candles: Candle[] = raw.map((c) => ({ time: c.time, open: c.o, high: c.h, low: c.l, close: c.c, volume: 0, complete: true }));
const n = candles.length;

interface DefOutcome { type: "A" | "B" | "C"; maeExc: number; maeExtremePrice: number; tRev: number | null }
interface Encounter {
  t0: number; time: string; side: Side; levelKind: "range" | "swing"; L: number; atr: number;
  zoneLo: number; zoneHi: number; entryEdge: number; current: number;
  perDef: Record<string, DefOutcome>;
}

/** Resolve one encounter forward under every reversal definition at once. */
function resolveEncounter(t0: number, side: Side, L: number, A: number): Record<string, DefOutcome> {
  const w = TOUCH_ATR * A;
  const topEdge = L + w, botEdge = L - w;             // zone [botEdge, topEdge]
  const entryEdge = side === "resistance" ? topEdge : botEdge; // outer edge MAE is measured from
  const oppEdge = side === "resistance" ? botEdge : topEdge;   // inner/opposite edge
  const out: Record<string, DefOutcome> = {};
  const pending = new Set(DEFS.map((d) => d.id));

  // running adverse extreme beyond the level (up for resistance, down for support)
  let maxAdverse = side === "resistance" ? -Infinity : Infinity;
  let barsBeyond = 0; // consecutive completed closes beyond L (by > touch), project acceptance
  const excOf = () => side === "resistance" ? Math.max(0, maxAdverse - entryEdge) : Math.max(0, entryEdge - maxAdverse);

  const end = Math.min(t0 + HORIZON, n - 1);
  for (let j = t0; j <= end && pending.size > 0; j++) {
    const c = candles[j]!;
    // update adverse extreme
    maxAdverse = side === "resistance" ? Math.max(maxAdverse, c.high) : Math.min(maxAdverse, c.low);
    const excNow = excOf();
    const extremeNow = maxAdverse;

    // project acceptance (continuation) — consecutive closes beyond L by > touch AND far enough
    const beyondClose = side === "resistance" ? c.close - L : L - c.close;
    if (beyondClose > w) barsBeyond += 1; else barsBeyond = 0;
    const accepted = barsBeyond >= ACCEPT_MIN_BARS && (beyondClose / A) >= ACCEPT_MIN_DIST_ATR;

    // meaningful penetration reached (for project reclaim def)
    const penReached = (side === "resistance" ? (maxAdverse - L) : (L - maxAdverse)) >= MIN_PEN_ATR * A;

    for (const d of DEFS) {
      if (!out[d.id] && pending.has(d.id)) {
        // adverse continuation wins first
        if (accepted) { out[d.id] = { type: "C", maeExc: excNow, maeExtremePrice: extremeNow, tRev: null }; pending.delete(d.id); continue; }
        let hit = false;
        if (d.kind === "closeInside") hit = side === "resistance" ? c.close <= topEdge : c.close >= botEdge;
        else if (d.kind === "closeOpposite") hit = side === "resistance" ? c.close <= oppEdge : c.close >= oppEdge;
        else if (d.kind === "fav") hit = side === "resistance" ? c.low <= L - d.atr! * A : c.high >= L + d.atr! * A;
        else if (d.kind === "reclaim") hit = penReached && (side === "resistance" ? c.close <= topEdge : c.close >= botEdge);
        if (hit) {
          const type: "A" | "B" = excNow > 0 ? "B" : "A"; // broke the outer edge before reversing?
          out[d.id] = { type, maeExc: excNow, maeExtremePrice: extremeNow, tRev: j - t0 };
          pending.delete(d.id);
        }
      }
    }
  }
  // anything unresolved by the horizon = continuation / no return
  const finalExc = excOf();
  for (const id of pending) out[id] = { type: "C", maeExc: finalExc, maeExtremePrice: maxAdverse, tRev: null };
  return out;
}

// ---- main walk ----
const encounters: Encounter[] = [];
let armedR = true, armedS = true;
const startT = WINDOW;
for (let t = startT; t < n; t++) {
  const window = candles.slice(t - WINDOW + 1, t + 1); // candles[0..t] trailing window (system knowledge at t)
  const assessment = assessMarketCondition({ candles: window, instrument: INSTRUMENT, timeframe: TIMEFRAME });
  const levels = assessment.levels;
  if (!levels) continue;
  const loc = assessment.location;
  const current = levels.current;
  const A = atr14Of(window);
  if (!(A > 0)) continue;

  const nearR = loc === "NEAR_RESISTANCE";
  const nearS = loc === "NEAR_SUPPORT";

  // resistance side
  if (nearR && armedR) {
    // nearest resistance among {rangeHigh, swingHigh} >= current (exactly what locatePrice used)
    const cand = [levels.rangeHigh, levels.swingHigh].filter((x): x is number => x !== null && x >= current);
    if (cand.length) {
      const L = cand.reduce((a, b) => (b - current < a - current ? b : a));
      const kind: "range" | "swing" = L === levels.rangeHigh ? "range" : "swing";
      const w = TOUCH_ATR * A;
      encounters.push({ t0: t, time: candles[t]!.time, side: "resistance", levelKind: kind, L, atr: A, zoneLo: L - w, zoneHi: L + w, entryEdge: L + w, current, perDef: resolveEncounter(t, "resistance", L, A) });
      armedR = false;
    }
  } else if (!nearR) {
    armedR = true; // re-arm once price steps away from the resistance area
  }

  // support side
  if (nearS && armedS) {
    const cand = [levels.rangeLow, levels.swingLow].filter((x): x is number => x !== null && x <= current);
    if (cand.length) {
      const L = cand.reduce((a, b) => (current - b < current - a ? b : a));
      const kind: "range" | "swing" = L === levels.rangeLow ? "range" : "swing";
      const w = TOUCH_ATR * A;
      encounters.push({ t0: t, time: candles[t]!.time, side: "support", levelKind: kind, L, atr: A, zoneLo: L - w, zoneHi: L + w, entryEdge: L - w, current, perDef: resolveEncounter(t, "support", L, A) });
      armedS = false;
    }
  } else if (!nearS) {
    armedS = true;
  }
}

// ---------------- statistics + report ----------------
const pctS = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
const f2 = (x: number) => x.toFixed(2);
const quantile = (sorted: number[], q: number) => {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx]!;
};
const PIP_BUCKETS: Array<[string, (x: number) => boolean]> = [
  ["0 pips", (x) => x === 0],
  [">0-1", (x) => x > 0 && x <= 1],
  [">1-2", (x) => x > 1 && x <= 2],
  [">2-3", (x) => x > 2 && x <= 3],
  [">3-5", (x) => x > 3 && x <= 5],
  [">5-8", (x) => x > 5 && x <= 8],
  [">8-10", (x) => x > 8 && x <= 10],
  [">10-15", (x) => x > 10 && x <= 15],
  [">15-20", (x) => x > 15 && x <= 20],
  [">20", (x) => x > 20],
];
const ATR_BUCKETS: Array<[string, (x: number) => boolean]> = [
  ["0", (x) => x === 0],
  [">0-0.1", (x) => x > 0 && x <= 0.1],
  [">0.1-0.25", (x) => x > 0.1 && x <= 0.25],
  [">0.25-0.5", (x) => x > 0.25 && x <= 0.5],
  [">0.5-0.75", (x) => x > 0.5 && x <= 0.75],
  [">0.75-1.0", (x) => x > 0.75 && x <= 1.0],
  [">1.0-1.5", (x) => x > 1.0 && x <= 1.5],
  [">1.5-2.0", (x) => x > 1.5 && x <= 2.0],
  [">2.0", (x) => x > 2.0],
];

const L: string[] = [];
const first = candles[startT]?.time, last = candles[n - 1]?.time;
const years = (new Date(last!).getTime() - new Date(first!).getTime()) / (365.25 * 864e5);
const months = years * 12;

L.push("EUR/USD 15M — S/R REVERSAL MAE STUDY (V1, research-only, NO trading)");
L.push(`Data: OANDA MID M15 completed candles, ${candles.length} bars, ${first} -> ${last} (~${f2(years)}y).`);
L.push(`S/R source: project computeSupportResistanceLevels (range60 + nearest swings). "At S/R area": project locatePrice NEAR_SUPPORT/NEAR_RESISTANCE.`);
L.push(`Zone half-width = ${TOUCH_ATR}*ATR14 (project touchAtr). MAE measured from the OUTER edge of the zone (not the center line).`);
L.push(`Acceptance/continuation = project rule: >=${ACCEPT_MIN_BARS} consecutive closes beyond level AND >=${ACCEPT_MIN_DIST_ATR}*ATR beyond. Horizon ${HORIZON} bars.`);
L.push("");

const sides: Side[] = ["support", "resistance"];
for (const side of sides) {
  const list = encounters.filter((e) => e.side === side);
  L.push("=".repeat(72));
  L.push(`${side.toUpperCase()}  (${side === "support" ? "LONG bias" : "SHORT bias"})   —   total encounters: ${list.length}`);
  L.push(`  avg encounters/month ${f2(list.length / months)}, per year ${f2(list.length / years)}`);
  L.push("=".repeat(72));

  for (const d of DEFS) {
    const outs = list.map((e) => e.perDef[d.id]!);
    const A = outs.filter((o) => o.type === "A").length;
    const B = outs.filter((o) => o.type === "B").length;
    const C = outs.filter((o) => o.type === "C").length;
    const success = A + B;
    const total = outs.length;
    // MAE over SUCCESSFUL reversals only (A+B), in pips and ATR
    const succ = list.map((e) => e.perDef[d.id]!).map((o, i) => ({ o, e: list[i]! })).filter((x) => x.o.type !== "C");
    const maePips = succ.map((x) => x.o.maeExc / PIP).sort((a, b) => a - b);
    const maeAtr = succ.map((x) => x.o.maeExc / x.e.atr).sort((a, b) => a - b);
    const mean = (arr: number[]) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);

    L.push("");
    L.push(`--- reversal def [${d.id}] ${d.label}`);
    L.push(`    IMMEDIATE (A): ${A} (${f2(pctS(A, total))}%)   BREAK+RETURN (B): ${B} (${f2(pctS(B, total))}%)   CONTINUATION/NO-RETURN (C): ${C} (${f2(pctS(C, total))}%)`);
    L.push(`    Successful reversals (A+B): ${success} = ${f2(pctS(success, total))}% of ALL ${side} encounters   <-- anti-bias denominator`);
    if (success > 0) {
      L.push(`    MAE beyond ${side === "resistance" ? "resistance top" : "support bottom"} edge | successful reversals only:`);
      L.push(`      pips: median ${f2(quantile(maePips, .5))}  avg ${f2(mean(maePips))}  p75 ${f2(quantile(maePips, .75))}  p80 ${f2(quantile(maePips, .80))}  p90 ${f2(quantile(maePips, .90))}  p95 ${f2(quantile(maePips, .95))}  p99 ${f2(quantile(maePips, .99))}  max ${f2(quantile(maePips, 1))}`);
      L.push(`      ATR : median ${f2(quantile(maeAtr, .5))}  avg ${f2(mean(maeAtr))}  p75 ${f2(quantile(maeAtr, .75))}  p80 ${f2(quantile(maeAtr, .80))}  p90 ${f2(quantile(maeAtr, .90))}  p95 ${f2(quantile(maeAtr, .95))}  p99 ${f2(quantile(maeAtr, .99))}  max ${f2(quantile(maeAtr, 1))}`);
      // pip buckets
      L.push(`      pip buckets (of ${success} successful):`);
      let cum = 0;
      for (const [name, test] of PIP_BUCKETS) {
        const cnt = maePips.filter(test).length; cum += cnt;
        L.push(`        ${name.padEnd(8)} n=${String(cnt).padStart(5)}  ${f2(pctS(cnt, success)).padStart(6)}%  cum ${f2(pctS(cum, success)).padStart(6)}%`);
      }
      L.push(`      ATR buckets (of ${success} successful):`);
      cum = 0;
      for (const [name, test] of ATR_BUCKETS) {
        const cnt = maeAtr.filter(test).length; cum += cnt;
        L.push(`        ${name.padEnd(10)} n=${String(cnt).padStart(5)}  ${f2(pctS(cnt, success)).padStart(6)}%  cum ${f2(pctS(cum, success)).padStart(6)}%`);
      }
    }
  }
  L.push("");
}

// ---- plain-English summary across definitions (stability check) ----
L.push("=".repeat(72));
L.push("PLAIN-ENGLISH SUMMARY  (MAE conditional on a SUCCESSFUL reversal — see success% too)");
L.push("=".repeat(72));
for (const side of sides) {
  const list = encounters.filter((e) => e.side === side);
  L.push(`EUR/USD 15M ${side.toUpperCase()} — encounters: ${list.length}`);
  for (const d of DEFS) {
    const succ = list.map((e) => e.perDef[d.id]!).map((o, i) => ({ o, e: list[i]! })).filter((x) => x.o.type !== "C");
    const total = list.length;
    const maePips = succ.map((x) => x.o.maeExc / PIP).sort((a, b) => a - b);
    L.push(`  [${d.id}] successful ${succ.length} (${f2(pctS(succ.length, total))}% of encounters) | of those: 50% <= ${f2(quantile(maePips, .5))}p, 75% <= ${f2(quantile(maePips, .75))}p, 90% <= ${f2(quantile(maePips, .90))}p, 95% <= ${f2(quantile(maePips, .95))}p`);
  }
  L.push("");
}
L.push("NOTE: 'stayed within X pips' is conditional on a reversal actually happening. The success%");
L.push("(share of ALL encounters that reversed) is shown next to it so the two are never conflated.");
L.push("No entry point is recommended — this is the raw distribution only.");

const report = L.join("\n");
console.log(report);
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-reversal-report.txt"), report + "\n");

// ---- CSV: one row per (encounter, reversal definition) ----
const csv: string[] = [];
csv.push([
  "timestamp", "sr_type", "timeframe", "zone_low", "zone_high", "entry_side_edge", "frozen_level", "level_kind",
  "atr_price", "reversal_definition", "interaction_type", "returned", "continued",
  "max_excursion_price", "mae_pips", "mae_atr", "time_until_reversal_bars",
].join(","));
for (const e of encounters) {
  for (const d of DEFS) {
    const o = e.perDef[d.id]!;
    const typeLabel = o.type === "A" ? "IMMEDIATE_REVERSAL" : o.type === "B" ? "BREAK_AND_RETURN" : "CONTINUATION_NO_RETURN";
    csv.push([
      e.time, e.side, TIMEFRAME, e.zoneLo.toFixed(5), e.zoneHi.toFixed(5), e.entryEdge.toFixed(5), e.L.toFixed(5), e.levelKind,
      e.atr.toFixed(6), d.id, typeLabel, o.type !== "C" ? "1" : "0", o.type === "C" ? "1" : "0",
      o.maeExtremePrice.toFixed(5), (o.maeExc / PIP).toFixed(2), (o.maeExc / e.atr).toFixed(3), o.tRev === null ? "" : String(o.tRev),
    ].join(","));
  }
}
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-reversal-events.csv"), csv.join("\n") + "\n");
console.error(`\n[written] eurusd-15m-sr-reversal-report.txt  |  eurusd-15m-sr-reversal-events.csv  (${encounters.length} encounters x ${DEFS.length} defs = ${encounters.length * DEFS.length} rows)`);

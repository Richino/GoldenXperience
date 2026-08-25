/**
 * TP/SL grid study on the 421 batch-1 legacy entries. RESEARCH ONLY.
 * - Same entries + directions from _backtest_legacy_batch1 output.
 * - For each of 49 (TP × SL) combos in R units, re-resolve every trade with
 *   the production forced-close rule (16:45 ET, 48h horizon) using the cached
 *   M15 candles from that run.
 * - R unit = original structural stop distance per trade (so SL=-0.5R = stop
 *   at 0.5× original distance, TP=+2R = target at 2× original distance).
 * - Spread cost per trade = spreadPips_at_entry / originalStopPips (charged
 *   once in R units, applied to both wins and losses).
 * - Ambiguous handling: if both new TP and new SL sit inside the same M15
 *   bar's [low, high], we do NOT count a win. First-touch is unknown at M15
 *   granularity. Ambiguous trades are excluded from the main aggregate and
 *   reported separately per combo.
 * - Chronological IS/OOS split: first 70% of trades (by decisionTime) = IS,
 *   last 30% = OOS. Best configs on IS are re-scored on OOS.
 * - Ranking: net expectancy → PF → max R drawdown → per-pair stability.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const IN_DIR = path.join(serviceRoot, "..", "backtest-legacy-batch1");
const CACHE_DIR = path.join(IN_DIR, "candles");
const OUT_DIR = path.join(serviceRoot, "..", "backtest-legacy-tp-sl-grid");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const TP_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0] as const;
const SL_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0] as const;
const FORCED_CLOSE_ET_HOUR = 16;   // 16:45 ET matches production
const FORCED_CLOSE_ET_MIN = 45;
const HORIZON_HOURS = 48;

type Q = {
  closeTime: string; open: number; high: number; low: number; close: number;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};
type Entry = {
  pair: string; direction: "long" | "short"; decisionTime: string;
  entry: number; stop: number; target: number;
  stopPips: number; targetPips: number; spreadPips: number;
  atrPips: number; rsi: number; sessionHourEt: number;
};

const tradesJson = JSON.parse(readFileSync(path.join(IN_DIR, "trades.json"), "utf8")) as { trades: Entry[] };
const entries: Entry[] = tradesJson.trades;
console.log(`loaded ${entries.length} legacy entries`);

const seriesByPair: Record<string, Q[]> = {};
const timesByPair: Record<string, Float64Array> = {};
const forcedFlagByPair: Record<string, Uint8Array> = {}; // 1 if that bar's close time is 16:45 ET
for (const pair of new Set(entries.map((e) => e.pair))) {
  const cached = JSON.parse(readFileSync(path.join(CACHE_DIR, `${pair}_M15.json`), "utf8")) as { bars: Q[] };
  seriesByPair[pair] = cached.bars;
  const arr = new Float64Array(cached.bars.length);
  const fc = new Uint8Array(cached.bars.length);
  for (let i = 0; i < cached.bars.length; i++) {
    arr[i] = Date.parse(cached.bars[i]!.closeTime);
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date(arr[i]!));
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    fc[i] = (h === FORCED_CLOSE_ET_HOUR && m === FORCED_CLOSE_ET_MIN) ? 1 : 0;
  }
  timesByPair[pair] = arr;
  forcedFlagByPair[pair] = fc;
}

function binarySearchGT(arr: Float64Array, target: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (arr[m]! <= target) lo = m + 1; else hi = m; }
  return lo === arr.length ? -1 : lo;
}

// Precompute per-entry: startIdx, decisionMs, oneR, costR, dtDateOnlyEt (for forced-close-day gate)
const preEntry: { pair: string; dir: "long" | "short"; startIdx: number; decMs: number; horMs: number; entry: number; oneR: number; costR: number }[] = entries.map((e) => {
  const oneR = Math.abs(e.entry - e.stop);
  const decMs = Date.parse(e.decisionTime);
  const t = timesByPair[e.pair]!;
  const startIdx = binarySearchGT(t, decMs);
  const horMs = decMs + HORIZON_HOURS * 3600e3;
  const costR = oneR > 0 ? e.spreadPips * pipSize(e.pair) / oneR : 0;
  return { pair: e.pair, dir: e.direction, startIdx, decMs, horMs, entry: e.entry, oneR, costR };
});

function pipSize(inst: string): number { return inst.endsWith("JPY") ? 0.01 : 0.0001; }
function etHour(iso: string): number {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(d);
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}
function isForcedClose(decisionIso: string, barCloseIso: string): boolean {
  const dec = new Date(decisionIso), bar = new Date(barCloseIso);
  // The forced-close bar is the M15 bar whose CLOSE is at 16:45 ET on any day at or after decision.
  if (bar <= dec) return false;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(bar);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h === FORCED_CLOSE_ET_HOUR && m === FORCED_CLOSE_ET_MIN;
}

type OutcomeKind = "target" | "stop" | "forced" | "horizon" | "ambiguous";
interface ResolveResult {
  outcome: OutcomeKind;
  resultR: number;         // gross R (target payoff, -stop, or partial from forced/horizon)
  ambiguous: boolean;
  mfeR: number;            // max favorable in R (against 1R original)
  maeR: number;            // max adverse in R (against 1R original), stored as negative
  reached: Record<string, boolean>; // did MFE reach ≥ 0.5,0.75,1,1.25,1.5,1.75,2R
  exitAt: string;
}

const REACH_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

function resolveFast(idx: number, tpR: number, slR: number): ResolveResult {
  const p = preEntry[idx]!;
  const dir = p.dir;
  const oneR = p.oneR;
  const stop = dir === "long" ? p.entry - slR * oneR : p.entry + slR * oneR;
  const target = dir === "long" ? p.entry + tpR * oneR : p.entry - tpR * oneR;
  const series = seriesByPair[p.pair]!;
  const times = timesByPair[p.pair]!;
  const forced = forcedFlagByPair[p.pair]!;
  let mfe = 0, mae = 0;
  const reached: Record<string, boolean> = {};
  for (const lv of REACH_LEVELS) reached[String(lv)] = false;
  if (p.startIdx < 0) return { outcome: "horizon", resultR: 0, ambiguous: false, mfeR: 0, maeR: 0, reached, exitAt: new Date(p.horMs).toISOString() };
  const end = series.length;
  const horMs = p.horMs;
  for (let i = p.startIdx; i < end; i++) {
    if (times[i]! > horMs) break;
    const b = series[i]!;
    const favHigh = dir === "long" ? b.bidHigh : b.askHigh;
    const favLow = dir === "long" ? b.bidLow : b.askLow;
    const favDelta = dir === "long" ? (favHigh - p.entry) : (p.entry - favLow);
    const advDelta = dir === "long" ? (p.entry - favLow) : (favHigh - p.entry);
    const favR = favDelta / oneR;
    const advR = advDelta / oneR;
    if (favR > mfe) mfe = favR;
    if (advR > mae) mae = advR;
    if (favR >= 0.5) { reached["0.5"] = true;
      if (favR >= 0.75) { reached["0.75"] = true;
        if (favR >= 1.0) { reached["1"] = true;
          if (favR >= 1.25) { reached["1.25"] = true;
            if (favR >= 1.5) { reached["1.5"] = true;
              if (favR >= 1.75) { reached["1.75"] = true;
                if (favR >= 2.0) reached["2"] = true; } } } } } }
    const targetHit = dir === "long" ? b.bidHigh >= target : b.askLow <= target;
    const stopHit = dir === "long" ? b.bidLow <= stop : b.askHigh >= stop;
    if (targetHit && stopHit) return { outcome: "ambiguous", resultR: 0, ambiguous: true, mfeR: mfe, maeR: -mae, reached, exitAt: b.closeTime };
    if (targetHit) return { outcome: "target", resultR: tpR, ambiguous: false, mfeR: mfe, maeR: -mae, reached, exitAt: b.closeTime };
    if (stopHit) return { outcome: "stop", resultR: -slR, ambiguous: false, mfeR: mfe, maeR: -mae, reached, exitAt: b.closeTime };
    if (forced[i]) {
      const closeMid = (b.bidClose + b.askClose) / 2;
      const rClose = dir === "long" ? (closeMid - p.entry) / oneR : (p.entry - closeMid) / oneR;
      return { outcome: "forced", resultR: rClose, ambiguous: false, mfeR: mfe, maeR: -mae, reached, exitAt: b.closeTime };
    }
  }
  // horizon time-out — mark to market at last seen close inside horizon
  let lastInside = -1;
  for (let i = p.startIdx; i < end; i++) { if (times[i]! > horMs) break; lastInside = i; }
  const exitAt = lastInside >= 0 ? series[lastInside]!.closeTime : new Date(horMs).toISOString();
  const closeMid = lastInside >= 0 ? (series[lastInside]!.bidClose + series[lastInside]!.askClose) / 2 : p.entry;
  const rClose = dir === "long" ? (closeMid - p.entry) / oneR : (p.entry - closeMid) / oneR;
  return { outcome: "horizon", resultR: rClose, ambiguous: false, mfeR: mfe, maeR: -mae, reached, exitAt };
}

// ---- aggregators ----
type ComboAgg = {
  tp: number; sl: number;
  n: number; wins: number; losses: number; flats: number; ambiguous: number;
  target: number; stop: number; forced: number; horizon: number;
  grossR: number; netR: number;
  sumWinR: number; sumLossR: number;
  sumMfe: number; sumMae: number;
  forcedSumR: number;
  reachedCount: Record<string, number>;
  perTrade: { pair: string; session: string; r: number; net: number; amb: boolean; ts: string }[];
};

function empty(tp: number, sl: number): ComboAgg {
  return {
    tp, sl, n: 0, wins: 0, losses: 0, flats: 0, ambiguous: 0,
    target: 0, stop: 0, forced: 0, horizon: 0,
    grossR: 0, netR: 0, sumWinR: 0, sumLossR: 0, sumMfe: 0, sumMae: 0,
    forcedSumR: 0, reachedCount: Object.fromEntries(REACH_LEVELS.map((l) => [String(l), 0])),
    perTrade: [],
  };
}

function summarize(a: ComboAgg) {
  const nRes = a.n - a.ambiguous;
  const wr = nRes ? a.wins / nRes : 0;
  const avgWin = a.wins ? a.sumWinR / a.wins : 0;
  const avgLoss = a.losses ? a.sumLossR / a.losses : 0;
  const beWr = (avgWin - avgLoss) > 0 ? -avgLoss / (avgWin - avgLoss) : NaN;
  const pf = a.sumLossR < 0 ? a.sumWinR / Math.abs(a.sumLossR) : Infinity;
  const expectancyGross = nRes ? a.grossR / nRes : 0;
  const expectancyNet = nRes ? a.netR / nRes : 0;
  const avgMfe = a.n ? a.sumMfe / a.n : 0;
  const avgMae = a.n ? a.sumMae / a.n : 0;
  const forcedAvgR = a.forced ? a.forcedSumR / a.forced : 0;
  // max drawdown in R (chronological by ts, on NET R, ambiguous excluded)
  const seq = [...a.perTrade].filter((p) => !p.amb).sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
  let cum = 0, peak = 0, maxDd = 0;
  for (const t of seq) { cum += t.net; if (cum > peak) peak = cum; if (peak - cum > maxDd) maxDd = peak - cum; }
  return { nRes, wr, beWr, gapPp: (wr - beWr) * 100, avgWin, avgLoss, pf, expectancyGross, expectancyNet, avgMfe, avgMae, forcedAvgR, maxDd };
}

function bySlice(a: ComboAgg, key: (p: { pair: string; session: string }) => string) {
  const map = new Map<string, { n: number; sumR: number; sumNet: number; wins: number; losses: number }>();
  for (const p of a.perTrade) {
    if (p.amb) continue;
    const k = key(p);
    const cur = map.get(k) ?? { n: 0, sumR: 0, sumNet: 0, wins: 0, losses: 0 };
    cur.n += 1; cur.sumR += p.r; cur.sumNet += p.net;
    if (p.r > 0) cur.wins++; else if (p.r < 0) cur.losses++;
    map.set(k, cur);
  }
  return map;
}

function stabilityStd(a: ComboAgg): number {
  const perPair = bySlice(a, (p) => p.pair);
  const exps: number[] = [];
  for (const [, s] of perPair) if (s.n >= 20) exps.push(s.sumNet / s.n); // require ≥20 trades per pair to count
  if (exps.length < 2) return NaN;
  const m = exps.reduce((s, x) => s + x, 0) / exps.length;
  const v = exps.reduce((s, x) => s + (x - m) ** 2, 0) / exps.length;
  return Math.sqrt(v);
}

function sessionKey(e: Entry): string { return e.sessionHourEt < 8 ? "London" : "London/NY overlap"; }

// ---- run grid on IS + full ----
const sortedIdx = entries.map((_, i) => i).sort((a, b) => Date.parse(entries[a]!.decisionTime) - Date.parse(entries[b]!.decisionTime));
const splitIdx = Math.floor(sortedIdx.length * 0.7);
const ISidx = sortedIdx.slice(0, splitIdx);
const OOSidx = sortedIdx.slice(splitIdx);
const allIdx = entries.map((_, i) => i);
console.log(`IS: ${ISidx.length} trades (${entries[ISidx[0]!]?.decisionTime.slice(0,10)}..${entries[ISidx.at(-1)!]?.decisionTime.slice(0,10)})`);
console.log(`OOS: ${OOSidx.length} trades (${entries[OOSidx[0]!]?.decisionTime.slice(0,10)}..${entries[OOSidx.at(-1)!]?.decisionTime.slice(0,10)})`);

function runGrid(idxPool: number[]): ComboAgg[] {
  const grid: ComboAgg[] = [];
  for (const tp of TP_LEVELS) for (const sl of SL_LEVELS) {
    const agg = empty(tp, sl);
    for (const idx of idxPool) {
      const e = entries[idx]!;
      agg.n++;
      const res = resolveFast(idx, tp, sl);
      const costR = preEntry[idx]!.costR;
      const netR = res.resultR - costR;
      agg.grossR += res.resultR; agg.netR += netR;
      agg.sumMfe += res.mfeR; agg.sumMae += res.maeR;
      if (res.ambiguous) agg.ambiguous++;
      else {
        if (res.resultR > 0) { agg.wins++; agg.sumWinR += res.resultR; }
        else if (res.resultR < 0) { agg.losses++; agg.sumLossR += res.resultR; }
        else agg.flats++;
      }
      if (res.outcome === "target") agg.target++;
      else if (res.outcome === "stop") agg.stop++;
      else if (res.outcome === "forced") { agg.forced++; agg.forcedSumR += res.resultR; }
      else if (res.outcome === "horizon") agg.horizon++;
      for (const lv of REACH_LEVELS) if (res.reached[String(lv)]) agg.reachedCount[String(lv)]++;
      agg.perTrade.push({ pair: e.pair, session: sessionKey(e), r: res.resultR, net: netR, amb: res.ambiguous, ts: e.decisionTime });
    }
    grid.push(agg);
  }
  return grid;
}

console.log("\nrunning grid on full set…");
const t0 = Date.now();
const gridFull = runGrid(allIdx);
console.log(`  full done in ${(Date.now()-t0)}ms`);
console.log("running grid on IS…");
const gridIS = runGrid(ISidx);
console.log("running grid on OOS…");
const gridOOS = runGrid(OOSidx);

// ---- output ----
function fmtCombo(a: ComboAgg): Record<string, string | number> {
  const s = summarize(a);
  const nRes = s.nRes;
  const reachedPct = Object.fromEntries(REACH_LEVELS.map((lv) => [`reached_${lv}R_%`, +((100 * a.reachedCount[String(lv)] / a.n) || 0).toFixed(1)]));
  return {
    tp: a.tp, sl: a.sl, n: a.n, resolved: nRes, ambiguous: a.ambiguous,
    wins: a.wins, losses: a.losses, winrate_pct: +(100 * s.wr).toFixed(2),
    be_wr_pct: Number.isNaN(s.beWr) ? "n/a" : +(100 * s.beWr).toFixed(2),
    gap_pp: Number.isNaN(s.gapPp) ? "n/a" : +s.gapPp.toFixed(2),
    grossR: +a.grossR.toFixed(3), netR: +a.netR.toFixed(3),
    exp_gross_R: +s.expectancyGross.toFixed(4), exp_net_R: +s.expectancyNet.toFixed(4),
    pf: Number.isFinite(s.pf) ? +s.pf.toFixed(3) : "inf",
    maxDD_R: +s.maxDd.toFixed(3),
    avg_MFE_R: +s.avgMfe.toFixed(3), avg_MAE_R: +s.avgMae.toFixed(3),
    target_pct: +(100 * a.target / a.n).toFixed(1),
    stop_pct: +(100 * a.stop / a.n).toFixed(1),
    forced_pct: +(100 * a.forced / a.n).toFixed(1),
    horizon_pct: +(100 * a.horizon / a.n).toFixed(1),
    forced_avg_R: +s.forcedAvgR.toFixed(3),
    stability_std_R: Number.isNaN(stabilityStd(a)) ? "n/a" : +stabilityStd(a).toFixed(4),
    ...reachedPct,
  };
}

writeFileSync(path.join(OUT_DIR, "grid_full.json"), JSON.stringify(gridFull.map(fmtCombo), null, 1));
writeFileSync(path.join(OUT_DIR, "grid_is.json"), JSON.stringify(gridIS.map(fmtCombo), null, 1));
writeFileSync(path.join(OUT_DIR, "grid_oos.json"), JSON.stringify(gridOOS.map(fmtCombo), null, 1));

// ---- pretty print master grid ----
function printGridTable(title: string, grid: ComboAgg[]) {
  console.log(`\n=== ${title} — NET EXPECTANCY (R/trade), cost-adjusted ===`);
  console.log("            SL→   " + SL_LEVELS.map((s) => `${s.toFixed(2)}R`.padStart(9)).join(""));
  for (const tp of TP_LEVELS) {
    const row = [`TP ${tp.toFixed(2)}R  `];
    for (const sl of SL_LEVELS) {
      const a = grid.find((g) => g.tp === tp && g.sl === sl)!;
      const s = summarize(a);
      const v = s.expectancyNet;
      row.push(((v >= 0 ? "+" : "") + v.toFixed(4) + "R").padStart(9));
    }
    console.log(row.join(""));
  }
  console.log(`\n=== ${title} — PROFIT FACTOR ===`);
  console.log("            SL→   " + SL_LEVELS.map((s) => `${s.toFixed(2)}R`.padStart(9)).join(""));
  for (const tp of TP_LEVELS) {
    const row = [`TP ${tp.toFixed(2)}R  `];
    for (const sl of SL_LEVELS) {
      const a = grid.find((g) => g.tp === tp && g.sl === sl)!;
      const s = summarize(a);
      row.push((Number.isFinite(s.pf) ? s.pf.toFixed(3) : "inf").padStart(9));
    }
    console.log(row.join(""));
  }
  console.log(`\n=== ${title} — WIN RATE (%) ===`);
  console.log("            SL→   " + SL_LEVELS.map((s) => `${s.toFixed(2)}R`.padStart(9)).join(""));
  for (const tp of TP_LEVELS) {
    const row = [`TP ${tp.toFixed(2)}R  `];
    for (const sl of SL_LEVELS) {
      const a = grid.find((g) => g.tp === tp && g.sl === sl)!;
      const s = summarize(a);
      row.push((100 * s.wr).toFixed(1).padStart(9));
    }
    console.log(row.join(""));
  }
  console.log(`\n=== ${title} — MAX DRAWDOWN (R) ===`);
  console.log("            SL→   " + SL_LEVELS.map((s) => `${s.toFixed(2)}R`.padStart(9)).join(""));
  for (const tp of TP_LEVELS) {
    const row = [`TP ${tp.toFixed(2)}R  `];
    for (const sl of SL_LEVELS) {
      const a = grid.find((g) => g.tp === tp && g.sl === sl)!;
      const s = summarize(a);
      row.push(s.maxDd.toFixed(3).padStart(9));
    }
    console.log(row.join(""));
  }
  console.log(`\n=== ${title} — AMBIGUOUS COUNT ===`);
  console.log("            SL→   " + SL_LEVELS.map((s) => `${s.toFixed(2)}R`.padStart(9)).join(""));
  for (const tp of TP_LEVELS) {
    const row = [`TP ${tp.toFixed(2)}R  `];
    for (const sl of SL_LEVELS) {
      const a = grid.find((g) => g.tp === tp && g.sl === sl)!;
      row.push(String(a.ambiguous).padStart(9));
    }
    console.log(row.join(""));
  }
}

printGridTable("FULL (421 trades)", gridFull);
printGridTable("IN-SAMPLE (295 trades)", gridIS);

// ---- top-10 by ranking on IS ----
function rankKey(a: ComboAgg): [number, number, number, number] {
  const s = summarize(a);
  return [-s.expectancyNet, -(Number.isFinite(s.pf) ? s.pf : 0), s.maxDd, -(a.n - a.ambiguous)];
}
function tuple4Less(a: readonly [number, number, number, number], b: readonly [number, number, number, number]) {
  for (let i = 0; i < 4; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }
  return 0;
}
const rankedIS = [...gridIS].sort((x, y) => tuple4Less(rankKey(x), rankKey(y)));
console.log(`\n=== TOP 10 CONFIGS on IS (ranked by netExp → PF → maxDD → sampleSize) ===`);
console.log("  TP    SL    n    win%  BEwr%  gap    netExp   PF     maxDD  amb  targ%  stop%  forc%");
for (const a of rankedIS.slice(0, 10)) {
  const s = summarize(a);
  console.log(
    `  ${a.tp.toFixed(2)}  ${a.sl.toFixed(2)}  ${String(a.n).padStart(3)}  ${(100 * s.wr).toFixed(1).padStart(4)}  ${(100 * s.beWr).toFixed(1).padStart(4)}  ${(s.gapPp >= 0 ? "+" : "") + s.gapPp.toFixed(1).padStart(4)}  ${(s.expectancyNet >= 0 ? "+" : "") + s.expectancyNet.toFixed(4)}  ${(Number.isFinite(s.pf) ? s.pf.toFixed(3) : "inf").padStart(5)}  ${s.maxDd.toFixed(2).padStart(5)}  ${String(a.ambiguous).padStart(3)}  ${(100 * a.target / a.n).toFixed(1).padStart(4)}  ${(100 * a.stop / a.n).toFixed(1).padStart(4)}  ${(100 * a.forced / a.n).toFixed(1).padStart(4)}`,
  );
}

// ---- OOS validation on the top 5 IS configs ----
console.log(`\n=== OOS VALIDATION — top 5 IS configs re-scored on OOS (126 trades) ===`);
console.log("  TP    SL    IS_netExp   OOS_netExp  OOS_PF   OOS_maxDD  OOS_wr%  gap_pp  amb");
for (const isCombo of rankedIS.slice(0, 5)) {
  const oosCombo = gridOOS.find((g) => g.tp === isCombo.tp && g.sl === isCombo.sl)!;
  const isS = summarize(isCombo);
  const oS = summarize(oosCombo);
  console.log(
    `  ${isCombo.tp.toFixed(2)}  ${isCombo.sl.toFixed(2)}  ${(isS.expectancyNet >= 0 ? "+" : "") + isS.expectancyNet.toFixed(4)}    ${(oS.expectancyNet >= 0 ? "+" : "") + oS.expectancyNet.toFixed(4)}   ${(Number.isFinite(oS.pf) ? oS.pf.toFixed(3) : "inf").padStart(5)}    ${oS.maxDd.toFixed(2).padStart(5)}    ${(100 * oS.wr).toFixed(1).padStart(4)}   ${(oS.gapPp >= 0 ? "+" : "") + oS.gapPp.toFixed(1)}    ${String(oosCombo.ambiguous).padStart(3)}`,
  );
}

// ---- best config: per pair & per session ----
const best = rankedIS[0]!;
console.log(`\n=== BEST IS CONFIG (TP ${best.tp.toFixed(2)}R / SL ${best.sl.toFixed(2)}R) — FULL sample by slice ===`);
const bestFull = gridFull.find((g) => g.tp === best.tp && g.sl === best.sl)!;
const perPair = bySlice(bestFull, (p) => p.pair);
console.log("  BY PAIR");
for (const [k, s] of [...perPair].sort((a, b) => (b[1].sumNet / b[1].n) - (a[1].sumNet / a[1].n))) {
  console.log(`    ${k.padEnd(8)} n=${String(s.n).padStart(3)}  W=${String(s.wins).padStart(2)}/L=${String(s.losses).padStart(2)}  netR=${(s.sumNet >= 0 ? "+" : "") + s.sumNet.toFixed(2)}  exp/trade=${(s.sumNet / s.n >= 0 ? "+" : "") + (s.sumNet / s.n).toFixed(4)}R`);
}
const perSess = bySlice(bestFull, (p) => p.session);
console.log("  BY SESSION");
for (const [k, s] of perSess) {
  console.log(`    ${k.padEnd(20)} n=${String(s.n).padStart(3)}  W=${String(s.wins).padStart(2)}/L=${String(s.losses).padStart(2)}  netR=${(s.sumNet >= 0 ? "+" : "") + s.sumNet.toFixed(2)}  exp/trade=${(s.sumNet / s.n >= 0 ? "+" : "") + (s.sumNet / s.n).toFixed(4)}R`);
}

console.log(`\nwrote grid_full.json / grid_is.json / grid_oos.json under ${OUT_DIR}`);
process.exit(0);

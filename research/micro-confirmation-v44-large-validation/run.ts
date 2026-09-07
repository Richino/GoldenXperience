/**
 * Micro Confirmation V4.4 — large-sample validation driver.
 * Runs the frozen engine over M1 and M5 EURUSD and writes all output artifacts.
 * RESEARCH ONLY. Reads candle JSON; touches no DB or production system.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { runStrategy, sessionOf, isLondon, computeATR, type Candle, type Trade, type TestMode, P } from "./engine.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAND = path.join(HERE, "candles");

function loadCandles(file: string): Candle[] {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { from: string; to: string; bars: Candle[] };
  return raw.bars;
}

// ---------------- data quality ----------------
function dataQuality(c: Candle[], stepMin: number) {
  const n = c.length;
  const stepMs = stepMin * 60_000;
  let dups = 0, gaps = 0, maxGapMin = 0, weekendGaps = 0;
  const seen = new Set<string>();
  let hasBidAsk = true;
  for (let i = 0; i < n; i++) {
    if (seen.has(c[i]!.closeTime)) dups++; else seen.add(c[i]!.closeTime);
    if (c[i]!.bidClose == null || c[i]!.askClose == null) hasBidAsk = false;
    if (i > 0) {
      const d = Date.parse(c[i]!.closeTime) - Date.parse(c[i - 1]!.closeTime);
      if (d > stepMs) {
        const gapMin = d / 60_000;
        const dow = new Date(Date.parse(c[i - 1]!.closeTime)).getUTCDay();
        // weekend gap: Fri->Sun/Mon large gap expected
        if (gapMin > 2000) weekendGaps++; else { gaps++; if (gapMin > maxGapMin) maxGapMin = gapMin; }
      }
    }
  }
  // avg spread in pips (EURUSD pip = 0.0001)
  let spreadSum = 0, spreadN = 0;
  for (const b of c) { const s = b.askClose - b.bidClose; if (Number.isFinite(s)) { spreadSum += s; spreadN++; } }
  return {
    candles: n, from: c[0]!.closeTime, to: c[n - 1]!.closeTime,
    duplicates: dups, intradayGaps: gaps, maxIntradayGapMin: maxGapMin, weekendGaps,
    bidAskAvailable: hasBidAsk, avgSpreadPips: +(spreadSum / spreadN / 0.0001).toFixed(3),
  };
}

// ---------------- stats ----------------
type Row = { pnlR: number; pnlPrice: number; dir: "long" | "short" };

function wilson(k: number, nn: number): [number, number] {
  if (nn === 0) return [0, 0];
  const z = 1.959963985;
  const p = k / nn; const z2 = z * z;
  const denom = 1 + z2 / nn;
  const centre = p + z2 / (2 * nn);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * nn)) / nn);
  return [(centre - margin) / denom, (centre + margin) / denom];
}

function stats(rows: Row[]) {
  const n = rows.length;
  const wins = rows.filter((r) => r.pnlR > 0);
  const losses = rows.filter((r) => r.pnlR <= 0);
  const gp = wins.reduce((s, r) => s + r.pnlPrice, 0);
  const gl = Math.abs(losses.reduce((s, r) => s + r.pnlPrice, 0));
  const pf = gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0);
  const totalR = rows.reduce((s, r) => s + r.pnlR, 0);
  const netPrice = rows.reduce((s, r) => s + r.pnlPrice, 0);
  const expR = n ? totalR / n : 0;
  const wr = n ? wins.length / n : 0;
  const [lo, hi] = wilson(wins.length, n);
  // drawdown in R
  let cum = 0, peak = 0, maxDD = 0;
  let curWin = 0, curLoss = 0, maxWin = 0, maxLoss = 0;
  for (const r of rows) {
    cum += r.pnlR; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum;
    if (r.pnlR > 0) { curWin++; curLoss = 0; } else { curLoss++; curWin = 0; }
    if (curWin > maxWin) maxWin = curWin; if (curLoss > maxLoss) maxLoss = curLoss;
  }
  const avgWinR = wins.length ? wins.reduce((s, r) => s + r.pnlR, 0) / wins.length : 0;
  const avgLossR = losses.length ? losses.reduce((s, r) => s + r.pnlR, 0) / losses.length : 0;
  return {
    trades: n, wins: wins.length, losses: losses.length,
    winRate: +(wr * 100).toFixed(2), wrCI95: [+(lo * 100).toFixed(2), +(hi * 100).toFixed(2)] as [number, number],
    profitFactor: +pf.toFixed(3), expectancyR: +expR.toFixed(4), totalR: +totalR.toFixed(2),
    netPrice: +netPrice.toFixed(6),
    avgWinR: +avgWinR.toFixed(3), avgLossR: +avgLossR.toFixed(3),
    maxDD_R: +maxDD.toFixed(2), maxWinStreak: maxWin, maxLossStreak: maxLoss,
  };
}

function toRows(trades: Trade[], costMult = 0): Row[] {
  // costMult=0 => PINE-compatible (mid, no spread). >0 => subtract spread*costMult round-turn.
  return trades.map((t) => {
    const cost = t.spreadAtEntry * costMult;
    const pnlPrice = t.pnlPriceMid - cost;
    return { pnlR: pnlPrice / t.riskDist, pnlPrice, dir: t.dir };
  });
}

function dirSplit(trades: Trade[], costMult = 0) {
  const rows = trades.map((t, i) => ({ t, r: toRows([t], costMult)[0]! }));
  const mk = (d: "long" | "short") => {
    const rs = rows.filter((x) => x.t.dir === d).map((x) => x.r);
    const s = stats(rs);
    return { trades: s.trades, winRate: s.winRate, expectancyR: s.expectancyR, totalR: s.totalR, profitFactor: s.profitFactor };
  };
  return { long: mk("long"), short: mk("short") };
}

// ---------------- load ----------------
const m1 = loadCandles(path.join(CAND, "EUR_USD_M1.json"));
const m5 = loadCandles(path.join(HERE, "..", "..", "backtest-breakout-m5", "candles", "EUR_USD_M5.json"));
const dqM1 = dataQuality(m1, 1);
const dqM5 = dataQuality(m5, 5);
console.log("M1 dq:", dqM1);
console.log("M5 dq:", dqM5);

// ---------------- Phase 3: reproduction over recent window ----------------
// TradingView Free M1 window unknown. Reverse-engineer the trailing slice whose
// BASELINE trade count ~= 180, then report LONDON_ONLY over the same slice.
function reproTrailing(c: Candle[], stepMin: number, label: string) {
  // Try a range of trailing bar-counts, find where baseline ~= 180 (M1) or where london ~=28 (M5)
  const baseAll = runStrategy(c, "BASELINE");
  const lonAll = runStrategy(c, "LONDON_ONLY");
  // Full-history reference too
  return { baseAll, lonAll };
}

const reproM1 = reproTrailing(m1, 1, "M1");
const reproM5 = reproTrailing(m5, 5, "M5");

// find trailing window (by calendar) where M1 baseline count ~ 180
function trailingWindowByBaseCount(baseAll: Trade[], targetCount: number): { fromTime: string; count: number } {
  if (baseAll.length <= targetCount) return { fromTime: baseAll[0]?.entryTime ?? "", count: baseAll.length };
  const slice = baseAll.slice(baseAll.length - targetCount);
  return { fromTime: slice[0]!.entryTime, count: targetCount };
}
const reproWin = trailingWindowByBaseCount(reproM1.baseAll, 180);
const m1BaseRecent = reproM1.baseAll.filter((t) => t.entryTime >= reproWin.fromTime);
const m1LonRecent = reproM1.lonAll.filter((t) => t.entryTime >= reproWin.fromTime);
const m5LonRecent = reproM5.lonAll.filter((t) => t.entryTime >= reproWin.fromTime);
const m5BaseRecent = reproM5.baseAll.filter((t) => t.entryTime >= reproWin.fromTime);

// ---------------- Phase 5: canonical full-history LONDON_ONLY ----------------
const tradesM1 = reproM1.lonAll;
const tradesM5 = reproM5.lonAll;

// ---------------- Phase 7 ----------------
const perfM1 = { pine: stats(toRows(tradesM1, 0)), real: stats(toRows(tradesM1, 1)), dir_pine: dirSplit(tradesM1, 0), dir_real: dirSplit(tradesM1, 1) };
const perfM5 = { pine: stats(toRows(tradesM5, 0)), real: stats(toRows(tradesM5, 1)), dir_pine: dirSplit(tradesM5, 0), dir_real: dirSplit(tradesM5, 1) };

// ---------------- Phase 8 monthly/yearly ----------------
function groupBy(trades: Trade[], keyFn: (t: Trade) => string, costMult: number) {
  const m = new Map<string, Trade[]>();
  for (const t of trades) { const k = keyFn(t); if (!m.has(k)) m.set(k, []); m.get(k)!.push(t); }
  const out: { key: string; s: ReturnType<typeof stats> }[] = [];
  for (const k of [...m.keys()].sort()) out.push({ key: k, s: stats(toRows(m.get(k)!, costMult)) });
  return out;
}
const monthlyM1 = groupBy(tradesM1, (t) => t.entryTime.slice(0, 7), 0);
const monthlyM5 = groupBy(tradesM5, (t) => t.entryTime.slice(0, 7), 0);
const yearlyM1 = groupBy(tradesM1, (t) => t.entryTime.slice(0, 4), 0);
const yearlyM5 = groupBy(tradesM5, (t) => t.entryTime.slice(0, 4), 0);

function monthSummary(rows: { key: string; s: ReturnType<typeof stats> }[]) {
  const pfs = rows.map((r) => r.s.profitFactor).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const exps = rows.map((r) => r.s.expectancyR).sort((a, b) => a - b);
  const med = (a: number[]) => a.length ? a[Math.floor(a.length / 2)]! : 0;
  const profitable = rows.filter((r) => r.s.totalR > 0).length;
  const best = rows.reduce((b, r) => (r.s.totalR > b.s.totalR ? r : b), rows[0]!);
  const worst = rows.reduce((b, r) => (r.s.totalR < b.s.totalR ? r : b), rows[0]!);
  return {
    totalMonths: rows.length, profitableMonths: profitable,
    monthsPFgt1: rows.filter((r) => r.s.profitFactor > 1).length,
    monthsPFgt1_2: rows.filter((r) => r.s.profitFactor > 1.2).length,
    medianPF: +med(pfs).toFixed(3), medianExpR: +med(exps).toFixed(4),
    best: { month: best.key, totalR: best.s.totalR }, worst: { month: worst.key, totalR: worst.s.totalR },
  };
}

// ---------------- Phase 9 walk-forward (6 chronological folds) ----------------
function walkForward(trades: Trade[], folds: number) {
  if (trades.length === 0) return [];
  const t0 = Date.parse(trades[0]!.entryTime), t1 = Date.parse(trades[trades.length - 1]!.entryTime);
  const span = (t1 - t0) / folds;
  const out: { fold: number; from: string; to: string; s: ReturnType<typeof stats> }[] = [];
  for (let f = 0; f < folds; f++) {
    const a = t0 + f * span, b = f === folds - 1 ? t1 + 1 : t0 + (f + 1) * span;
    const sub = trades.filter((t) => { const e = Date.parse(t.entryTime); return e >= a && e < b; });
    out.push({ fold: f + 1, from: new Date(a).toISOString().slice(0, 10), to: new Date(b).toISOString().slice(0, 10), s: stats(toRows(sub, 0)) });
  }
  return out;
}
const wfM1 = walkForward(tradesM1, 6);
const wfM5 = walkForward(tradesM5, 6);
function wfSummary(wf: ReturnType<typeof walkForward>) {
  const pfs = wf.map((f) => f.s.profitFactor).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const exps = wf.map((f) => f.s.expectancyR).sort((a, b) => a - b);
  const med = (a: number[]) => a.length ? a[Math.floor(a.length / 2)]! : 0;
  return {
    folds: wf.length, profitableFolds: wf.filter((f) => f.s.totalR > 0).length,
    foldsPFgt1: wf.filter((f) => f.s.profitFactor > 1).length,
    foldsPFgt1_2: wf.filter((f) => f.s.profitFactor > 1.2).length,
    medianPF: +med(pfs).toFixed(3), medianExpR: +med(exps).toFixed(4),
  };
}

// ---------------- Phase 10 session comparison (BASELINE bucketed by entry session) ----------------
function sessionComparison(baseTrades: Trade[]) {
  const buckets: Record<string, Trade[]> = { ASIA: [], LONDON: [], NEW_YORK: [], OTHER: [] };
  for (const t of baseTrades) buckets[t.session]!.push(t);
  const out: Record<string, ReturnType<typeof stats>> = {};
  for (const k of Object.keys(buckets)) out[k] = stats(toRows(buckets[k]!, 0));
  return out;
}
const sessM1 = sessionComparison(reproM1.baseAll);
const sessM5 = sessionComparison(reproM5.baseAll);

// ---------------- Phase 11 M1 vs M5 signal correlation ----------------
function overlapCount(a: Trade[], b: Trade[], toleranceMin: number) {
  const bt = b.map((t) => ({ ms: Date.parse(t.entryTime), dir: t.dir }));
  let matched = 0, sameDir = 0;
  const tol = toleranceMin * 60_000;
  for (const t of a) {
    const ms = Date.parse(t.entryTime);
    const hit = bt.find((x) => Math.abs(x.ms - ms) <= tol);
    if (hit) { matched++; if (hit.dir === t.dir) sameDir++; }
  }
  return { aTrades: a.length, bTrades: b.length, matchedWithinTol: matched, sameDirection: sameDir, toleranceMin };
}
const m1m5overlap = overlapCount(tradesM1, tradesM5, 5);

// ---------------- Phase 12 cost stress ----------------
function costStress(trades: Trade[]) {
  const mults = [0, 1.0, 1.25, 1.5, 2.0];
  return mults.map((m) => {
    const s = stats(toRows(trades, m));
    return { cost: m === 0 ? "0 (PINE mid, no spread)" : `${m}x spread`, ...s };
  });
}
const costM1 = costStress(tradesM1);
const costM5 = costStress(tradesM5);

// ================= WRITE OUTPUTS =================
function csv(rows: (string | number)[][]): string { return rows.map((r) => r.join(",")).join("\n") + "\n"; }

// TRADES_M1 / M5
function tradesCsv(trades: Trade[]): string {
  const head = ["entryTime", "exitTime", "dir", "entryMid", "exitMid", "reason", "tradeATR", "riskDist", "pnlPriceMid", "pnlR", "spreadAtEntry", "pnlR_real1x", "session"];
  const rows = trades.map((t) => {
    const real = (t.pnlPriceMid - t.spreadAtEntry) / t.riskDist;
    return [t.entryTime, t.exitTime, t.dir, t.entryMid.toFixed(6), t.exitMid.toFixed(6), t.reason, t.tradeATR.toFixed(6), t.riskDist.toFixed(6), t.pnlPriceMid.toFixed(6), t.pnlR.toFixed(4), t.spreadAtEntry.toFixed(6), real.toFixed(4), t.session];
  });
  return csv([head, ...rows]);
}
writeFileSync(path.join(HERE, "TRADES_M1.csv"), tradesCsv(tradesM1));
writeFileSync(path.join(HERE, "TRADES_M5.csv"), tradesCsv(tradesM5));

// MONTHLY
function monthlyCsv(m1r: typeof monthlyM1, m5r: typeof monthlyM5): string {
  const head = ["timeframe", "month", "trades", "winRate", "profitFactor", "expectancyR", "totalR", "maxDD_R"];
  const rows: (string | number)[][] = [];
  for (const r of m1r) rows.push(["M1", r.key, r.s.trades, r.s.winRate, r.s.profitFactor, r.s.expectancyR, r.s.totalR, r.s.maxDD_R]);
  for (const r of m5r) rows.push(["M5", r.key, r.s.trades, r.s.winRate, r.s.profitFactor, r.s.expectancyR, r.s.totalR, r.s.maxDD_R]);
  return csv([head, ...rows]);
}
writeFileSync(path.join(HERE, "MONTHLY_RESULTS.csv"), monthlyCsv(monthlyM1, monthlyM5));

function yearlyCsv(): string {
  const head = ["timeframe", "year", "trades", "winRate", "profitFactor", "expectancyR", "totalR", "maxDD_R"];
  const rows: (string | number)[][] = [];
  for (const r of yearlyM1) rows.push(["M1", r.key, r.s.trades, r.s.winRate, r.s.profitFactor, r.s.expectancyR, r.s.totalR, r.s.maxDD_R]);
  for (const r of yearlyM5) rows.push(["M5", r.key, r.s.trades, r.s.winRate, r.s.profitFactor, r.s.expectancyR, r.s.totalR, r.s.maxDD_R]);
  return csv([head, ...rows]);
}
writeFileSync(path.join(HERE, "YEARLY_RESULTS.csv"), yearlyCsv());

function wfCsv(): string {
  const head = ["timeframe", "fold", "from", "to", "trades", "winRate", "profitFactor", "expectancyR", "totalR", "maxDD_R"];
  const rows: (string | number)[][] = [];
  for (const f of wfM1) rows.push(["M1", f.fold, f.from, f.to, f.s.trades, f.s.winRate, f.s.profitFactor, f.s.expectancyR, f.s.totalR, f.s.maxDD_R]);
  for (const f of wfM5) rows.push(["M5", f.fold, f.from, f.to, f.s.trades, f.s.winRate, f.s.profitFactor, f.s.expectancyR, f.s.totalR, f.s.maxDD_R]);
  return csv([head, ...rows]);
}
writeFileSync(path.join(HERE, "WALK_FORWARD.csv"), wfCsv());

function sessionCsv(): string {
  const head = ["timeframe", "session", "trades", "winRate", "profitFactor", "expectancyR", "totalR", "maxDD_R"];
  const rows: (string | number)[][] = [];
  for (const k of ["ASIA", "LONDON", "NEW_YORK", "OTHER"]) { const s = sessM1[k]!; rows.push(["M1", k, s.trades, s.winRate, s.profitFactor, s.expectancyR, s.totalR, s.maxDD_R]); }
  for (const k of ["ASIA", "LONDON", "NEW_YORK", "OTHER"]) { const s = sessM5[k]!; rows.push(["M5", k, s.trades, s.winRate, s.profitFactor, s.expectancyR, s.totalR, s.maxDD_R]); }
  return csv([head, ...rows]);
}
writeFileSync(path.join(HERE, "SESSION_COMPARISON.csv"), sessionCsv());

function costCsv(): string {
  const head = ["timeframe", "cost", "trades", "winRate", "profitFactor", "expectancyR", "totalR", "netPrice"];
  const rows: (string | number)[][] = [];
  for (const r of costM1) rows.push(["M1", r.cost, r.trades, r.winRate, r.profitFactor, r.expectancyR, r.totalR, r.netPrice]);
  for (const r of costM5) rows.push(["M5", r.cost, r.trades, r.winRate, r.profitFactor, r.expectancyR, r.totalR, r.netPrice]);
  return csv([head, ...rows]);
}
writeFileSync(path.join(HERE, "COST_STRESS.csv"), costCsv());

// RESULTS.json
const results = {
  verdict: "NO_EDGE",
  verdict_notes: "TradingView M1/M5 London results were small-sample noise. Full-history LONDON_ONLY is PF<1 even at zero cost (M1 0.969, M5 0.904) and catastrophic under real spread (M1 stop distance 0.86pip < spread 1.55pip). London does not separate from other sessions (M1 Asia PF 1.05 > London 0.965). Not stable across years or walk-forward folds. Do not develop further.",
  meta: { generated: new Date().toISOString(), params: P },
  data: { m1: dqM1, m5: dqM5 },
  reproduction: {
    windowFrom: reproWin.fromTime,
    m1_baseline_recent: stats(toRows(m1BaseRecent, 0)),
    m1_london_recent: stats(toRows(m1LonRecent, 0)),
    m5_london_recent: stats(toRows(m5LonRecent, 0)),
    m5_baseline_recent: stats(toRows(m5BaseRecent, 0)),
    tv_targets: { m1_london: { trades: 39, wr: 41.0, pf: 1.55 }, m5_london: { trades: 28, wr: 50.0, pf: 1.54 }, m1_baseline: { trades: 180, wr: 30.6, pf: 0.76 } },
  },
  performance: { m1: perfM1, m5: perfM5 },
  monthly_summary: { m1: monthSummary(monthlyM1), m5: monthSummary(monthlyM5) },
  walk_forward: { m1: { folds: wfM1, summary: wfSummary(wfM1) }, m5: { folds: wfM5, summary: wfSummary(wfM5) } },
  session_comparison: { m1: sessM1, m5: sessM5 },
  m1_vs_m5_overlap: m1m5overlap,
  cost_stress: { m1: costM1, m5: costM5 },
};
writeFileSync(path.join(HERE, "RESULTS.json"), JSON.stringify(results, null, 2));

console.log("\n==== SUMMARY ====");
console.log("M1 LONDON_ONLY pine:", perfM1.pine);
console.log("M1 LONDON_ONLY real:", perfM1.real);
console.log("M5 LONDON_ONLY pine:", perfM5.pine);
console.log("M5 LONDON_ONLY real:", perfM5.real);
console.log("Repro M1 baseline recent:", stats(toRows(m1BaseRecent, 0)));
console.log("Repro M1 london recent:", stats(toRows(m1LonRecent, 0)));
console.log("Repro M5 london recent:", stats(toRows(m5LonRecent, 0)));
console.log("Session M1:", sessM1);
console.log("Monthly M1 summary:", monthSummary(monthlyM1));
console.log("WF M1:", wfSummary(wfM1));
console.log("Cost M1:", costM1.map((c) => ({ c: c.cost, totalR: c.totalR, pf: c.profitFactor })));
console.log("Overlap:", m1m5overlap);
console.log("outputs written to", HERE);

/**
 * Walk-forward v3 — adds binary-logistic-v1's pLong as an 8th feature.
 *
 * IMPORTANT: binary-logistic-v1 was trained on M1 features. We only have M15
 * candles cached, so M1-scale features (mom_m1, ret_m1) are null-filled and
 * standardize to 0. This gives a DEGRADED binary output, not the true one.
 * If v3 shows meaningful lift over v2, we'll invest in a proper M1 pipeline.
 *
 * RESEARCH ONLY.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

const { loadBinaryLogisticArtifact, inferBinaryLogistic } = await import("../src/binary-logistic-v1.js");

const REPO_ROOT = path.resolve(serviceRoot, "..");
const DATASET = process.env.DATASET ?? "backtest-legacy-expanded";
const TRADES_JSON = path.join(REPO_ROOT, DATASET, "trades.json");
const CACHE_DIR = path.join(REPO_ROOT, DATASET, "candles");
const OUT_DIR = path.join(serviceRoot, "research-v2", `legacy-direction-confidence-v3-walkforward-${DATASET}`);
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

type Q = {
  closeTime: string; open: number; high: number; low: number; close: number;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};
const candleCache = new Map<string, Q[]>();
function loadCandles(pair: string, gran: string): Q[] {
  const key = `${pair}_${gran}`;
  if (candleCache.has(key)) return candleCache.get(key)!;
  const bars = (JSON.parse(readFileSync(path.join(CACHE_DIR, `${pair}_${gran}.json`), "utf8")) as { bars: Q[] }).bars;
  candleCache.set(key, bars);
  return bars;
}

function atr(bars: Q[], period: number): number[] {
  const out: number[] = new Array(bars.length).fill(NaN);
  const trs: number[] = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (i === 0) { trs[i] = b.high - b.low; continue; }
    const p = bars[i - 1]!;
    trs[i] = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
  }
  let sum = 0;
  for (let i = 0; i < period && i < trs.length; i++) sum += trs[i]!;
  if (trs.length >= period) {
    let a = sum / period;
    out[period - 1] = a;
    for (let i = period; i < trs.length; i++) { a = (a * (period - 1) + trs[i]!) / period; out[i] = a; }
  }
  return out;
}
function rsi(closes: number[], period: number): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i]! - closes[i - 1]!; if (d >= 0) gain += d; else loss -= d; }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    const up = d > 0 ? d : 0; const dn = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + up) / period;
    loss = (loss * (period - 1) + dn) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}
function ema(values: number[], period: number): number[] {
  const out: number[] = []; if (!values.length) return out;
  const k = 2 / (period + 1);
  let e = values[0]!; out.push(e);
  for (let i = 1; i < values.length; i++) { e = values[i]! * k + e * (1 - k); out.push(e); }
  return out;
}
function idxAtOrBefore(bars: Q[], iso: string): number {
  const t = Date.parse(iso);
  let lo = 0, hi = bars.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (Date.parse(bars[m]!.closeTime) <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  return k;
}
function etHour(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(iso));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}
function etDay(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).formatToParts(new Date(iso));
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[wd] ?? 0;
}
const rankPercentile = (arr: number[], value: number): number => {
  let count = 0;
  for (const v of arr) if (v <= value) count++;
  return count / arr.length;
};
function pipSize(inst: string): number {
  if (inst === "XAU_USD") return 0.1;
  return inst.endsWith("JPY") ? 0.01 : 0.0001;
}
function sessionLabel(hour: number): string {
  if (hour >= 8 && hour < 12) return "London/New York overlap";
  if (hour >= 3 && hour < 8) return "London";
  if (hour >= 12 && hour < 17) return "New York";
  return "Off";
}

// ---- binary features (M15-based, M1-scale nulled) ----
function computeBinaryM15(
  pair: string,
  m15: Q[],
  i: number,
): {
  momentumPips: { m1: number | null; m5: number | null; m10: number | null; m15: number | null };
  returnPct: { m1: number | null; m5: number | null; m10: number | null; m15: number | null };
  trend: "up" | "down" | "flat";
  emaFast: number | null; emaSlow: number | null;
  atrPips: number | null; volatilityPips: number | null;
  candle: { bodyPips: number; upperWickPips: number; lowerWickPips: number; bodyRatio: number } | null;
  distanceFromHighPips: number | null; distanceFromLowPips: number | null;
  spreadPips: number | null; session: string; hourEt: number; timeOfDayBucket: string;
  referenceClose: number; referenceCloseTime: string;
} {
  const pip = pipSize(pair);
  const bar = m15[i]!;
  const closes = m15.slice(0, i + 1).map((b) => b.close);
  const efSeries = ema(closes, 9);
  const esSeries = ema(closes, 21);
  const emaFast = efSeries.at(-1) ?? null;
  const emaSlow = esSeries.at(-1) ?? null;
  const trend: "up" | "down" | "flat" = emaFast !== null && emaSlow !== null
    ? emaFast > emaSlow ? "up" : emaFast < emaSlow ? "down" : "flat"
    : "flat";
  const a14 = atr(m15.slice(0, i + 1), 14).at(-1) ?? null;
  const atrPips = a14 === null || !Number.isFinite(a14) ? null : a14 / pip;

  // "1-minute" scale features not available — null.
  // For m5/m10/m15 momentum we substitute M15-based multi-bar diffs — imperfect
  // scale but preserves sign and gives the model *some* short-horizon info.
  const closeNow = bar.close;
  const closeM15 = i - 1 >= 0 ? m15[i - 1]!.close : null;
  const momM15 = closeM15 !== null ? (closeNow - closeM15) / pip : null;
  const retM15 = closeM15 !== null && closeM15 !== 0 ? (closeNow - closeM15) / closeM15 : null;

  // Volatility: std-dev of last 15 M15-bar returns in pips (loose analogue of the M1 volatility)
  const recentReturns: number[] = [];
  for (let k = Math.max(1, i - 14); k <= i; k++) {
    recentReturns.push((m15[k]!.close - m15[k - 1]!.close) / pip);
  }
  const mean = recentReturns.reduce((a, b) => a + b, 0) / (recentReturns.length || 1);
  const variance = recentReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (recentReturns.length || 1);
  const volatilityPips = recentReturns.length >= 2 ? Math.sqrt(variance) : null;

  const range = bar.high - bar.low;
  const candle = range > 0 ? {
    bodyPips: Math.abs(bar.close - bar.open) / pip,
    upperWickPips: (bar.high - Math.max(bar.open, bar.close)) / pip,
    lowerWickPips: (Math.min(bar.open, bar.close) - bar.low) / pip,
    bodyRatio: Math.abs(bar.close - bar.open) / range,
  } : null;

  const window = m15.slice(Math.max(0, i - 14), i + 1);
  const recentHigh = Math.max(...window.map((c) => c.high));
  const recentLow = Math.min(...window.map((c) => c.low));

  const hourEt = etHour(bar.closeTime);
  return {
    momentumPips: { m1: null, m5: null, m10: null, m15: momM15 },
    returnPct: { m1: null, m5: null, m10: null, m15: retM15 },
    trend,
    emaFast, emaSlow, atrPips, volatilityPips, candle,
    distanceFromHighPips: (recentHigh - closeNow) / pip,
    distanceFromLowPips: (closeNow - recentLow) / pip,
    spreadPips: (bar.askClose - bar.bidClose) / pip,
    session: sessionLabel(hourEt),
    hourEt,
    timeOfDayBucket: `${String(Math.floor(hourEt / 4) * 4).padStart(2, "0")}-${String(Math.floor(hourEt / 4) * 4 + 4).padStart(2, "0")} ET`,
    referenceClose: closeNow,
    referenceCloseTime: bar.closeTime,
  };
}

// ---- load trades + features ----
type Trade = { pair: string; direction: "long" | "short"; decisionTime: string; entry: number; stop: number; target: number; resultR: number | null };
const raw = JSON.parse(readFileSync(TRADES_JSON, "utf8")) as { trades: Trade[] };
const trades = raw.trades.filter((t) => t.resultR !== null && Number.isFinite(t.resultR!));
console.log(`loaded ${trades.length} trades`);

const binaryArtifact = loadBinaryLogisticArtifact();
console.log(`binary artifact: ${binaryArtifact.modelName} v${binaryArtifact.version}`);

type Feat = {
  pair: string; ts: number; decisionTime: string;
  direction: "long" | "short"; resultR: number;
  atrPct: number; atrRatio: number; hourEt: number; dayOfWeek: number;
  rsiVelocity: number; rangePos: number; mom3: number;
  binaryPUp: number; // added
};
const feats: Feat[] = [];
const PAIRS = [...new Set(trades.map((t) => t.pair))];
let binarySkipped = 0;

for (const pair of PAIRS) {
  const m15 = loadCandles(pair, "M15");
  const closes = m15.map((b) => b.close);
  const a14 = atr(m15, 14);
  const a50 = atr(m15, 50);
  const r14 = rsi(closes, 14);
  const pairTrades = trades.filter((t) => t.pair === pair);
  for (const t of pairTrades) {
    const i = idxAtOrBefore(m15, t.decisionTime);
    if (i < 500) continue;
    const atr14V = a14[i]!; const atr50V = a50[i]!; const closeV = closes[i]!;
    const rsiV = r14[i]!; const rsiPrev = r14[i - 3]; const closePrev3 = closes[i - 3];
    if (![atr14V, atr50V, closeV, rsiV, rsiPrev, closePrev3].every((x) => Number.isFinite(x as number))) continue;
    const atrHist = a14.slice(Math.max(0, i - 500), i).filter((v) => Number.isFinite(v));
    if (atrHist.length < 100) continue;
    const atrPct = rankPercentile(atrHist, atr14V);
    const atrRatio = atr14V / atr50V;
    const rangeWin = m15.slice(Math.max(0, i - 20), i);
    const rangeHi = Math.max(...rangeWin.map((b) => b.high));
    const rangeLo = Math.min(...rangeWin.map((b) => b.low));
    const rangePos = rangeHi > rangeLo ? (closeV - rangeLo) / (rangeHi - rangeLo) : 0.5;
    const rsiVelocity = (rsiV - (rsiPrev as number)) / 3;
    const mom3 = (closeV - (closePrev3 as number)) / closeV;

    // binary probability
    const bfeat = computeBinaryM15(pair, m15, i);
    const inf = inferBinaryLogistic(bfeat as never, binaryArtifact);
    let binaryPUp = 0.5;
    if ("rawProbabilityUp" in inf && Number.isFinite(inf.rawProbabilityUp)) {
      binaryPUp = inf.rawProbabilityUp;
    } else {
      binarySkipped++;
    }

    feats.push({
      pair, ts: Date.parse(t.decisionTime), decisionTime: t.decisionTime,
      direction: t.direction, resultR: t.resultR!,
      atrPct, atrRatio, hourEt: etHour(t.decisionTime), dayOfWeek: etDay(t.decisionTime),
      rsiVelocity, rangePos, mom3, binaryPUp,
    });
  }
}
feats.sort((a, b) => a.ts - b.ts);
console.log(`feature rows: ${feats.length}  (binary skipped ${binarySkipped})`);

const FEATURE_NAMES = ["atrPct", "atrRatio", "hourEt", "dayOfWeek", "rsiVelocity", "rangePos", "mom3", "binaryPUp"] as const;
const getVec = (f: Feat): number[] => [f.atrPct, f.atrRatio, f.hourEt, f.dayOfWeek, f.rsiVelocity, f.rangePos, f.mom3, f.binaryPUp];
const longWon = (f: Feat): 1 | 0 => (((f.direction === "long" ? f.resultR : -f.resultR) > 0) ? 1 : 0);
const K = FEATURE_NAMES.length;

function trainLogistic(IS: Feat[]) {
  const mean = new Array(K).fill(0).map((_, k) => IS.reduce((s, f) => s + getVec(f)[k]!, 0) / IS.length);
  const std = new Array(K).fill(0).map((_, k) => {
    const m = mean[k]!;
    const v = IS.reduce((s, f) => s + (getVec(f)[k]! - m) ** 2, 0) / IS.length;
    return Math.sqrt(v) || 1;
  });
  const scale = (f: Feat) => getVec(f).map((v, k) => (v - mean[k]!) / std[k]!);
  const w = new Array(K).fill(0);
  let b = 0;
  const lr = 0.05, epochs = 500, l2 = 0.001;
  const sig = (z: number) => 1 / (1 + Math.exp(-z));
  for (let ep = 0; ep < epochs; ep++) {
    const grads = new Array(K).fill(0);
    let gb = 0;
    for (const f of IS) {
      const x = scale(f);
      const y = longWon(f);
      const p = sig(x.reduce((s, xi, k) => s + xi * w[k]!, 0) + b);
      const err = p - y;
      for (let k = 0; k < K; k++) grads[k] += err * x[k]!;
      gb += err;
    }
    for (let k = 0; k < K; k++) w[k] = w[k]! - lr * (grads[k]! / IS.length + l2 * w[k]!);
    b = b - lr * (gb / IS.length);
  }
  return { w, b, mean, std };
}
function predict(f: Feat, model: { w: number[]; b: number; mean: number[]; std: number[] }): number {
  const x = getVec(f).map((v, k) => (v - model.mean[k]!) / model.std[k]!);
  const z = x.reduce((s, xi, k) => s + xi * model.w[k]!, 0) + model.b;
  return 1 / (1 + Math.exp(-z));
}

const MS_MONTH = 30 * 86400e3;
const TRAIN_MONTHS = 12;
const TEST_MONTHS = 3;
const CONF_T = 0.10;
const firstTs = feats[0]!.ts;
const lastTs = feats[feats.length - 1]!.ts;

type Slot = {
  windowStart: string; windowEnd: string; trainN: number; testN: number;
  baselineN: number; baselineR: number; baselineWr: number;
  combinedN: number; combinedR: number; combinedWr: number;
  binaryWeightAvg: number;
};
const slots: Slot[] = [];

let testStart = firstTs + TRAIN_MONTHS * MS_MONTH;
while (testStart + TEST_MONTHS * MS_MONTH <= lastTs + MS_MONTH) {
  const trainStart = testStart - TRAIN_MONTHS * MS_MONTH;
  const trainEnd = testStart;
  const testEnd = testStart + TEST_MONTHS * MS_MONTH;
  const train = feats.filter((f) => f.pair !== "XAU_USD" && f.ts >= trainStart && f.ts < trainEnd);
  const test = feats.filter((f) => f.ts >= testStart && f.ts < testEnd);
  if (train.length < 60 || test.length < 5) { testStart += TEST_MONTHS * MS_MONTH; continue; }
  const model = trainLogistic(train);
  const binaryW = model.w[FEATURE_NAMES.indexOf("binaryPUp")]!;
  let bN = 0, bW = 0, bR = 0, cN = 0, cW = 0, cR = 0;
  for (const f of test) {
    bN++; bR += f.resultR; if (f.resultR > 0) bW++;
    if (f.pair === "XAU_USD") { cN++; cR += f.resultR; if (f.resultR > 0) cW++; continue; }
    const pLong = predict(f, model);
    const picked: "long" | "short" = pLong >= 0.5 ? "long" : "short";
    if (picked !== f.direction && Math.abs(pLong - 0.5) >= CONF_T) {
      cN++;
      const impR = -f.resultR;
      cR += impR;
      if (impR > 0) cW++;
    }
  }
  slots.push({
    windowStart: new Date(testStart).toISOString().slice(0, 10),
    windowEnd: new Date(testEnd).toISOString().slice(0, 10),
    trainN: train.length, testN: test.length,
    baselineN: bN, baselineR: bR, baselineWr: bN ? 100 * bW / bN : 0,
    combinedN: cN, combinedR: cR, combinedWr: cN ? 100 * cW / cN : 0,
    binaryWeightAvg: binaryW,
  });
  testStart += TEST_MONTHS * MS_MONTH;
}

console.log(`\nv3 walk-forward: TRAIN=${TRAIN_MONTHS}mo TEST=${TEST_MONTHS}mo CONF_T=${CONF_T}`);
console.log(`\nwindow                       BASE (all)          COMB v3 (with binary)   binaryW`);
console.log(`                              n   wr    totalR      n   wr    totalR      (this window)`);
let sB_N = 0, sB_W = 0, sB_R = 0, sC_N = 0, sC_W = 0, sC_R = 0;
let sumBW = 0;
for (const s of slots) {
  const bw = Math.round(s.baselineWr * s.baselineN / 100);
  const cw = Math.round(s.combinedWr * s.combinedN / 100);
  console.log(
    `  ${s.windowStart} → ${s.windowEnd}   ` +
    `${String(s.baselineN).padStart(3)}  ${s.baselineWr.toFixed(0).padStart(3)}%  ${(s.baselineR >= 0 ? "+" : "") + s.baselineR.toFixed(2).padStart(6)}     ` +
    `${String(s.combinedN).padStart(3)}  ${s.combinedWr.toFixed(0).padStart(3)}%  ${(s.combinedR >= 0 ? "+" : "") + s.combinedR.toFixed(2).padStart(6)}    ` +
    `${s.binaryWeightAvg.toFixed(3).padStart(7)}`
  );
  sB_N += s.baselineN; sB_W += bw; sB_R += s.baselineR;
  sC_N += s.combinedN; sC_W += cw; sC_R += s.combinedR;
  sumBW += s.binaryWeightAvg;
}
console.log(`  ${"TOTAL".padEnd(30)}` +
  `${String(sB_N).padStart(3)}  ${(100 * sB_W / (sB_N || 1)).toFixed(0).padStart(3)}%  ${(sB_R >= 0 ? "+" : "") + sB_R.toFixed(2).padStart(6)}     ` +
  `${String(sC_N).padStart(3)}  ${(100 * sC_W / (sC_N || 1)).toFixed(0).padStart(3)}%  ${(sC_R >= 0 ? "+" : "") + sC_R.toFixed(2).padStart(6)}    ` +
  `${(sumBW / slots.length).toFixed(3).padStart(7)}`
);

console.log(`\nexpR/trade:  baseline=${(sB_R / (sB_N || 1)).toFixed(4)}   v3=${(sC_R / (sC_N || 1)).toFixed(4)}`);
console.log(`v3 beats baseline in ${slots.filter((s) => s.combinedR > s.baselineR).length}/${slots.length} windows`);
console.log(`avg binaryPUp weight across windows: ${(sumBW / slots.length).toFixed(4)}   (weights near 0 = model ignoring it)`);

writeFileSync(path.join(OUT_DIR, "RESULTS.json"), JSON.stringify({
  generated: new Date().toISOString(),
  params: { TRAIN_MONTHS, TEST_MONTHS, CONF_T, featureSet: [...FEATURE_NAMES] },
  slots,
  totals: {
    baseline: { n: sB_N, totalR: sB_R, expR: sB_R / (sB_N || 1), winrate: 100 * sB_W / (sB_N || 1) },
    v3_combined: { n: sC_N, totalR: sC_R, expR: sC_R / (sC_N || 1), winrate: 100 * sC_W / (sC_N || 1) },
    avgBinaryWeight: sumBW / slots.length,
  },
}, null, 2));
console.log(`\nwrote ${path.join(OUT_DIR, "RESULTS.json")}`);
process.exit(0);

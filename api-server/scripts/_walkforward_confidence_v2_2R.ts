/**
 * Walk-forward test with 2:1 R:R on the FLIPPED FX trades.
 *
 * Same as _walkforward_confidence_v2.ts but when the model says to flip an FX
 * trade, we resolve the inverted trade with a FRESH 2R target and 1R stop
 * (not the mirror-of-original 0.77:1 shortcut). Uses the production
 * labelOutcome resolver on the same forward M15 candles as the original.
 *
 * XAU still takes baseline (unchanged).
 *
 * RESEARCH ONLY.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
process.env.NODE_ENV = "production";

const { labelOutcome } = await import("../src/research.js");

const REPO_ROOT = path.resolve(serviceRoot, "..");
const DATASET = process.env.DATASET ?? "backtest-legacy-expanded";
const TRADES_JSON = path.join(REPO_ROOT, DATASET, "trades.json");
const CACHE_DIR = path.join(REPO_ROOT, DATASET, "candles");
const OUT_DIR = path.join(serviceRoot, "research-v2", `legacy-direction-confidence-v2-walkforward-2R-${DATASET}`);
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
  const cache = path.join(CACHE_DIR, `${pair}_${gran}.json`);
  const bars = (JSON.parse(readFileSync(cache, "utf8")) as { bars: Q[] }).bars;
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

// ---- load trades ----
type Trade = {
  pair: string; direction: "long" | "short"; decisionTime: string;
  entry: number; stop: number; target: number;
  resultR: number | null;
};
const raw = JSON.parse(readFileSync(TRADES_JSON, "utf8")) as { trades: Trade[] };
const trades = raw.trades.filter((t) => t.resultR !== null && Number.isFinite(t.resultR!));
console.log(`loaded ${trades.length} trades`);

// ---- features + inverted-2R outcome ----
type Feat = {
  pair: string; ts: number; decisionTime: string;
  direction: "long" | "short"; resultR: number;
  atrPct: number; atrRatio: number; hourEt: number; dayOfWeek: number;
  rsiVelocity: number; rangePos: number; mom3: number;
  inverted2R_R: number | null; // R if we had inverted with 2R target
};

const PAIRS = [...new Set(trades.map((t) => t.pair))];
const feats: Feat[] = [];

console.log(`computing features + inverted-2R resolutions across ${PAIRS.length} pairs...`);
let missing = 0, inv2Rambig = 0;

for (const pair of PAIRS) {
  const m15 = loadCandles(pair, "M15");
  const closes = m15.map((b) => b.close);
  const a14 = atr(m15, 14);
  const a50 = atr(m15, 50);
  const r14 = rsi(closes, 14);

  const pairTrades = trades.filter((t) => t.pair === pair);
  for (const t of pairTrades) {
    const i = idxAtOrBefore(m15, t.decisionTime);
    if (i < 500) { missing++; continue; }
    const atr14V = a14[i]!; const atr50V = a50[i]!; const closeV = closes[i]!;
    const rsiV = r14[i]!; const rsiPrev = r14[i - 3]; const closePrev3 = closes[i - 3];
    if (![atr14V, atr50V, closeV, rsiV, rsiPrev, closePrev3].every((x) => Number.isFinite(x as number))) { missing++; continue; }
    const atrHist = a14.slice(Math.max(0, i - 500), i).filter((v) => Number.isFinite(v));
    if (atrHist.length < 100) { missing++; continue; }
    const atrPct = rankPercentile(atrHist, atr14V);
    const atrRatio = atr14V / atr50V;
    const rangeWin = m15.slice(Math.max(0, i - 20), i);
    const rangeHi = Math.max(...rangeWin.map((b) => b.high));
    const rangeLo = Math.min(...rangeWin.map((b) => b.low));
    const rangePos = rangeHi > rangeLo ? (closeV - rangeLo) / (rangeHi - rangeLo) : 0.5;
    const rsiVelocity = (rsiV - (rsiPrev as number)) / 3;
    const mom3 = (closeV - (closePrev3 as number)) / closeV;

    // Compute inverted-2R outcome using labelOutcome on forward candles.
    const riskPrice = Math.abs(t.entry - t.stop);
    const invDir: "long" | "short" = t.direction === "long" ? "short" : "long";
    let invStop: number, invTarget: number;
    if (invDir === "long") { invStop = t.entry - riskPrice; invTarget = t.entry + 2 * riskPrice; }
    else { invStop = t.entry + riskPrice; invTarget = t.entry - 2 * riskPrice; }
    const forward = m15.slice(i + 1);
    const res = labelOutcome(invDir, t.entry, invStop, invTarget, t.decisionTime, forward as never);
    let invR: number | null = res.resultR;
    if (res.outcome === "ambiguous" || invR === null || !Number.isFinite(invR)) {
      invR = null;
      inv2Rambig++;
    }

    feats.push({
      pair, ts: Date.parse(t.decisionTime), decisionTime: t.decisionTime,
      direction: t.direction, resultR: t.resultR!,
      atrPct, atrRatio, hourEt: etHour(t.decisionTime), dayOfWeek: etDay(t.decisionTime),
      rsiVelocity, rangePos, mom3,
      inverted2R_R: invR,
    });
  }
  console.log(`  ${pair}: ${pairTrades.length} trades`);
}
feats.sort((a, b) => a.ts - b.ts);
console.log(`total feature rows: ${feats.length}  (missing ${missing}, inv-2R ambiguous ${inv2Rambig})`);

// ---- logistic regression ----
const FEATURE_NAMES = ["atrPct", "atrRatio", "hourEt", "dayOfWeek", "rsiVelocity", "rangePos", "mom3"] as const;
const getVec = (f: Feat): number[] => [f.atrPct, f.atrRatio, f.hourEt, f.dayOfWeek, f.rsiVelocity, f.rangePos, f.mom3];
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

// ---- walk-forward ----
const MS_MONTH = 30 * 86400e3;
const TRAIN_MONTHS = 12;
const TEST_MONTHS = 3;
const CONF_T = 0.10;

const firstTs = feats[0]!.ts;
const lastTs = feats[feats.length - 1]!.ts;

type Slot = {
  windowStart: string; windowEnd: string; trainN: number; testN: number;
  baselineN: number; baselineR: number; baselineWr: number;
  combined1R5_N: number; combined1R5_R: number; combined1R5_Wr: number;
  combined2R_N: number; combined2R_R: number; combined2R_Wr: number;
  combined2R_flipsAmbig: number;
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

  let bN = 0, bW = 0, bR = 0;
  let c1N = 0, c1W = 0, c1R = 0; // combined @ 1.5R mirror (old rule)
  let c2N = 0, c2W = 0, c2R = 0, c2A = 0; // combined @ 2R fresh flip

  for (const f of test) {
    bN++; bR += f.resultR; if (f.resultR > 0) bW++;

    if (f.pair === "XAU_USD") {
      c1N++; c1R += f.resultR; if (f.resultR > 0) c1W++;
      c2N++; c2R += f.resultR; if (f.resultR > 0) c2W++;
    } else {
      const pLong = predict(f, model);
      const picked: "long" | "short" = pLong >= 0.5 ? "long" : "short";
      const disagrees = picked !== f.direction;
      const confident = Math.abs(pLong - 0.5) >= CONF_T;
      if (disagrees && confident) {
        // 1.5R mirror
        const impR15 = -f.resultR;
        c1N++; c1R += impR15; if (impR15 > 0) c1W++;
        // 2R fresh flip
        if (f.inverted2R_R === null) { c2A++; }
        else { c2N++; c2R += f.inverted2R_R; if (f.inverted2R_R > 0) c2W++; }
      }
    }
  }

  slots.push({
    windowStart: new Date(testStart).toISOString().slice(0, 10),
    windowEnd: new Date(testEnd).toISOString().slice(0, 10),
    trainN: train.length, testN: test.length,
    baselineN: bN, baselineR: bR, baselineWr: bN ? 100 * bW / bN : 0,
    combined1R5_N: c1N, combined1R5_R: c1R, combined1R5_Wr: c1N ? 100 * c1W / c1N : 0,
    combined2R_N: c2N, combined2R_R: c2R, combined2R_Wr: c2N ? 100 * c2W / c2N : 0,
    combined2R_flipsAmbig: c2A,
  });
  testStart += TEST_MONTHS * MS_MONTH;
}

// ---- print ----
console.log(`\nwalk-forward: TRAIN=${TRAIN_MONTHS}mo TEST=${TEST_MONTHS}mo CONF_T=${CONF_T}`);
console.log(`\nwindow                       BASE (all)          COMB 1.5R (mirror)      COMB 2R (fresh flip)    ambig`);
console.log(`                              n   wr    totalR      n   wr    totalR       n   wr    totalR       flips`);
let sB_N = 0, sB_W = 0, sB_R = 0;
let s1_N = 0, s1_W = 0, s1_R = 0;
let s2_N = 0, s2_W = 0, s2_R = 0, s2_A = 0;
for (const s of slots) {
  const bw = Math.round(s.baselineWr * s.baselineN / 100);
  const c1w = Math.round(s.combined1R5_Wr * s.combined1R5_N / 100);
  const c2w = Math.round(s.combined2R_Wr * s.combined2R_N / 100);
  console.log(
    `  ${s.windowStart} → ${s.windowEnd}   ` +
    `${String(s.baselineN).padStart(3)}  ${s.baselineWr.toFixed(0).padStart(3)}%  ${(s.baselineR >= 0 ? "+" : "") + s.baselineR.toFixed(2).padStart(6)}     ` +
    `${String(s.combined1R5_N).padStart(3)}  ${s.combined1R5_Wr.toFixed(0).padStart(3)}%  ${(s.combined1R5_R >= 0 ? "+" : "") + s.combined1R5_R.toFixed(2).padStart(6)}      ` +
    `${String(s.combined2R_N).padStart(3)}  ${s.combined2R_Wr.toFixed(0).padStart(3)}%  ${(s.combined2R_R >= 0 ? "+" : "") + s.combined2R_R.toFixed(2).padStart(6)}       ` +
    `${String(s.combined2R_flipsAmbig).padStart(3)}`
  );
  sB_N += s.baselineN; sB_W += bw; sB_R += s.baselineR;
  s1_N += s.combined1R5_N; s1_W += c1w; s1_R += s.combined1R5_R;
  s2_N += s.combined2R_N; s2_W += c2w; s2_R += s.combined2R_R; s2_A += s.combined2R_flipsAmbig;
}
console.log(`  ${"TOTAL".padEnd(30)}` +
  `${String(sB_N).padStart(3)}  ${(100 * sB_W / (sB_N || 1)).toFixed(0).padStart(3)}%  ${(sB_R >= 0 ? "+" : "") + sB_R.toFixed(2).padStart(6)}     ` +
  `${String(s1_N).padStart(3)}  ${(100 * s1_W / (s1_N || 1)).toFixed(0).padStart(3)}%  ${(s1_R >= 0 ? "+" : "") + s1_R.toFixed(2).padStart(6)}      ` +
  `${String(s2_N).padStart(3)}  ${(100 * s2_W / (s2_N || 1)).toFixed(0).padStart(3)}%  ${(s2_R >= 0 ? "+" : "") + s2_R.toFixed(2).padStart(6)}       ` +
  `${String(s2_A).padStart(3)}`
);

console.log(`\nexpR/trade:  baseline=${(sB_R / (sB_N || 1)).toFixed(4)}   combined-1.5R=${(s1_R / (s1_N || 1)).toFixed(4)}   combined-2R=${(s2_R / (s2_N || 1)).toFixed(4)}`);
console.log(`windows combined-2R beats baseline: ${slots.filter((s) => s.combined2R_R > s.baselineR).length}/${slots.length}`);

writeFileSync(path.join(OUT_DIR, "RESULTS.json"), JSON.stringify({
  generated: new Date().toISOString(),
  params: { TRAIN_MONTHS, TEST_MONTHS, CONF_T, targetR: 2.0, stopR: 1.0 },
  slots,
  totals: {
    baseline: { n: sB_N, totalR: sB_R, expR: sB_R / (sB_N || 1), winrate: 100 * sB_W / (sB_N || 1) },
    combined_1R5_mirror: { n: s1_N, totalR: s1_R, expR: s1_R / (s1_N || 1), winrate: 100 * s1_W / (s1_N || 1) },
    combined_2R_fresh: { n: s2_N, totalR: s2_R, expR: s2_R / (s2_N || 1), winrate: 100 * s2_W / (s2_N || 1), flipsAmbig: s2_A },
  },
}, null, 2));
console.log(`\nwrote ${path.join(OUT_DIR, "RESULTS.json")}`);
process.exit(0);

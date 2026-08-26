/**
 * Walk-forward test of the v2 direction-confidence model.
 * Rolling 12-month IS train → next 3-month OOS test, roll forward 3 months.
 * Combined rule applied on each OOS window:
 *   - FX (non-XAU_USD): take model pick when model DISAGREES with stack
 *                       AND |P-0.5| >= 0.10
 *   - XAU_USD: always take baseline (stack direction)
 *   - Everything else in that window: skip
 *
 * Model is trained on FX ONLY (gold excluded from training since it behaves
 * differently). Feature set = v2 (7 features: atrPct, atrRatio, hourEt,
 * dayOfWeek, rsiVelocity, rangePos, mom3).
 *
 * RESEARCH ONLY. No DB writes.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

const REPO_ROOT = path.resolve(serviceRoot, "..");
const DATASET = process.env.DATASET ?? "backtest-legacy-expanded";
const TRADES_JSON = path.join(REPO_ROOT, DATASET, "trades.json");
const CACHE_DIR = path.join(REPO_ROOT, DATASET, "candles");
const OUT_DIR = path.join(serviceRoot, "research-v2", `legacy-direction-confidence-v2-walkforward-${DATASET}`);
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

type Q = {
  closeTime: string; open: number; high: number; low: number; close: number;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};

function loadCandles(pair: string, gran: string): Q[] {
  const cache = path.join(CACHE_DIR, `${pair}_${gran}.json`);
  if (!existsSync(cache)) throw new Error(`missing cache ${cache}`);
  const c = JSON.parse(readFileSync(cache, "utf8")) as { bars: Q[] };
  return c.bars;
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
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d; else loss -= d;
  }
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

// ---- load trades + extract features ----
type Trade = { pair: string; direction: "long" | "short"; decisionTime: string; resultR: number | null };
const raw = JSON.parse(readFileSync(TRADES_JSON, "utf8")) as { trades: Trade[] };
const trades = raw.trades.filter((t) => t.resultR !== null && Number.isFinite(t.resultR!));
const PAIRS = [...new Set(trades.map((t) => t.pair))];

type Feat = {
  pair: string; ts: number; decisionTime: string;
  direction: "long" | "short"; resultR: number;
  atrPct: number; atrRatio: number; hourEt: number; dayOfWeek: number;
  rsiVelocity: number; rangePos: number; mom3: number;
};
const feats: Feat[] = [];

const rankPercentile = (arr: number[], value: number): number => {
  let count = 0;
  for (const v of arr) if (v <= value) count++;
  return count / arr.length;
};

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
    feats.push({
      pair, ts: Date.parse(t.decisionTime), decisionTime: t.decisionTime,
      direction: t.direction, resultR: t.resultR!,
      atrPct, atrRatio, hourEt: etHour(t.decisionTime), dayOfWeek: etDay(t.decisionTime),
      rsiVelocity, rangePos, mom3,
    });
  }
}
feats.sort((a, b) => a.ts - b.ts);
console.log(`feature rows: ${feats.length}`);

const FEATURE_NAMES = ["atrPct", "atrRatio", "hourEt", "dayOfWeek", "rsiVelocity", "rangePos", "mom3"] as const;
const getVec = (f: Feat): number[] => [f.atrPct, f.atrRatio, f.hourEt, f.dayOfWeek, f.rsiVelocity, f.rangePos, f.mom3];
const longWon = (f: Feat): 1 | 0 => (((f.direction === "long" ? f.resultR : -f.resultR) > 0) ? 1 : 0);
const K = FEATURE_NAMES.length;

function trainLogistic(IS: Feat[]): { w: number[]; b: number; mean: number[]; std: number[] } {
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

// ---- walk-forward loop ----
const MS_MONTH = 30 * 86400e3;
const TRAIN_MONTHS = 12;
const TEST_MONTHS = 3;
const CONF_T = 0.10;

// windows start at first feasible test-window start = first feat.ts + TRAIN_MONTHS
const firstTs = feats[0]!.ts;
const lastTs = feats[feats.length - 1]!.ts;

type Slot = {
  windowStart: string; windowEnd: string; trainN: number; testN: number;
  baselineN: number; baselineR: number; baselineWr: number;
  combinedN: number; combinedR: number; combinedWr: number;
  fxTakenN: number; xauTakenN: number; skippedN: number;
};
const slots: Slot[] = [];

let testStart = firstTs + TRAIN_MONTHS * MS_MONTH;
while (testStart + TEST_MONTHS * MS_MONTH <= lastTs + MS_MONTH) {
  const trainStart = testStart - TRAIN_MONTHS * MS_MONTH;
  const trainEnd = testStart;
  const testEnd = testStart + TEST_MONTHS * MS_MONTH;

  const train = feats.filter((f) => f.pair !== "XAU_USD" && f.ts >= trainStart && f.ts < trainEnd);
  const test = feats.filter((f) => f.ts >= testStart && f.ts < testEnd);

  if (train.length < 60 || test.length < 5) {
    testStart += TEST_MONTHS * MS_MONTH;
    continue;
  }

  const model = trainLogistic(train);

  let baselineN = 0, baselineWins = 0, baselineR = 0;
  let combinedN = 0, combinedWins = 0, combinedR = 0;
  let fxTaken = 0, xauTaken = 0, skipped = 0;

  for (const f of test) {
    baselineN++;
    if (f.resultR > 0) baselineWins++;
    baselineR += f.resultR;

    if (f.pair === "XAU_USD") {
      // XAU: always take baseline
      xauTaken++;
      combinedN++;
      combinedR += f.resultR;
      if (f.resultR > 0) combinedWins++;
    } else {
      const pLong = predict(f, model);
      const picked: "long" | "short" = pLong >= 0.5 ? "long" : "short";
      const disagrees = picked !== f.direction;
      const confident = Math.abs(pLong - 0.5) >= CONF_T;
      if (disagrees && confident) {
        fxTaken++;
        combinedN++;
        const impR = -f.resultR; // took opposite direction
        combinedR += impR;
        if (impR > 0) combinedWins++;
      } else {
        skipped++;
      }
    }
  }

  slots.push({
    windowStart: new Date(testStart).toISOString().slice(0, 10),
    windowEnd: new Date(testEnd).toISOString().slice(0, 10),
    trainN: train.length, testN: test.length,
    baselineN, baselineR, baselineWr: baselineN ? 100 * baselineWins / baselineN : 0,
    combinedN, combinedR, combinedWr: combinedN ? 100 * combinedWins / combinedN : 0,
    fxTakenN: fxTaken, xauTakenN: xauTaken, skippedN: skipped,
  });

  testStart += TEST_MONTHS * MS_MONTH;
}

// ---- print ----
console.log(`\nwalk-forward: TRAIN=${TRAIN_MONTHS}mo  TEST=${TEST_MONTHS}mo  CONF_T=${CONF_T}`);
console.log(`\nwindow                        train  test  |  BASELINE (all)     |  COMBINED (rule)       fxTake xauTake skip`);
console.log(`                                                n    wr%   totalR      n    wr%   totalR`);
let sumBaseN = 0, sumBaseR = 0, sumBaseW = 0;
let sumCombN = 0, sumCombR = 0, sumCombW = 0;
for (const s of slots) {
  const wr = (n: number, w: number) => n ? (100 * w / n).toFixed(1).padStart(5) : "  n/a";
  const bw = Math.round(s.baselineWr * s.baselineN / 100);
  const cw = Math.round(s.combinedWr * s.combinedN / 100);
  console.log(`  ${s.windowStart} → ${s.windowEnd}   ${String(s.trainN).padStart(4)}  ${String(s.testN).padStart(4)}  |  ${String(s.baselineN).padStart(4)}  ${wr(s.baselineN, bw)}  ${(s.baselineR >= 0 ? "+" : "") + s.baselineR.toFixed(2).padStart(7)}  |  ${String(s.combinedN).padStart(4)}  ${wr(s.combinedN, cw)}  ${(s.combinedR >= 0 ? "+" : "") + s.combinedR.toFixed(2).padStart(7)}   ${String(s.fxTakenN).padStart(4)}  ${String(s.xauTakenN).padStart(4)}   ${String(s.skippedN).padStart(3)}`);
  sumBaseN += s.baselineN; sumBaseR += s.baselineR; sumBaseW += bw;
  sumCombN += s.combinedN; sumCombR += s.combinedR; sumCombW += cw;
}
console.log(`  ${"TOTAL".padEnd(31)}                |  ${String(sumBaseN).padStart(4)}  ${(100 * sumBaseW / (sumBaseN || 1)).toFixed(1).padStart(5)}  ${(sumBaseR >= 0 ? "+" : "") + sumBaseR.toFixed(2).padStart(7)}  |  ${String(sumCombN).padStart(4)}  ${(100 * sumCombW / (sumCombN || 1)).toFixed(1).padStart(5)}  ${(sumCombR >= 0 ? "+" : "") + sumCombR.toFixed(2).padStart(7)}`);

// per-window comparison summary
const winsCombined = slots.filter((s) => s.combinedR > s.baselineR).length;
const equalWindows = slots.filter((s) => s.combinedR === s.baselineR).length;
console.log(`\nwindows where combined beats baseline: ${winsCombined} / ${slots.length}`);
console.log(`combined ExpR/trade: ${(sumCombR / (sumCombN || 1)).toFixed(4)}   baseline ExpR/trade: ${(sumBaseR / (sumBaseN || 1)).toFixed(4)}`);

writeFileSync(path.join(OUT_DIR, "RESULTS.json"), JSON.stringify({
  generated: new Date().toISOString(),
  params: { TRAIN_MONTHS, TEST_MONTHS, CONF_T, feature_set: [...FEATURE_NAMES] },
  slots,
  totals: {
    baseline: { n: sumBaseN, totalR: sumBaseR, expR: sumBaseR / (sumBaseN || 1), winrate: 100 * sumBaseW / (sumBaseN || 1) },
    combined: { n: sumCombN, totalR: sumCombR, expR: sumCombR / (sumCombN || 1), winrate: 100 * sumCombW / (sumCombN || 1) },
    winsCombined, equalWindows, totalWindows: slots.length,
  },
}, null, 2));
console.log(`\nwrote ${path.join(OUT_DIR, "RESULTS.json")}`);

process.exit(0);

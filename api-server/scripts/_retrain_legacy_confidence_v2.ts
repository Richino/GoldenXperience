/**
 * Retrain the legacy-confidence-v2 model artifact.
 *
 * RESEARCH ONLY (writes only to src/data/*.json — no DB writes, no live impact).
 *
 * Trains on trailing TRAIN_MONTHS of FX-only setups from
 * backtest-legacy-expanded/trades.json ending at --as-of (default: newest trade),
 * writes the artifact to api-server/src/data/legacy-confidence-v2-model.json.
 *
 * Model shape matches api-server/src/data/binary-logistic-v1.json so a future
 * loader in paper-cycle.ts can share the same pattern.
 *
 * NOTE (production): this uses the last-known backtest dump for training data.
 * Before wiring live, we'll want a nightly job that regenerates the trailing
 * 12mo of setups + labels from live OANDA — same recipe as _backtest_legacy_expanded.ts
 * but scoped to the trailing window. That's a follow-up; today's artifact is
 * bootstrapped from the 6y dump.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

const REPO_ROOT = path.resolve(serviceRoot, "..");
const DATASET = process.env.DATASET ?? "backtest-legacy-expanded";
const TRADES_JSON = path.join(REPO_ROOT, DATASET, "trades.json");
const CACHE_DIR = path.join(REPO_ROOT, DATASET, "candles");
const OUT_ARTIFACT = path.join(serviceRoot, "src", "data", "legacy-confidence-v2-model.json");

const TRAIN_MONTHS = Number(process.env.TRAIN_MONTHS ?? "12");
const CONF_THRESHOLD = Number(process.env.CONF_THRESHOLD ?? "0.10");
const MODEL_VERSION = "1.0.0";

type Q = {
  closeTime: string; open: number; high: number; low: number; close: number;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};

function loadCandles(pair: string, gran: string): Q[] {
  const cache = path.join(CACHE_DIR, `${pair}_${gran}.json`);
  return (JSON.parse(readFileSync(cache, "utf8")) as { bars: Q[] }).bars;
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

// ---- load trades ----
type Trade = { pair: string; direction: "long" | "short"; decisionTime: string; resultR: number | null };
const raw = JSON.parse(readFileSync(TRADES_JSON, "utf8")) as { trades: Trade[] };
const allTrades = raw.trades.filter((t) => t.resultR !== null && Number.isFinite(t.resultR!));

// as-of = newest trade time (or override via env)
const asOfIso = process.env.AS_OF ?? new Date(Math.max(...allTrades.map((t) => Date.parse(t.decisionTime)))).toISOString();
const asOfMs = Date.parse(asOfIso);
const trainStartMs = asOfMs - TRAIN_MONTHS * 30 * 86400e3;

// FX-only (drop XAU per walk-forward finding — gold goes to baseline, not the model)
const trades = allTrades
  .filter((t) => t.pair !== "XAU_USD")
  .filter((t) => {
    const ts = Date.parse(t.decisionTime);
    return ts >= trainStartMs && ts <= asOfMs;
  });

console.log(`training window: ${new Date(trainStartMs).toISOString()}  →  ${asOfIso}`);
console.log(`fx trades in window: ${trades.length}`);
if (trades.length < 150) {
  console.error(`ERROR: too few training trades (${trades.length}), need >= 150`);
  process.exit(1);
}

const PAIRS = [...new Set(trades.map((t) => t.pair))];

type Feat = {
  pair: string; ts: number; decisionTime: string; direction: "long" | "short"; resultR: number;
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

console.log(`feature rows: ${feats.length}`);
if (feats.length < 150) {
  console.error(`ERROR: too few feature rows (${feats.length}), need >= 150`);
  process.exit(1);
}

const FEATURE_NAMES = ["atrPct", "atrRatio", "hourEt", "dayOfWeek", "rsiVelocity", "rangePos", "mom3"] as const;
const getVec = (f: Feat): number[] => [f.atrPct, f.atrRatio, f.hourEt, f.dayOfWeek, f.rsiVelocity, f.rangePos, f.mom3];
const longWon = (f: Feat): 1 | 0 => (((f.direction === "long" ? f.resultR : -f.resultR) > 0) ? 1 : 0);
const K = FEATURE_NAMES.length;

// standardize
const mean = new Array(K).fill(0).map((_, k) => feats.reduce((s, f) => s + getVec(f)[k]!, 0) / feats.length);
const std = new Array(K).fill(0).map((_, k) => {
  const m = mean[k]!;
  const v = feats.reduce((s, f) => s + (getVec(f)[k]! - m) ** 2, 0) / feats.length;
  return Math.sqrt(v) || 1;
});
const scale = (f: Feat) => getVec(f).map((v, k) => (v - mean[k]!) / std[k]!);

// train logistic regression
const w = new Array(K).fill(0);
let b = 0;
const lr = 0.05, epochs = 600, l2 = 0.001;
const sig = (z: number) => 1 / (1 + Math.exp(-z));
for (let ep = 0; ep < epochs; ep++) {
  const grads = new Array(K).fill(0);
  let gb = 0;
  for (const f of feats) {
    const x = scale(f);
    const y = longWon(f);
    const p = sig(x.reduce((s, xi, k) => s + xi * w[k]!, 0) + b);
    const err = p - y;
    for (let k = 0; k < K; k++) grads[k] += err * x[k]!;
    gb += err;
  }
  for (let k = 0; k < K; k++) w[k] = w[k]! - lr * (grads[k]! / feats.length + l2 * w[k]!);
  b = b - lr * (gb / feats.length);
}

// in-sample accuracy (sanity check only — not evidence of edge)
let hits = 0;
for (const f of feats) {
  const x = scale(f);
  const p = sig(x.reduce((s, xi, k) => s + xi * w[k]!, 0) + b);
  const pickedLong = p >= 0.5;
  if ((pickedLong && longWon(f) === 1) || (!pickedLong && longWon(f) === 0)) hits++;
}
console.log(`\ntrained weights:`);
FEATURE_NAMES.forEach((n, k) => console.log(`  ${n.padEnd(12)}: ${w[k]!.toFixed(4)}`));
console.log(`  ${"bias".padEnd(12)}: ${b.toFixed(4)}`);
console.log(`\nIS accuracy: ${(100 * hits / feats.length).toFixed(1)}% (sanity check, not OOS validation)`);

const coefficients: Record<string, number> = {};
const meanDict: Record<string, number> = {};
const stdDict: Record<string, number> = {};
FEATURE_NAMES.forEach((n, k) => {
  coefficients[n] = w[k]!;
  meanDict[n] = mean[k]!;
  stdDict[n] = std[k]!;
});

const artifact = {
  modelName: "legacy-confidence-v2",
  version: MODEL_VERSION,
  scoreKind: "probability" as const,
  outputMeaning: "P(long_side_wins) on legacy EMA-pullback setups (FX only, excl XAU_USD)",
  featureNames: [...FEATURE_NAMES],
  intercept: b,
  coefficients,
  normalization: { mean: meanDict, std: stdDict },
  metadata: {
    trainedAt: new Date().toISOString(),
    trainWindowStart: new Date(trainStartMs).toISOString(),
    trainWindowEnd: asOfIso,
    trainMonths: TRAIN_MONTHS,
    trainingSamples: feats.length,
    trainingPairs: PAIRS,
    excludedFromTraining: ["XAU_USD"],
    inSampleAccuracy: hits / feats.length,
    confidenceThreshold: CONF_THRESHOLD,
    combinedRule: {
      fx: `take model pick when picked != legacy stack direction AND |pLong - 0.5| >= ${CONF_THRESHOLD}`,
      XAU_USD: "always take legacy baseline (skip model)",
      other: "skip",
    },
    sourceDataset: DATASET,
  },
};

writeFileSync(OUT_ARTIFACT, JSON.stringify(artifact, null, 2));
console.log(`\nwrote ${OUT_ARTIFACT}`);
process.exit(0);

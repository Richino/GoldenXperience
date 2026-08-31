/**
 * Proper counterfactual replay of the M5 breakout confidence flip.
 *
 * The previous walk-forward used impliedR = -originalR when the model flipped
 * the direction. That's an invalid shortcut: the flipped trade would fill on
 * the OPPOSITE side of the book (ask instead of bid, or vice versa), pays a
 * fresh spread, and gets its stop/target on new price levels — not the mirror.
 *
 * This script resolves the flipped trade genuinely:
 *   - Rebuild entry on the executable side of the book (ask for flipped-long,
 *     bid for flipped-short) using the decision bar's bid/ask close
 *   - Rebuild stop and target off that new entry with the same ATR distances
 *   - Call the production labelOutcome resolver against the forward M5 candles
 *   - Record the honest flipped R
 *
 * Then rerun the walk-forward using the counterfactual R for flipped trades.
 * Compare vs the invalid mirror-inversion result.
 *
 * RESEARCH ONLY. Reads local candle cache + trades.json. No DB writes.
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
const CACHE_DIR = path.join(REPO_ROOT, "backtest-breakout-m5", "candles");
const TRADES = path.join(REPO_ROOT, "backtest-breakout-m5", "trades.json");
const OUT_DIR = path.join(serviceRoot, "research-v2", "confidence-breakout-m5-counterfactual-v1");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

type Q = {
  closeTime: string; open: number; high: number; low: number; close: number;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};
type Trade = {
  pair: string; direction: "long" | "short"; decisionTime: string;
  entry: number; stop: number; target: number;
  stopPips: number; targetPips: number; spreadPips: number;
  atrPips: number; rangeWidthAtr: number; sessionHourEt: number;
  outcome: string; resultR: number | null;
};

function pipSizeFor(inst: string): number { return inst.endsWith("JPY") ? 0.01 : 0.0001; }

const candleCache = new Map<string, Q[]>();
function loadCandles(pair: string): Q[] {
  if (candleCache.has(pair)) return candleCache.get(pair)!;
  const file = path.join(CACHE_DIR, `${pair}_M5.json`);
  const bars = (JSON.parse(readFileSync(file, "utf8")) as { bars: Q[] }).bars;
  candleCache.set(pair, bars);
  return bars;
}
function idxAtOrBefore(bars: Q[], iso: string): number {
  const t = Date.parse(iso);
  let lo = 0, hi = bars.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (Date.parse(bars[m]!.closeTime) <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  return k;
}

const raw = JSON.parse(readFileSync(TRADES, "utf8")) as { trades: Trade[] };
const trades = raw.trades.filter((t) => t.resultR !== null && Number.isFinite(t.resultR!));
console.log(`m5 trades: ${trades.length}`);

// ---- Compute counterfactual flipped R for every trade ----
type Augmented = Trade & {
  flippedR: number | null;
  flippedOutcome: string;
  flippedEntry: number;
  flippedStop: number;
  flippedTarget: number;
  mirrorR: number; // the invalid shortcut = -resultR
};
const augmented: Augmented[] = [];
let ambiguous = 0, missingIdx = 0;

for (const t of trades) {
  const bars = loadCandles(t.pair);
  const i = idxAtOrBefore(bars, t.decisionTime);
  if (i < 0 || i >= bars.length - 1) { missingIdx++; continue; }
  const bar = bars[i]!;

  const flipDir: "long" | "short" = t.direction === "long" ? "short" : "long";
  // Same ATR-based stop distance as the original setup (STOP_ATR * ATR = |entry - stop| of original)
  const stopDist = Math.abs(t.entry - t.stop);
  const targetDist = Math.abs(t.target - t.entry);
  // NEW entry on the flipped side of the book — this is the whole point
  const flippedEntry = flipDir === "long" ? bar.askClose : bar.bidClose;
  const flippedStop = flipDir === "long" ? flippedEntry - stopDist : flippedEntry + stopDist;
  const flippedTarget = flipDir === "long" ? flippedEntry + targetDist : flippedEntry - targetDist;

  const forward = bars.slice(i + 1);
  const res = labelOutcome(flipDir, flippedEntry, flippedStop, flippedTarget, bar.closeTime, forward as never);
  let flippedR: number | null = res.resultR;
  if (res.outcome === "ambiguous" || flippedR === null || !Number.isFinite(flippedR)) {
    flippedR = null;
    ambiguous++;
  }

  augmented.push({
    ...t,
    flippedR,
    flippedOutcome: res.outcome,
    flippedEntry, flippedStop, flippedTarget,
    mirrorR: -t.resultR!,
  });
}
console.log(`augmented: ${augmented.length}  (ambiguous=${ambiguous}, missingIdx=${missingIdx})`);
augmented.sort((a, b) => Date.parse(a.decisionTime) - Date.parse(b.decisionTime));

// ---- Retrain + walk-forward, using COUNTERFACTUAL flipped R ----
function etHour(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(iso));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}
function etDay(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).formatToParts(new Date(iso));
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[wd] ?? 0;
}
function sessionOf(hour: number): string {
  if (hour >= 8 && hour < 12) return "overlap";
  if (hour >= 3 && hour < 8) return "london";
  if (hour >= 12 && hour < 17) return "ny";
  return "off";
}
function longWon(t: Trade): 1 | 0 {
  return ((t.direction === "long" && t.resultR! > 0) || (t.direction === "short" && t.resultR! < 0)) ? 1 : 0;
}

const SESSIONS = ["london", "overlap", "ny", "off"];
const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"];
const FEATURE_NAMES = [
  ...SESSIONS.map((s) => `session_${s}`),
  ...PAIRS.map((p) => `pair_${p}`),
  "atrPips", "rangeWidthAtr", "spreadPips", "hourEt", "dayOfWeek",
];
function vec(t: Trade): number[] {
  const s = sessionOf(t.sessionHourEt);
  return [
    ...SESSIONS.map((sn) => s === sn ? 1 : 0),
    ...PAIRS.map((p) => t.pair === p ? 1 : 0),
    t.atrPips, t.rangeWidthAtr, t.spreadPips, t.sessionHourEt, etDay(t.decisionTime),
  ];
}
const K = FEATURE_NAMES.length;

function trainLogistic(IS: Augmented[]) {
  const mean = new Array(K).fill(0).map((_, k) => IS.reduce((s, t) => s + vec(t)[k]!, 0) / IS.length);
  const std = new Array(K).fill(0).map((_, k) => {
    const m = mean[k]!;
    const v = IS.reduce((s, t) => s + (vec(t)[k]! - m) ** 2, 0) / IS.length;
    return Math.sqrt(v) || 1;
  });
  const w = new Array(K).fill(0);
  let b = 0;
  const lr = 0.05, epochs = 300, l2 = 0.001;
  const sig = (z: number) => 1 / (1 + Math.exp(-z));
  for (let ep = 0; ep < epochs; ep++) {
    const grads = new Array(K).fill(0);
    let gb = 0;
    for (const t of IS) {
      const x = vec(t).map((v, k) => (v - mean[k]!) / std[k]!);
      const y = longWon(t);
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
function predict(t: Augmented, m: { w: number[]; b: number; mean: number[]; std: number[] }): number {
  const x = vec(t).map((v, k) => (v - m.mean[k]!) / m.std[k]!);
  const z = x.reduce((s, xi, k) => s + xi * m.w[k]!, 0) + m.b;
  return 1 / (1 + Math.exp(-z));
}

const MS_MONTH = 30 * 86400e3;
const TRAIN_MONTHS = 6;
const TEST_MONTHS = 2;
const firstMs = Date.parse(augmented[0]!.decisionTime);
const lastMs = Date.parse(augmented[augmented.length - 1]!.decisionTime);

type Result = { n: number; wins: number; totalR: number; winrate: number; expR: number };
const empty = (): Result => ({ n: 0, wins: 0, totalR: 0, winrate: 0, expR: 0 });

const thresholds = [0.00, 0.05, 0.10, 0.15];
const perThreshCounter: Record<number, Result> = {};
const perThreshMirror: Record<number, Result> = {};
for (const t of thresholds) { perThreshCounter[t] = empty(); perThreshMirror[t] = empty(); }

let testStart = firstMs + TRAIN_MONTHS * MS_MONTH;
let windowCount = 0;

let baselineN = 0, baselineR = 0, baselineWins = 0;
let ambiguousFlips = 0;

while (testStart + TEST_MONTHS * MS_MONTH <= lastMs + MS_MONTH) {
  const trainStart = testStart - TRAIN_MONTHS * MS_MONTH;
  const train = augmented.filter((t) => {
    const d = Date.parse(t.decisionTime);
    return d >= trainStart && d < testStart;
  });
  const test = augmented.filter((t) => {
    const d = Date.parse(t.decisionTime);
    return d >= testStart && d < testStart + TEST_MONTHS * MS_MONTH;
  });
  if (train.length < 300 || test.length < 100) { testStart += TEST_MONTHS * MS_MONTH; continue; }
  const model = trainLogistic(train);
  windowCount++;
  for (const t of test) {
    baselineN++;
    baselineR += t.resultR!;
    if (t.resultR! > 0) baselineWins++;
    const pLong = predict(t, model);
    const picked: "long" | "short" = pLong >= 0.5 ? "long" : "short";
    if (picked === t.direction) continue;
    const conf = Math.abs(pLong - 0.5);
    for (const thr of thresholds) {
      if (conf >= thr) {
        // Counterfactual (proper)
        if (t.flippedR !== null) {
          const rc = perThreshCounter[thr]!;
          rc.n++; rc.totalR += t.flippedR;
          if (t.flippedR > 0) rc.wins++;
        } else {
          ambiguousFlips++;
        }
        // Mirror (invalid shortcut)
        const rm = perThreshMirror[thr]!;
        rm.n++; rm.totalR += t.mirrorR;
        if (t.mirrorR > 0) rm.wins++;
      }
    }
  }
  testStart += TEST_MONTHS * MS_MONTH;
}
for (const t of thresholds) {
  const rc = perThreshCounter[t]!; rc.winrate = rc.n ? 100 * rc.wins / rc.n : 0; rc.expR = rc.n ? rc.totalR / rc.n : 0;
  const rm = perThreshMirror[t]!; rm.winrate = rm.n ? 100 * rm.wins / rm.n : 0; rm.expR = rm.n ? rm.totalR / rm.n : 0;
}

console.log(`\nwalk-forward: TRAIN=${TRAIN_MONTHS}mo TEST=${TEST_MONTHS}mo, ${windowCount} windows`);
console.log(`ambiguous flips (dropped): ${ambiguousFlips}`);
console.log(`\nBaseline (take all, no flip): n=${baselineN} winrate=${(100 * baselineWins / baselineN).toFixed(1)}% totalR=${baselineR.toFixed(2)} expR=${(baselineR / baselineN).toFixed(4)}`);

console.log(`\n=== INVALID MIRROR SHORTCUT (previous claim) ===`);
console.log(`  threshold   n     winrate    totalR      expR`);
for (const t of thresholds) {
  const r = perThreshMirror[t]!;
  console.log(`  ${t.toFixed(2)}       ${String(r.n).padStart(5)}   ${r.winrate.toFixed(1).padStart(5)}%   ${(r.totalR >= 0 ? "+" : "") + r.totalR.toFixed(2).padStart(8)}   ${r.expR.toFixed(4).padStart(7)}`);
}

console.log(`\n=== PROPER COUNTERFACTUAL (bid/ask replay) ===`);
console.log(`  threshold   n     winrate    totalR      expR`);
for (const t of thresholds) {
  const r = perThreshCounter[t]!;
  console.log(`  ${t.toFixed(2)}       ${String(r.n).padStart(5)}   ${r.winrate.toFixed(1).padStart(5)}%   ${(r.totalR >= 0 ? "+" : "") + r.totalR.toFixed(2).padStart(8)}   ${r.expR.toFixed(4).padStart(7)}`);
}

writeFileSync(path.join(OUT_DIR, "RESULTS.json"), JSON.stringify({
  generated: new Date().toISOString(),
  augmentedRows: augmented.length,
  ambiguousCounterfactuals: ambiguous,
  ambiguousFlipsInWalkForward: ambiguousFlips,
  baseline: { n: baselineN, totalR: baselineR, winrate: 100 * baselineWins / baselineN },
  mirror: perThreshMirror,
  counterfactual: perThreshCounter,
}, null, 2));
console.log(`\nwrote ${path.join(OUT_DIR, "RESULTS.json")}`);
process.exit(0);

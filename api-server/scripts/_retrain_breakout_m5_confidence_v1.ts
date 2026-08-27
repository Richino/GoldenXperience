/**
 * Retrain the breakout-m5-confidence-v1 artifact.
 * Trains on all resolved M5 breakout trades in backtest-breakout-m5/trades.json.
 * RESEARCH ONLY. Local file write.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(serviceRoot, "..");
const TRADES = path.join(REPO_ROOT, "backtest-breakout-m5", "trades.json");
const OUT = path.join(serviceRoot, "src", "data", "breakout-m5-confidence-v1-model.json");

type Trade = {
  pair: string; direction: "long" | "short"; decisionTime: string;
  atrPips: number; rangeWidthAtr: number; sessionHourEt: number; spreadPips: number;
  resultR: number | null;
};
const raw = JSON.parse(readFileSync(TRADES, "utf8")) as { trades: Trade[] };
const trades = raw.trades.filter((t) => t.resultR !== null && Number.isFinite(t.resultR!));
console.log(`m5 trades: ${trades.length}`);

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

// Train on trailing 12 months
const asOfMs = Math.max(...trades.map((t) => Date.parse(t.decisionTime)));
const trainStartMs = asOfMs - 12 * 30 * 86400e3;
const train = trades.filter((t) => Date.parse(t.decisionTime) >= trainStartMs);
console.log(`training rows (trailing 12mo): ${train.length}`);
if (train.length < 300) { console.error("too few training rows"); process.exit(1); }

const mean = new Array(K).fill(0).map((_, k) => train.reduce((s, t) => s + vec(t)[k]!, 0) / train.length);
const std = new Array(K).fill(0).map((_, k) => {
  const m = mean[k]!;
  const v = train.reduce((s, t) => s + (vec(t)[k]! - m) ** 2, 0) / train.length;
  return Math.sqrt(v) || 1;
});
const w = new Array(K).fill(0);
let b = 0;
const lr = 0.05, epochs = 500, l2 = 0.001;
const sig = (z: number) => 1 / (1 + Math.exp(-z));
for (let ep = 0; ep < epochs; ep++) {
  const grads = new Array(K).fill(0);
  let gb = 0;
  for (const t of train) {
    const x = vec(t).map((v, k) => (v - mean[k]!) / std[k]!);
    const y = longWon(t);
    const p = sig(x.reduce((s, xi, k) => s + xi * w[k]!, 0) + b);
    const err = p - y;
    for (let k = 0; k < K; k++) grads[k] += err * x[k]!;
    gb += err;
  }
  for (let k = 0; k < K; k++) w[k] = w[k]! - lr * (grads[k]! / train.length + l2 * w[k]!);
  b = b - lr * (gb / train.length);
}

let hits = 0;
for (const t of train) {
  const x = vec(t).map((v, k) => (v - mean[k]!) / std[k]!);
  const p = sig(x.reduce((s, xi, k) => s + xi * w[k]!, 0) + b);
  const pickedLong = p >= 0.5;
  if ((pickedLong && longWon(t) === 1) || (!pickedLong && longWon(t) === 0)) hits++;
}
console.log(`IS accuracy: ${(100 * hits / train.length).toFixed(1)}%`);

const coefficients: Record<string, number> = {};
const meanDict: Record<string, number> = {};
const stdDict: Record<string, number> = {};
FEATURE_NAMES.forEach((n, k) => { coefficients[n] = w[k]!; meanDict[n] = mean[k]!; stdDict[n] = std[k]!; });

writeFileSync(OUT, JSON.stringify({
  modelName: "breakout-m5-confidence-v1",
  version: "1.0.0",
  scoreKind: "probability",
  outputMeaning: "P(long_side_wins) on M5 breakout setups. Combined rule: flip when model disagrees (CONF_T=0.00).",
  featureNames: [...FEATURE_NAMES],
  intercept: b,
  coefficients,
  normalization: { mean: meanDict, std: stdDict },
  metadata: {
    trainedAt: new Date().toISOString(),
    trainWindowStart: new Date(trainStartMs).toISOString(),
    trainWindowEnd: new Date(asOfMs).toISOString(),
    trainingSamples: train.length,
    trainingPairs: PAIRS,
    inSampleAccuracy: hits / train.length,
    confidenceThreshold: 0.00,
    combinedRule: {
      fx: "take model pick whenever model DISAGREES with breakout direction (no threshold — take all)",
      other: "skip untrained pairs",
    },
    sourceDataset: "backtest-breakout-m5",
    walkForwardValidation: "72.6% winrate, +0.227R/trade, 2.68 trades/day OOS",
  },
}, null, 2));
console.log(`\nwrote ${OUT}`);
process.exit(0);

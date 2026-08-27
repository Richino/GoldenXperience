/**
 * Retrain the breakout-confidence-v1 artifact.
 *
 * Trains on the 8,316 breakout opportunities in the four-family adaptive
 * historical dataset (EUR/GBP/USD_JPY, 2016-2025). Writes the artifact to
 * src/data/breakout-confidence-v1-model.json.
 *
 * RESEARCH ONLY. Local file write, no DB.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPP_FILE = path.join(serviceRoot, "research-v2", "four-family-adaptive-historical-v1", "opportunities.jsonl");
const OUT_ARTIFACT = path.join(serviceRoot, "src", "data", "breakout-confidence-v1-model.json");

type Opp = {
  ms: number; ts: string; family: string; pair: string; direction: "long" | "short";
  quality: number; spreadPips: number; atrPips: number;
  session: string; regime: string; trendStrength: number; volBucket: string;
  netR: number;
};

const raw = readFileSync(OPP_FILE, "utf8").trim().split("\n").filter(Boolean);
const rows: Opp[] = raw.map((line) => JSON.parse(line))
  .filter((r: Opp) => r.family === "breakout" && Number.isFinite(r.netR));
rows.sort((a, b) => a.ms - b.ms);
console.log(`breakout opportunities: ${rows.length}`);

function etHour(ms: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(ms));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}
function etDay(ms: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).formatToParts(new Date(ms));
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[wd] ?? 0;
}
function longWon(r: Opp): 1 | 0 {
  return ((r.direction === "long" && r.netR > 0) || (r.direction === "short" && r.netR < 0)) ? 1 : 0;
}

const SESSIONS = ["London", "New York", "London/New York overlap", "Off"];
const REGIMES = ["trending", "ranging", "mixed"];
const VOL_BUCKETS = ["low", "normal", "high"];
const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"];
const FEATURE_NAMES = [
  ...SESSIONS.map((s) => `session_${s.replace(/[^A-Za-z]/g, "")}`),
  ...REGIMES.map((r) => `regime_${r}`),
  ...VOL_BUCKETS.map((v) => `vol_${v}`),
  ...PAIRS.map((p) => `pair_${p}`),
  "trendStrength", "atrPips", "spreadPips", "quality", "hourEt", "dayOfWeek",
];
function vec(r: Opp): number[] {
  return [
    ...SESSIONS.map((s) => r.session === s ? 1 : 0),
    ...REGIMES.map((rg) => r.regime === rg ? 1 : 0),
    ...VOL_BUCKETS.map((v) => r.volBucket === v ? 1 : 0),
    ...PAIRS.map((p) => r.pair === p ? 1 : 0),
    r.trendStrength, r.atrPips, r.spreadPips, r.quality, etHour(r.ms), etDay(r.ms),
  ];
}
const K = FEATURE_NAMES.length;

// train on the trailing 24 months (or all if less)
const asOfMs = rows[rows.length - 1]!.ms;
const trainStartMs = asOfMs - 24 * 30 * 86400e3;
const train = rows.filter((r) => r.ms >= trainStartMs);
console.log(`training rows (trailing 24mo): ${train.length}`);
if (train.length < 200) { console.error("too few training rows"); process.exit(1); }

const mean = new Array(K).fill(0).map((_, k) => train.reduce((s, r) => s + vec(r)[k]!, 0) / train.length);
const std = new Array(K).fill(0).map((_, k) => {
  const m = mean[k]!;
  const v = train.reduce((s, r) => s + (vec(r)[k]! - m) ** 2, 0) / train.length;
  return Math.sqrt(v) || 1;
});
const scale = (r: Opp) => vec(r).map((v, k) => (v - mean[k]!) / std[k]!);
const w = new Array(K).fill(0);
let b = 0;
const lr = 0.05, epochs = 500, l2 = 0.001;
const sig = (z: number) => 1 / (1 + Math.exp(-z));
for (let ep = 0; ep < epochs; ep++) {
  const grads = new Array(K).fill(0);
  let gb = 0;
  for (const r of train) {
    const x = scale(r);
    const y = longWon(r);
    const p = sig(x.reduce((s, xi, k) => s + xi * w[k]!, 0) + b);
    const err = p - y;
    for (let k = 0; k < K; k++) grads[k] += err * x[k]!;
    gb += err;
  }
  for (let k = 0; k < K; k++) w[k] = w[k]! - lr * (grads[k]! / train.length + l2 * w[k]!);
  b = b - lr * (gb / train.length);
}

let hits = 0;
for (const r of train) {
  const x = scale(r);
  const p = sig(x.reduce((s, xi, k) => s + xi * w[k]!, 0) + b);
  const pickedLong = p >= 0.5;
  if ((pickedLong && longWon(r) === 1) || (!pickedLong && longWon(r) === 0)) hits++;
}
console.log(`IS accuracy: ${(100 * hits / train.length).toFixed(1)}%`);

const coefficients: Record<string, number> = {};
const meanDict: Record<string, number> = {};
const stdDict: Record<string, number> = {};
FEATURE_NAMES.forEach((n, k) => { coefficients[n] = w[k]!; meanDict[n] = mean[k]!; stdDict[n] = std[k]!; });

const artifact = {
  modelName: "breakout-confidence-v1",
  version: "1.0.0",
  scoreKind: "probability" as const,
  outputMeaning: "P(long_side_wins) on breakout-family setups. Combined rule: flip when confident disagreement.",
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
    confidenceThreshold: 0.10,
    combinedRule: {
      fx: `take model pick when picked != breakout direction AND |pLong - 0.5| >= 0.10`,
      other: "skip",
    },
    sourceDataset: "four-family-adaptive-historical-v1",
  },
};
writeFileSync(OUT_ARTIFACT, JSON.stringify(artifact, null, 2));
console.log(`\nwrote ${OUT_ARTIFACT}`);
process.exit(0);

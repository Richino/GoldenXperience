/**
 * Walk-forward confidence test on M5 breakout scalper.
 * Same rule as M15 breakout: flip when model disagrees + confidence, skip else.
 * RESEARCH ONLY.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(serviceRoot, "..");
const TRADES = path.join(REPO_ROOT, "backtest-breakout-m5", "trades.json");
const OUT_DIR = path.join(serviceRoot, "research-v2", "confidence-breakout-m5-walkforward-v1");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

type Trade = {
  pair: string; direction: "long" | "short"; decisionTime: string;
  atrPips: number; rangeWidthAtr: number; sessionHourEt: number; spreadPips: number;
  outcome: string; resultR: number | null;
};
const raw = JSON.parse(readFileSync(TRADES, "utf8")) as { trades: Trade[] };
const trades = raw.trades.filter((t) => t.resultR !== null && Number.isFinite(t.resultR!));
trades.sort((a, b) => Date.parse(a.decisionTime) - Date.parse(b.decisionTime));
console.log(`M5 trades: ${trades.length}`);

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
  const session = sessionOf(t.sessionHourEt);
  return [
    ...SESSIONS.map((s) => session === s ? 1 : 0),
    ...PAIRS.map((p) => t.pair === p ? 1 : 0),
    t.atrPips, t.rangeWidthAtr, t.spreadPips, t.sessionHourEt, etDay(t.decisionTime),
  ];
}
const K = FEATURE_NAMES.length;

function trainLogistic(IS: Trade[]) {
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
function predict(t: Trade, m: { w: number[]; b: number; mean: number[]; std: number[] }): number {
  const x = vec(t).map((v, k) => (v - m.mean[k]!) / m.std[k]!);
  const z = x.reduce((s, xi, k) => s + xi * m.w[k]!, 0) + m.b;
  return 1 / (1 + Math.exp(-z));
}

const MS_MONTH = 30 * 86400e3;
const TRAIN_MONTHS = 6;
const TEST_MONTHS = 2;

const firstMs = Date.parse(trades[0]!.decisionTime);
const lastMs = Date.parse(trades[trades.length - 1]!.decisionTime);

const thresholds = [0.00, 0.05, 0.10, 0.15, 0.20];
type Row = { threshold: number; n: number; wins: number; totalR: number; expR: number; winrate: number };
const results: Record<number, Row> = {};
for (const t of thresholds) results[t] = { threshold: t, n: 0, wins: 0, totalR: 0, expR: 0, winrate: 0 };

let testStart = firstMs + TRAIN_MONTHS * MS_MONTH;
let windowCount = 0, totalBaselineN = 0, totalBaselineR = 0, totalBaselineWins = 0;

while (testStart + TEST_MONTHS * MS_MONTH <= lastMs + MS_MONTH) {
  const trainStart = testStart - TRAIN_MONTHS * MS_MONTH;
  const train = trades.filter((t) => Date.parse(t.decisionTime) >= trainStart && Date.parse(t.decisionTime) < testStart);
  const test = trades.filter((t) => Date.parse(t.decisionTime) >= testStart && Date.parse(t.decisionTime) < testStart + TEST_MONTHS * MS_MONTH);
  if (train.length < 300 || test.length < 100) { testStart += TEST_MONTHS * MS_MONTH; continue; }
  const model = trainLogistic(train);
  windowCount++;
  for (const t of test) {
    totalBaselineN++;
    totalBaselineR += t.resultR!;
    if (t.resultR! > 0) totalBaselineWins++;
    const pLong = predict(t, model);
    const picked: "long" | "short" = pLong >= 0.5 ? "long" : "short";
    if (picked === t.direction) continue;
    // Model disagrees
    const conf = Math.abs(pLong - 0.5);
    for (const thr of thresholds) {
      if (conf >= thr) {
        const impR = -t.resultR!;
        const row = results[thr]!;
        row.n++;
        row.totalR += impR;
        if (impR > 0) row.wins++;
      }
    }
  }
  testStart += TEST_MONTHS * MS_MONTH;
}
for (const t of thresholds) {
  const r = results[t]!;
  r.expR = r.n ? r.totalR / r.n : 0;
  r.winrate = r.n ? 100 * r.wins / r.n : 0;
}

const testDaysSpan = trades.filter((t) => Date.parse(t.decisionTime) >= firstMs + TRAIN_MONTHS * MS_MONTH).length > 0
  ? (lastMs - (firstMs + TRAIN_MONTHS * MS_MONTH)) / 86400e3
  : 1;

console.log(`\nwalk-forward: TRAIN=${TRAIN_MONTHS}mo TEST=${TEST_MONTHS}mo, ${windowCount} windows, span=${testDaysSpan.toFixed(0)} days OOS`);
console.log(`\nBaseline (take all M5 breakouts): n=${totalBaselineN} winrate=${(100 * totalBaselineWins / totalBaselineN).toFixed(1)}% totalR=${totalBaselineR.toFixed(2)} expR=${(totalBaselineR / totalBaselineN).toFixed(4)}`);
console.log(`\nCombined (flip confident disagreements) by threshold:`);
console.log(`  threshold  taken   winrate    totalR    expR     ~trades/day`);
for (const thr of thresholds) {
  const r = results[thr]!;
  const perDay = r.n / testDaysSpan;
  console.log(`  ${thr.toFixed(2)}       ${String(r.n).padStart(6)}   ${r.winrate.toFixed(1).padStart(5)}%    ${(r.totalR >= 0 ? "+" : "") + r.totalR.toFixed(2).padStart(8)}   ${r.expR.toFixed(4).padStart(7)}   ${perDay.toFixed(2)}`);
}

writeFileSync(path.join(OUT_DIR, "RESULTS.json"), JSON.stringify({
  generated: new Date().toISOString(),
  baseline: { n: totalBaselineN, totalR: totalBaselineR, winrate: 100 * totalBaselineWins / totalBaselineN },
  byThreshold: results,
  testDaysSpan,
}, null, 2));
console.log(`\nwrote ${path.join(OUT_DIR, "RESULTS.json")}`);
process.exit(0);

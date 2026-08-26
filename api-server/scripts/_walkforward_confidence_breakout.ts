/**
 * Walk-forward confidence test on the breakout family.
 *
 * Uses the 8,316 breakout opportunities from
 * research-v2/four-family-adaptive-historical-v1/opportunities.jsonl
 * (3 pairs: EUR/GBP/USD_JPY, 2016-2025).
 *
 * Features (from the opportunity row, no candle history needed):
 *   session, regime, volBucket (one-hot)
 *   trendStrength, atrPips, spreadPips, quality, hourEt, dayOfWeek (numeric)
 *
 * Model: logistic regression predicting P(long side wins on this bar).
 * Rule: take model pick when it disagrees with strategy direction AND
 *       |pLong - 0.5| >= 0.10. Otherwise skip.
 * Baseline: take every breakout setup at its strategy-chosen direction.
 *
 * RESEARCH ONLY.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPP_FILE = path.join(serviceRoot, "research-v2", "four-family-adaptive-historical-v1", "opportunities.jsonl");
const OUT_DIR = path.join(serviceRoot, "research-v2", "confidence-breakout-walkforward-v1");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

type Opp = {
  ms: number; ts: string; family: string; pair: string; direction: "long" | "short";
  entry: number; stop: number; target: number; plannedR: number; quality: number;
  spreadPips: number; atr: number; atrPips: number;
  session: string; regime: string; trendStrength: number; volBucket: string;
  outcome: string; netR: number; costR: number;
};

// ---- load + filter to breakout ----
const raw = readFileSync(OPP_FILE, "utf8").trim().split("\n").filter(Boolean);
const all: Opp[] = raw.map((line) => JSON.parse(line));
const rows = all.filter((r) => r.family === "breakout" && Number.isFinite(r.netR));
rows.sort((a, b) => a.ms - b.ms);
console.log(`total breakout opportunities: ${rows.length}`);

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

// ---- feature vector (18 features with one-hots) ----
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

function trainLogistic(IS: Opp[]) {
  const mean = new Array(K).fill(0).map((_, k) => IS.reduce((s, f) => s + vec(f)[k]!, 0) / IS.length);
  const std = new Array(K).fill(0).map((_, k) => {
    const m = mean[k]!;
    const v = IS.reduce((s, f) => s + (vec(f)[k]! - m) ** 2, 0) / IS.length;
    return Math.sqrt(v) || 1;
  });
  const scale = (r: Opp) => vec(r).map((v, k) => (v - mean[k]!) / std[k]!);
  const w = new Array(K).fill(0);
  let b = 0;
  const lr = 0.05, epochs = 400, l2 = 0.001;
  const sig = (z: number) => 1 / (1 + Math.exp(-z));
  for (let ep = 0; ep < epochs; ep++) {
    const grads = new Array(K).fill(0);
    let gb = 0;
    for (const r of IS) {
      const x = scale(r);
      const y = longWon(r);
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
function predict(r: Opp, m: { w: number[]; b: number; mean: number[]; std: number[] }): number {
  const x = vec(r).map((v, k) => (v - m.mean[k]!) / m.std[k]!);
  const z = x.reduce((s, xi, k) => s + xi * m.w[k]!, 0) + m.b;
  return 1 / (1 + Math.exp(-z));
}

const MS_MONTH = 30 * 86400e3;
const TRAIN_MONTHS = 12;
const TEST_MONTHS = 3;
const CONF_T = 0.10;
const firstMs = rows[0]!.ms;
const lastMs = rows[rows.length - 1]!.ms;

type Slot = {
  windowStart: string; windowEnd: string; trainN: number; testN: number;
  baselineN: number; baselineR: number; baselineWr: number;
  combinedN: number; combinedR: number; combinedWr: number;
};
const slots: Slot[] = [];

let testStart = firstMs + TRAIN_MONTHS * MS_MONTH;
while (testStart + TEST_MONTHS * MS_MONTH <= lastMs + MS_MONTH) {
  const trainStart = testStart - TRAIN_MONTHS * MS_MONTH;
  const trainEnd = testStart;
  const testEnd = testStart + TEST_MONTHS * MS_MONTH;
  const train = rows.filter((r) => r.ms >= trainStart && r.ms < trainEnd);
  const test = rows.filter((r) => r.ms >= testStart && r.ms < testEnd);
  if (train.length < 100 || test.length < 20) { testStart += TEST_MONTHS * MS_MONTH; continue; }

  const model = trainLogistic(train);
  let bN = 0, bW = 0, bR = 0, cN = 0, cW = 0, cR = 0;
  for (const r of test) {
    bN++; bR += r.netR; if (r.netR > 0) bW++;
    const pLong = predict(r, model);
    const picked: "long" | "short" = pLong >= 0.5 ? "long" : "short";
    if (picked !== r.direction && Math.abs(pLong - 0.5) >= CONF_T) {
      cN++;
      const impR = -r.netR;
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
  });
  testStart += TEST_MONTHS * MS_MONTH;
}

console.log(`\nwalk-forward: TRAIN=${TRAIN_MONTHS}mo  TEST=${TEST_MONTHS}mo  CONF_T=${CONF_T}`);
console.log(`\nwindow                       BASE (all)          COMB (flip confident)`);
console.log(`                              n    wr    totalR      n     wr    totalR`);
let sB_N = 0, sB_W = 0, sB_R = 0, sC_N = 0, sC_W = 0, sC_R = 0;
for (const s of slots) {
  const bw = Math.round(s.baselineWr * s.baselineN / 100);
  const cw = Math.round(s.combinedWr * s.combinedN / 100);
  console.log(
    `  ${s.windowStart} → ${s.windowEnd}   ${String(s.baselineN).padStart(4)}  ${s.baselineWr.toFixed(0).padStart(3)}%  ${(s.baselineR >= 0 ? "+" : "") + s.baselineR.toFixed(2).padStart(7)}    ${String(s.combinedN).padStart(4)}   ${s.combinedWr.toFixed(0).padStart(3)}%  ${(s.combinedR >= 0 ? "+" : "") + s.combinedR.toFixed(2).padStart(7)}`
  );
  sB_N += s.baselineN; sB_W += bw; sB_R += s.baselineR;
  sC_N += s.combinedN; sC_W += cw; sC_R += s.combinedR;
}
console.log(`  ${"TOTAL".padEnd(30)}${String(sB_N).padStart(4)}  ${(100 * sB_W / (sB_N || 1)).toFixed(0).padStart(3)}%  ${(sB_R >= 0 ? "+" : "") + sB_R.toFixed(2).padStart(7)}    ${String(sC_N).padStart(4)}   ${(100 * sC_W / (sC_N || 1)).toFixed(0).padStart(3)}%  ${(sC_R >= 0 ? "+" : "") + sC_R.toFixed(2).padStart(7)}`);

console.log(`\nexpR/trade:  baseline=${(sB_R / (sB_N || 1)).toFixed(4)}   combined=${(sC_R / (sC_N || 1)).toFixed(4)}`);
console.log(`combined beats baseline in ${slots.filter((s) => s.combinedR > s.baselineR).length}/${slots.length} windows`);

writeFileSync(path.join(OUT_DIR, "RESULTS.json"), JSON.stringify({
  generated: new Date().toISOString(),
  params: { TRAIN_MONTHS, TEST_MONTHS, CONF_T, family: "breakout", features: FEATURE_NAMES },
  totals: {
    baseline: { n: sB_N, totalR: sB_R, expR: sB_R / (sB_N || 1), winrate: 100 * sB_W / (sB_N || 1) },
    combined: { n: sC_N, totalR: sC_R, expR: sC_R / (sC_N || 1), winrate: 100 * sC_W / (sC_N || 1) },
    windowsBeatBaseline: slots.filter((s) => s.combinedR > s.baselineR).length,
    totalWindows: slots.length,
  },
  slots,
}, null, 2));
console.log(`\nwrote ${path.join(OUT_DIR, "RESULTS.json")}`);
process.exit(0);

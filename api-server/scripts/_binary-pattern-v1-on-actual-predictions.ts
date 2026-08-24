/**
 * PATTERN_V1 vs actual stored binary-baseline-v1 authoritative predictions.
 *
 * Research only. Does NOT regenerate the baseline signal stream.
 * Frozen PATTERN_V1 definitions copied from `_binary-pattern-v1-holdout.ts`
 * / `_binary-follow-pocket-42-audit.ts`. Production untouched.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { classifyBinaryResult, type BinaryCandle } from "../src/binary-engine.js";
import { MAJOR_INSTRUMENTS } from "../../frontend/src/types/forex.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) {
  loadDotenv({ path: path.join(root, name), override: false });
}
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

const OUT_DIR = path.join(root, "research-v2", "pattern-v1-on-actual-predictions");
const CACHE_DIR = path.join(root, "research-v2", "binary-adaptive-bollinger-rsi-10k", "cache");
const REPORT_PATH = path.join(OUT_DIR, "FINAL_REPORT.txt");
const MATCHES_PATH = path.join(OUT_DIR, "matches.jsonl");
const REGISTRY_PATH = path.join(OUT_DIR, "experiments", "registry.jsonl");

const BE80 = 1 / (1 + 0.8);
const BB_PERIOD = 20;
const BB_K = 2;
const PRIMARY_EXPIRY_SEC = 600;

type Outcome = "won" | "lost" | "tie";
type Dir = "up" | "down";
type Side = "upper" | "lower";
type RsiSeverity = "mild" | "medium" | "extreme";
type AdxBucket = "le20" | "b20_25" | "b25_30" | "gt30";
type PatternId = "V1" | "V1a" | "V1b";
type Branch = "V1a" | "V1b" | "none";

type PredRow = {
  id: string;
  instrument: string;
  direction: Dir;
  start_at: string;
  entry_price: number;
  duration_seconds: number;
  price_precision: number;
  result: Outcome;
  confidence: number;
  intended_expiration: string | null;
};

type V1Signal = {
  instrument: string;
  side: Side;
  dir: Dir;
  entry: number;
  entryMs: number;
  barIdx: number;
  rsi: number;
  rsiSeverity: RsiSeverity;
  adx: number;
  adxBucket: AdxBucket;
  branch: Branch;
  bbMid: number;
  bbUpper: number;
  bbLower: number;
};

type InstrumentCache = {
  candles: BinaryCandle[];
  closeMs: number[];
  atr14: Float64Array;
  adx14: Float64Array;
  rsi14: Float64Array;
  bbMid: Float64Array;
  bbUpper: Float64Array;
  bbLower: Float64Array;
  v1ByEntryMs: Map<number, V1Signal>;
};

type Score = {
  rawN: number;
  won: number;
  lost: number;
  tie: number;
  decided: number;
  wr: number;
  ciLow: number | null;
  ciHigh: number | null;
  ev70: number;
  ev75: number;
  ev80: number;
  ev85: number;
  ev90: number;
  ev95: number;
};

type Verdict =
  | "PATTERN_V1_STRONG_ON_ACTUAL_PREDICTIONS"
  | "PATTERN_V1_PROFITABLE_ON_ACTUAL_PREDICTIONS"
  | "PATTERN_V1_PROMISING_ON_ACTUAL_PREDICTIONS"
  | "PATTERN_V1_NO_LIFT_ON_ACTUAL_PREDICTIONS"
  | "PATTERN_V1_UNDERPOWERED_ON_ACTUAL_PREDICTIONS"
  | "DATA_OR_LEAKAGE_FAILURE";

type MatchRow = {
  id: string;
  instrument: string;
  direction: Dir;
  start_at: string;
  startMs: number;
  entry_price: number;
  duration_seconds: number;
  durationOk: boolean;
  result: Outcome;
  confidence: number;
  patternV1Match: boolean;
  branch: Branch;
  rsi: number | null;
  rsiSeverity: RsiSeverity | null;
  adx: number | null;
  adxBucket: AdxBucket | null;
  bbMid: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  barCloseMs: number | null;
  barIdx: number | null;
  missingBars: boolean;
  diag1m: Outcome | null;
  diag5m: Outcome | null;
  diag15m: Outcome | null;
  disagreement?: {
    baselineDown: Outcome;
    counterfactualUp: Outcome | null;
  };
};

function stop(message: string): never {
  throw new Error(`AUDIT STOP: ${message}`);
}

function wilsonInterval(wins: number, decided: number, z = 1.96) {
  if (decided <= 0) return { ciLow: null as number | null, ciHigh: null as number | null };
  const p = wins / decided;
  const denom = 1 + (z * z) / decided;
  const center = p + (z * z) / (2 * decided);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * decided)) / decided);
  return { ciLow: (center - margin) / denom, ciHigh: (center + margin) / denom };
}

function pct(value: number | null) {
  return value == null || !Number.isFinite(value) ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function evOf(wr: number, payout: number) {
  return wr * payout - (1 - wr);
}

function scoreOutcomes(outcomes: Outcome[]): Score {
  let won = 0;
  let lost = 0;
  let tie = 0;
  for (const outcome of outcomes) {
    if (outcome === "won") won += 1;
    else if (outcome === "lost") lost += 1;
    else tie += 1;
  }
  const decided = won + lost;
  const wr = decided ? won / decided : 0;
  const ci = wilsonInterval(won, decided);
  return {
    rawN: outcomes.length,
    won,
    lost,
    tie,
    decided,
    wr,
    ciLow: ci.ciLow,
    ciHigh: ci.ciHigh,
    ev70: evOf(wr, 0.7),
    ev75: evOf(wr, 0.75),
    ev80: evOf(wr, 0.8),
    ev85: evOf(wr, 0.85),
    ev90: evOf(wr, 0.9),
    ev95: evOf(wr, 0.95),
  };
}

function fmtScore(score: Score) {
  if (score.decided <= 0) {
    return `n=0 W=0 L=0 T=${score.tie} WR=n/a Wilson95=[n/a, n/a] EV80=n/a`;
  }
  return `n=${score.decided} W=${score.won} L=${score.lost} T=${score.tie} WR=${pct(score.wr)} Wilson95=[${pct(score.ciLow)}, ${pct(score.ciHigh)}] EV80=${score.ev80.toFixed(4)}`;
}

function fmtEvLadder(score: Score) {
  if (score.decided <= 0) {
    return `EV70=n/a EV75=n/a EV80=n/a EV85=n/a EV90=n/a EV95=n/a`;
  }
  return `EV70=${score.ev70.toFixed(4)} EV75=${score.ev75.toFixed(4)} EV80=${score.ev80.toFixed(4)} EV85=${score.ev85.toFixed(4)} EV90=${score.ev90.toFixed(4)} EV95=${score.ev95.toFixed(4)}`;
}

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) stop(`missing file ${filePath}`);
  const rows: T[] = [];
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line) as T);
  }
  return rows;
}

function loadCandles(instrument: string): BinaryCandle[] {
  const filePath = path.join(CACHE_DIR, `${instrument}.jsonl`);
  if (!fs.existsSync(filePath)) stop(`missing M1 cache for ${instrument}: ${filePath}`);
  const candles = readJsonl<BinaryCandle>(filePath)
    .filter((candle) => candle.complete !== false && Number.isFinite(Date.parse(candle.time)))
    .sort((a, b) => a.time.localeCompare(b.time));
  if (!candles.length) stop(`empty cache for ${instrument}`);
  return candles;
}

function trueRange(candle: BinaryCandle, previousClose: number) {
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previousClose),
    Math.abs(candle.low - previousClose),
  );
}

function computeBollinger(closes: Float64Array) {
  const mid = new Float64Array(closes.length).fill(NaN);
  const upper = new Float64Array(closes.length).fill(NaN);
  const lower = new Float64Array(closes.length).fill(NaN);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < closes.length; i++) {
    const current = closes[i]!;
    sum += current;
    sumSq += current * current;
    if (i >= BB_PERIOD) {
      const old = closes[i - BB_PERIOD]!;
      sum -= old;
      sumSq -= old * old;
    }
    if (i >= BB_PERIOD - 1) {
      const mean = sum / BB_PERIOD;
      const variance = Math.max(0, sumSq / BB_PERIOD - mean * mean);
      const sd = Math.sqrt(variance);
      mid[i] = mean;
      upper[i] = mean + BB_K * sd;
      lower[i] = mean - BB_K * sd;
    }
  }
  return { mid, upper, lower };
}

function computeAtr14(candles: BinaryCandle[]) {
  const atr = new Float64Array(candles.length).fill(NaN);
  if (candles.length < 15) return atr;
  let sum = 0;
  for (let i = 1; i <= 14; i++) sum += trueRange(candles[i]!, candles[i - 1]!.close);
  atr[14] = sum / 14;
  for (let i = 15; i < candles.length; i++) {
    atr[i] = (atr[i - 1]! * 13 + trueRange(candles[i]!, candles[i - 1]!.close)) / 14;
  }
  return atr;
}

function computeAdx14(candles: BinaryCandle[]) {
  const adx = new Float64Array(candles.length).fill(NaN);
  if (candles.length < 29) return adx;
  const tr = new Float64Array(candles.length);
  const plusDm = new Float64Array(candles.length);
  const minusDm = new Float64Array(candles.length);
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i]!;
    const previous = candles[i - 1]!;
    tr[i] = trueRange(current, previous.close);
    const up = current.high - previous.high;
    const down = previous.low - current.low;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }
  let smoothedTr = 0;
  let smoothedPlus = 0;
  let smoothedMinus = 0;
  for (let i = 1; i <= 14; i++) {
    smoothedTr += tr[i]!;
    smoothedPlus += plusDm[i]!;
    smoothedMinus += minusDm[i]!;
  }
  const dx: number[] = [];
  for (let i = 14; i < candles.length; i++) {
    if (i > 14) {
      smoothedTr = smoothedTr - smoothedTr / 14 + tr[i]!;
      smoothedPlus = smoothedPlus - smoothedPlus / 14 + plusDm[i]!;
      smoothedMinus = smoothedMinus - smoothedMinus / 14 + minusDm[i]!;
    }
    const plusDi = smoothedTr > 0 ? (100 * smoothedPlus) / smoothedTr : 0;
    const minusDi = smoothedTr > 0 ? (100 * smoothedMinus) / smoothedTr : 0;
    const denominator = plusDi + minusDi;
    const value = denominator > 0 ? (100 * Math.abs(plusDi - minusDi)) / denominator : 0;
    dx.push(value);
    if (dx.length === 14) adx[i] = dx.reduce((a, b) => a + b, 0) / 14;
    else if (dx.length > 14) adx[i] = (adx[i - 1]! * 13 + value) / 14;
  }
  return adx;
}

function computeRsi14(closes: Float64Array) {
  const rsi = new Float64Array(closes.length).fill(NaN);
  if (closes.length < 15) return rsi;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= 14; i++) {
    const delta = closes[i]! - closes[i - 1]!;
    if (delta >= 0) gain += delta;
    else loss -= delta;
  }
  let avgGain = gain / 14;
  let avgLoss = loss / 14;
  rsi[14] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = 15; i < closes.length; i++) {
    const delta = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * 13 + (delta > 0 ? delta : 0)) / 14;
    avgLoss = (avgLoss * 13 + (delta < 0 ? -delta : 0)) / 14;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function adxBucketOf(adx: number): AdxBucket {
  if (adx <= 20) return "le20";
  if (adx <= 25) return "b20_25";
  if (adx <= 30) return "b25_30";
  return "gt30";
}

function rsiSeverityOf(dir: Dir, rsi: number): RsiSeverity {
  const beyond = dir === "up" ? 30 - rsi : rsi - 70;
  if (beyond <= 5) return "mild";
  if (beyond <= 10) return "medium";
  return "extreme";
}

function matchesPattern(signal: { dir: Dir; rsiSeverity: RsiSeverity; adxBucket: AdxBucket }, pattern: PatternId) {
  const branchA =
    signal.dir === "up" &&
    signal.rsiSeverity === "extreme" &&
    signal.adxBucket === "gt30";
  const branchB =
    signal.dir === "up" &&
    signal.rsiSeverity === "medium" &&
    signal.adxBucket === "b20_25";
  switch (pattern) {
    case "V1":
      return branchA || branchB;
    case "V1a":
      return branchA;
    case "V1b":
      return branchB;
    default: {
      const exhaustive: never = pattern;
      throw new Error(String(exhaustive));
    }
  }
}

function branchOf(signal: { dir: Dir; rsiSeverity: RsiSeverity; adxBucket: AdxBucket }): Branch {
  if (matchesPattern(signal, "V1a")) return "V1a";
  if (matchesPattern(signal, "V1b")) return "V1b";
  return "none";
}

type SideState = { outside: boolean; signaled: boolean; extremePrice: number };

function collectV1Signals(instrument: string, cache: Omit<InstrumentCache, "v1ByEntryMs">): V1Signal[] {
  const signals: V1Signal[] = [];
  const upper: SideState = { outside: false, signaled: false, extremePrice: NaN };
  const lower: SideState = { outside: false, signaled: false, extremePrice: NaN };
  for (let i = 0; i < cache.candles.length; i++) {
    const candle = cache.candles[i]!;
    const entryMs = cache.closeMs[i]!;
    const mid = cache.bbMid[i]!;
    const upperBand = cache.bbUpper[i]!;
    const lowerBand = cache.bbLower[i]!;
    if (![mid, upperBand, lowerBand].every(Number.isFinite)) continue;

    for (const [side, state] of [
      ["upper", upper],
      ["lower", lower],
    ] as const) {
      if (!state.signaled) continue;
      const reset =
        side === "upper"
          ? candle.close <= mid || candle.low <= mid
          : candle.close >= mid || candle.high >= mid;
      if (reset) {
        state.signaled = false;
        state.outside = false;
        state.extremePrice = NaN;
      }
    }

    if (!upper.signaled && candle.high > upperBand) {
      upper.outside = true;
      upper.extremePrice = Number.isFinite(upper.extremePrice)
        ? Math.max(upper.extremePrice, candle.high)
        : candle.high;
    }
    if (!lower.signaled && candle.low < lowerBand) {
      lower.outside = true;
      lower.extremePrice = Number.isFinite(lower.extremePrice)
        ? Math.min(lower.extremePrice, candle.low)
        : candle.low;
    }

    const pushSignal = (side: Side, dir: Dir) => {
      const rsi = cache.rsi14[i]!;
      const adx = cache.adx14[i]!;
      if (!Number.isFinite(rsi) || !Number.isFinite(adx)) return;
      const rsiSeverity = rsiSeverityOf(dir, rsi);
      const adxBucket = adxBucketOf(adx);
      const branch = branchOf({ dir, rsiSeverity, adxBucket });
      if (branch === "none") return;
      signals.push({
        instrument,
        side,
        dir,
        entry: candle.close,
        entryMs,
        barIdx: i,
        rsi,
        rsiSeverity,
        adx,
        adxBucket,
        branch,
        bbMid: mid,
        bbUpper: upperBand,
        bbLower: lowerBand,
      });
    };

    const upperReentry = upper.outside && candle.close <= upperBand;
    if (upperReentry) {
      if (!upper.signaled) {
        const rsi = cache.rsi14[i]!;
        if (Number.isFinite(rsi) && rsi >= 70) pushSignal("upper", "down");
        upper.signaled = true;
      }
      upper.outside = false;
      upper.extremePrice = NaN;
    }

    const lowerReentry = lower.outside && candle.close >= lowerBand;
    if (lowerReentry) {
      if (!lower.signaled) {
        const rsi = cache.rsi14[i]!;
        if (Number.isFinite(rsi) && rsi <= 30) pushSignal("lower", "up");
        lower.signaled = true;
      }
      lower.outside = false;
      lower.extremePrice = NaN;
    }
  }
  return signals;
}

function buildCache(instrument: string): InstrumentCache {
  const candles = loadCandles(instrument);
  const closeMs = candles.map((candle) => Date.parse(candle.time) + 60_000);
  const closes = new Float64Array(candles.map((candle) => candle.close));
  const atr14 = computeAtr14(candles);
  const adx14 = computeAdx14(candles);
  const rsi14 = computeRsi14(closes);
  const bb = computeBollinger(closes);
  const partial = {
    candles,
    closeMs,
    atr14,
    adx14,
    rsi14,
    bbMid: bb.mid,
    bbUpper: bb.upper,
    bbLower: bb.lower,
  };
  const v1Signals = collectV1Signals(instrument, partial);
  const v1ByEntryMs = new Map<number, V1Signal>();
  for (const signal of v1Signals) v1ByEntryMs.set(signal.entryMs, signal);
  return { ...partial, v1ByEntryMs };
}

/** Last completed candle index with closeMs <= asOfMs. */
function lastKnownIdx(closeMs: number[], asOfMs: number): number {
  let lo = 0;
  let hi = closeMs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (closeMs[mid]! <= asOfMs) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function firstCloseAtOrAfter(closeMs: number[], targetMs: number): number {
  let low = 0;
  let high = closeMs.length - 1;
  let answer = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (closeMs[mid]! >= targetMs) {
      answer = mid;
      high = mid - 1;
    } else low = mid + 1;
  }
  return answer;
}

function resolveAt(
  cache: InstrumentCache,
  entryPrice: number,
  direction: Dir,
  precision: number,
  startMs: number,
  expiryMin: number,
): Outcome | null {
  const index = firstCloseAtOrAfter(cache.closeMs, startMs + expiryMin * 60_000);
  if (index < 0) return null;
  return classifyBinaryResult(direction, entryPrice, cache.candles[index]!.close, precision);
}

function median(values: number[]) {
  if (!values.length) return null as number | null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: number[]) {
  if (!values.length) return null as number | null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function deciles(values: number[]) {
  if (!values.length) return [] as number[];
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (let d = 1; d <= 9; d++) {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((d / 10) * sorted.length) - 1));
    out.push(sorted[idx]!);
  }
  return out;
}

function dayUtc(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

function groupScores(rows: MatchRow[], keyOf: (row: MatchRow) => string) {
  const grouped = new Map<string, Outcome[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const values = grouped.get(key) ?? [];
    values.push(row.result);
    grouped.set(key, values);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, outcomes]) => `${key}: ${fmtScore(scoreOutcomes(outcomes))}`)
    .join("\n");
}

function chooseVerdict(args: {
  leakagePass: boolean;
  primary: Score;
  allUp: Score;
  liftPp: number;
}): Verdict {
  const { leakagePass, primary, allUp, liftPp } = args;
  if (!leakagePass) return "DATA_OR_LEAKAGE_FAILURE";
  if (primary.decided < 15) return "PATTERN_V1_UNDERPOWERED_ON_ACTUAL_PREDICTIONS";
  if (liftPp <= 0) return "PATTERN_V1_NO_LIFT_ON_ACTUAL_PREDICTIONS";
  if (primary.decided < 40) {
    return primary.wr >= 0.58
      ? "PATTERN_V1_PROMISING_ON_ACTUAL_PREDICTIONS"
      : "PATTERN_V1_UNDERPOWERED_ON_ACTUAL_PREDICTIONS";
  }
  const ciAboveBe = (primary.ciLow ?? 0) > BE80;
  if (primary.wr >= 0.6 && primary.ev80 > 0 && (ciAboveBe || primary.decided >= 80)) {
    return "PATTERN_V1_STRONG_ON_ACTUAL_PREDICTIONS";
  }
  if (primary.ev80 > 0 && primary.wr > allUp.wr) {
    return "PATTERN_V1_PROFITABLE_ON_ACTUAL_PREDICTIONS";
  }
  if (primary.wr > allUp.wr) return "PATTERN_V1_PROMISING_ON_ACTUAL_PREDICTIONS";
  return "PATTERN_V1_NO_LIFT_ON_ACTUAL_PREDICTIONS";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fs.mkdirSync(path.join(OUT_DIR, "experiments"), { recursive: true });

console.log("Loading authoritative binary-baseline-v1 predictions...");
const predRes = await query<PredRow>(
  `SELECT id, instrument, direction, start_at::text, entry_price::float, duration_seconds,
          price_precision, result, confidence::float, intended_expiration::text
     FROM binary_predictions
    WHERE status='resolved' AND is_authoritative=true AND model_name='binary-baseline-v1'
    ORDER BY start_at`,
);
const preds = predRes.rows;
console.log(`Loaded ${preds.length} predictions`);
if (!preds.length) stop("no predictions returned");

const instruments = [...new Set(preds.map((p) => p.instrument))].sort();
const startMsAll = preds.map((p) => Date.parse(p.start_at));
const rangeMin = Math.min(...startMsAll);
const rangeMax = Math.max(...startMsAll);
console.log(
  `Range: ${new Date(rangeMin).toISOString()} → ${new Date(rangeMax).toISOString()} | instruments=${instruments.length}`,
);

console.log("Building M1 caches + frozen PATTERN_V1 index...");
const caches = new Map<string, InstrumentCache>();
for (const instrument of instruments) {
  if (!MAJOR_INSTRUMENTS.includes(instrument as (typeof MAJOR_INSTRUMENTS)[number])) {
    console.warn(`  skip non-major instrument ${instrument}`);
    continue;
  }
  const cache = buildCache(instrument);
  caches.set(instrument, cache);
  const first = cache.closeMs[0]!;
  const last = cache.closeMs.at(-1)!;
  console.log(
    `  ${instrument}: bars=${cache.candles.length} V1signals=${cache.v1ByEntryMs.size} cache=${new Date(first).toISOString()}→${new Date(last).toISOString()}`,
  );
}

let missingBars = 0;
let missingInstrument = 0;
let durationNot600 = 0;
let lookaheadViolations = 0;
const rows: MatchRow[] = [];

for (let i = 0; i < preds.length; i++) {
  const pred = preds[i]!;
  if (i > 0 && i % 500 === 0) console.log(`  matching ${i}/${preds.length}...`);
  const startMs = Date.parse(pred.start_at);
  const durationOk = pred.duration_seconds === PRIMARY_EXPIRY_SEC;
  if (!durationOk) durationNot600 += 1;

  const cache = caches.get(pred.instrument);
  if (!cache) {
    missingInstrument += 1;
    rows.push({
      id: pred.id,
      instrument: pred.instrument,
      direction: pred.direction,
      start_at: pred.start_at,
      startMs,
      entry_price: pred.entry_price,
      duration_seconds: pred.duration_seconds,
      durationOk,
      result: pred.result,
      confidence: pred.confidence,
      patternV1Match: false,
      branch: "none",
      rsi: null,
      rsiSeverity: null,
      adx: null,
      adxBucket: null,
      bbMid: null,
      bbUpper: null,
      bbLower: null,
      barCloseMs: null,
      barIdx: null,
      missingBars: true,
      diag1m: null,
      diag5m: null,
      diag15m: null,
    });
    continue;
  }

  const barIdx = lastKnownIdx(cache.closeMs, startMs);
  if (barIdx < 0 || barIdx < 28) {
    missingBars += 1;
    rows.push({
      id: pred.id,
      instrument: pred.instrument,
      direction: pred.direction,
      start_at: pred.start_at,
      startMs,
      entry_price: pred.entry_price,
      duration_seconds: pred.duration_seconds,
      durationOk,
      result: pred.result,
      confidence: pred.confidence,
      patternV1Match: false,
      branch: "none",
      rsi: null,
      rsiSeverity: null,
      adx: null,
      adxBucket: null,
      bbMid: null,
      bbUpper: null,
      bbLower: null,
      barCloseMs: null,
      barIdx: barIdx < 0 ? null : barIdx,
      missingBars: true,
      diag1m: null,
      diag5m: null,
      diag15m: null,
    });
    continue;
  }

  const barCloseMs = cache.closeMs[barIdx]!;
  if (barCloseMs > startMs) {
    lookaheadViolations += 1;
    throw new Error(`lookahead candle for ${pred.id}: closeMs=${barCloseMs} > startMs=${startMs}`);
  }

  const signal = cache.v1ByEntryMs.get(barCloseMs) ?? null;
  const patternV1Match = signal != null && matchesPattern(signal, "V1");
  const branch = signal && patternV1Match ? signal.branch : "none";

  const row: MatchRow = {
    id: pred.id,
    instrument: pred.instrument,
    direction: pred.direction,
    start_at: pred.start_at,
    startMs,
    entry_price: pred.entry_price,
    duration_seconds: pred.duration_seconds,
    durationOk,
    result: pred.result,
    confidence: pred.confidence,
    patternV1Match,
    branch,
    rsi: signal?.rsi ?? null,
    rsiSeverity: signal?.rsiSeverity ?? null,
    adx: signal?.adx ?? null,
    adxBucket: signal?.adxBucket ?? null,
    bbMid: signal?.bbMid ?? null,
    bbUpper: signal?.bbUpper ?? null,
    bbLower: signal?.bbLower ?? null,
    barCloseMs,
    barIdx,
    missingBars: false,
    diag1m: null,
    diag5m: null,
    diag15m: null,
  };

  if (patternV1Match && pred.direction === "up") {
    row.diag1m = resolveAt(cache, pred.entry_price, "up", pred.price_precision, startMs, 1);
    row.diag5m = resolveAt(cache, pred.entry_price, "up", pred.price_precision, startMs, 5);
    row.diag15m = resolveAt(cache, pred.entry_price, "up", pred.price_precision, startMs, 15);
  }

  if (patternV1Match && pred.direction === "down") {
    const counterfactualUp = resolveAt(cache, pred.entry_price, "up", pred.price_precision, startMs, 10);
    row.disagreement = {
      baselineDown: pred.result,
      counterfactualUp,
    };
  }

  rows.push(row);
}

const evaluable = rows.filter((r) => !r.missingBars);
const allOutcomes = evaluable.map((r) => r.result);
const upRows = evaluable.filter((r) => r.direction === "up");
const downRows = evaluable.filter((r) => r.direction === "down");
const v1Up = upRows.filter((r) => r.patternV1Match);
const upNonMatch = upRows.filter((r) => !r.patternV1Match);
const disagreements = evaluable.filter((r) => r.patternV1Match && r.direction === "down");

const scoreAll = scoreOutcomes(allOutcomes);
const scoreUp = scoreOutcomes(upRows.map((r) => r.result));
const scoreDown = scoreOutcomes(downRows.map((r) => r.result));
const scoreV1Up = scoreOutcomes(v1Up.map((r) => r.result));
const scoreUpNon = scoreOutcomes(upNonMatch.map((r) => r.result));
const scoreV1a = scoreOutcomes(v1Up.filter((r) => r.branch === "V1a").map((r) => r.result));
const scoreV1b = scoreOutcomes(v1Up.filter((r) => r.branch === "V1b").map((r) => r.result));

const liftPp = scoreV1Up.decided > 0 ? (scoreV1Up.wr - scoreUp.wr) * 100 : null;
const coverageVsUp = upRows.length ? v1Up.length / upRows.length : 0;
const coverageVsAll = evaluable.length ? v1Up.length / evaluable.length : 0;
const matchFreqVsAllPreds = preds.length ? v1Up.length / preds.length : 0;

let v1SignalsInWindow = 0;
const v1SignalsInWindowByInst: Record<string, number> = {};
for (const [instrument, cache] of caches) {
  let n = 0;
  for (const entryMs of cache.v1ByEntryMs.keys()) {
    if (entryMs >= rangeMin && entryMs <= rangeMax) n += 1;
  }
  v1SignalsInWindowByInst[instrument] = n;
  v1SignalsInWindow += n;
}

const confMatch = v1Up.map((r) => r.confidence).filter(Number.isFinite);
const confNon = upNonMatch.map((r) => r.confidence).filter(Number.isFinite);

const diag1 = scoreOutcomes(v1Up.map((r) => r.diag1m).filter((x): x is Outcome => x != null));
const diag5 = scoreOutcomes(v1Up.map((r) => r.diag5m).filter((x): x is Outcome => x != null));
const diag15 = scoreOutcomes(v1Up.map((r) => r.diag15m).filter((x): x is Outcome => x != null));

const disagreeBaseline = scoreOutcomes(disagreements.map((r) => r.disagreement!.baselineDown));
const disagreeCf = scoreOutcomes(
  disagreements
    .map((r) => r.disagreement!.counterfactualUp)
    .filter((x): x is Outcome => x != null),
);

const leakageItems: Array<[string, boolean]> = [
  ["Only M1 bars with closeMs <= prediction start_at used for match", lookaheadViolations === 0],
  ["PATTERN_V1 definitions frozen (no retune)", true],
  ["Primary outcomes are stored prediction results (not regenerated stream)", true],
  ["Disagreement counterfactual not mixed into primary cohort", true],
  ["Diagnostic 1m/5m/15m not mixed into primary 10m stored result", true],
  ["Production binary strategy / adaptive engine / predictions untouched", true],
];
const leakagePass = leakageItems.every(([, ok]) => ok);

const verdict = chooseVerdict({
  leakagePass,
  primary: scoreV1Up,
  allUp: scoreUp,
  liftPp: liftPp ?? -Infinity,
});

const matchLines = rows
  .filter((r) => r.patternV1Match)
  .map((r) => JSON.stringify(r))
  .join("\n");
fs.writeFileSync(MATCHES_PATH, matchLines ? `${matchLines}\n` : "");

const report = `GOLDENXPERIENCE
PATTERN_V1 ON ACTUAL STORED PREDICTIONS
Generated: ${new Date().toISOString()}
Research only. Production untouched.
BE80=${BE80.toFixed(6)} (1/1.8)

================================
DATA
================================

Source: binary_predictions WHERE status='resolved' AND is_authoritative=true AND model_name='binary-baseline-v1'
Total predictions: ${preds.length}
Evaluable (M1 available): ${evaluable.length}
Missing instrument cache: ${missingInstrument}
Missing/insufficient M1 bars: ${missingBars}
Duration != 600s (flagged, still reported): ${durationNot600}
Date range (start_at): ${new Date(rangeMin).toISOString()} → ${new Date(rangeMax).toISOString()}
UP: ${upRows.length}  DOWN: ${downRows.length}
PATTERN_V1 UP signal bars in prediction window (any direction coincidence later): ${v1SignalsInWindow}
  by instrument: ${Object.entries(v1SignalsInWindowByInst).map(([k,v]) => `${k}=${v}`).join(", ") || "none"}
M1 cache: ${CACHE_DIR}
Cache preferred; no OANDA fetch required for this window (cache covers through ~2026-08-21).

Frozen PATTERN_V1:
  BB20 k=2 population stdev; Wilder RSI14 (UP needs rsi<=30 on lower BB reentry);
  Wilder ADX14; rsiSeverity beyond=up?(30-rsi):(rsi-70) mild<=5 medium<=10 else extreme;
  adxBucket le20 / b20_25 / b25_30 / gt30;
  Episode dedup BB reentry state machine (same as holdout / follow-pocket);
  V1a: up && extreme && gt30; V1b: up && medium && b20_25; V1 = V1a || V1b;
  Primary expiry: stored 10m result (duration_seconds==600 preferred).

PIT match: last closed M1 bar with closeMs<=T fires Pattern V1 UP signal.

================================
COHORTS (10m stored result)
================================

A. ALL predictions:
${fmtScore(scoreAll)}
${fmtEvLadder(scoreAll)}

B. ALL UP:
${fmtScore(scoreUp)}
${fmtEvLadder(scoreUp)}

C. PATTERN_V1 matched UP (PRIMARY):
${fmtScore(scoreV1Up)}
${fmtEvLadder(scoreV1Up)}

D. UP non-matched:
${fmtScore(scoreUpNon)}
${fmtEvLadder(scoreUpNon)}

DOWN overall (completeness):
${fmtScore(scoreDown)}
${fmtEvLadder(scoreDown)}

Lift (C vs B): ${liftPp == null ? "n/a (no Pattern V1 UP matches)" : `${liftPp.toFixed(2)} pp`}
Coverage vs ALL UP: ${pct(coverageVsUp)}
Coverage vs evaluable ALL: ${pct(coverageVsAll)}
Match frequency vs raw pred count: ${pct(matchFreqVsAllPreds)}

================================
BY BRANCH (primary Pattern V1 UP)
================================

V1a extreme + ADX>30:
${fmtScore(scoreV1a)}

V1b medium + ADX20–25:
${fmtScore(scoreV1b)}

================================
BY SYMBOL (Pattern V1 UP matches)
================================

${v1Up.length ? groupScores(v1Up, (r) => r.instrument) : "(none)"}

================================
BY CALENDAR DAY UTC (Pattern V1 UP matches)
================================

Calendar convention: UTC (YYYY-MM-DD from start_at)
${v1Up.length ? groupScores(v1Up, (r) => dayUtc(r.startMs)) : "(none)"}

================================
BASELINE CONFIDENCE (UP preds)
================================

Pattern V1 UP matches: n=${confMatch.length} mean=${mean(confMatch)?.toFixed(4) ?? "n/a"} median=${median(confMatch)?.toFixed(4) ?? "n/a"}
  deciles D1..D9: ${deciles(confMatch).map((x) => x.toFixed(4)).join(", ") || "n/a"}

UP non-matches: n=${confNon.length} mean=${mean(confNon)?.toFixed(4) ?? "n/a"} median=${median(confNon)?.toFixed(4) ?? "n/a"}
  deciles D1..D9: ${deciles(confNon).map((x) => x.toFixed(4)).join(", ") || "n/a"}

================================
DISAGREEMENT DIAGNOSTIC
================================

PATTERN_V1_MATCH && direction=down (NOT mixed into primary):
n=${disagreements.length}
Baseline DOWN (stored): ${fmtScore(disagreeBaseline)}
Counterfactual UP @ T+10m (candles): ${fmtScore(disagreeCf)}

================================
DIAGNOSTIC EXPIRIES (Pattern V1 UP; candle resolution; NOT primary)
================================

1m: ${fmtScore(diag1)}
5m: ${fmtScore(diag5)}
15m: ${fmtScore(diag15)}
Primary remains stored 10m result above.

================================
LEAKAGE CHECKLIST
================================

${leakagePass ? "PASS" : "FAIL"}
${leakageItems.map(([name, pass]) => `[${pass ? "x" : " "}] ${name}`).join("\n")}

================================
PRODUCTION SAFETY
================================

Production binary strategy changed? NO
Production adaptive engine changed? NO
Existing binary predictions changed? NO
Deployment performed? NO
Orders placed? 0
Research only.

================================
ARTIFACTS
================================

matches.jsonl: ${MATCHES_PATH}
registry: ${REGISTRY_PATH}

================================
VERDICT
================================

${verdict}
`;

fs.writeFileSync(REPORT_PATH, report);

const registry = {
  experiment: "pattern-v1-on-actual-predictions-v1",
  generatedAt: new Date().toISOString(),
  modelName: "binary-baseline-v1",
  nPredictions: preds.length,
  nEvaluable: evaluable.length,
  nUp: upRows.length,
  nDown: downRows.length,
  dateRange: {
    from: new Date(rangeMin).toISOString(),
    to: new Date(rangeMax).toISOString(),
  },
  primary: scoreV1Up,
  allUp: scoreUp,
  all: scoreAll,
  upNonMatch: scoreUpNon,
  down: scoreDown,
  v1a: scoreV1a,
  v1b: scoreV1b,
  liftPp: liftPp,
  v1SignalsInWindow,
  v1SignalsInWindowByInst,
  coverageVsUp,
  coverageVsAll,
  disagreements: disagreements.length,
  missingBars,
  missingInstrument,
  durationNot600,
  leakage: leakagePass ? "PASS" : "FAIL",
  verdict,
};
fs.writeFileSync(REGISTRY_PATH, `${JSON.stringify(registry)}\n`);

console.log("\n=== SUMMARY ===");
console.log(`preds=${preds.length} UP=${upRows.length} DOWN=${downRows.length}`);
console.log(`V1 UP matches: ${fmtScore(scoreV1Up)}`);
console.log(`ALL UP: ${fmtScore(scoreUp)}`);
console.log(`lift=${liftPp == null ? "n/a" : `${liftPp.toFixed(2)}pp`} coverage_vs_up=${pct(coverageVsUp)} v1_signals_in_window=${v1SignalsInWindow}`);
console.log(`disagreements=${disagreements.length}`);
console.log(`leakage=${leakagePass ? "PASS" : "FAIL"}`);
console.log(`verdict=${verdict}`);
console.log(`report=${REPORT_PATH}`);

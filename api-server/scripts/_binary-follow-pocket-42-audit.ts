/**
 * Frozen audit of the 42 FOLLOW decisions produced by adaptive-direction-policy-v2.
 *
 * Research only. HOLDOUT is used only to establish the chronological split boundary:
 * its outcomes are never classified, summarized, or written.
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

const OUT_DIR = path.join(root, "research-v2", "follow-pocket-42-audit");
const CACHE_DIR = path.join(root, "research-v2", "binary-adaptive-bollinger-rsi-10k", "cache");
const DECISIONS_PATH = path.join(root, "research-v2", "adaptive-direction-policy-v2", "decisions.jsonl");
const REPORT_PATH = path.join(OUT_DIR, "FINAL_REPORT.txt");
const FROZEN_PATH = path.join(OUT_DIR, "frozen_42.jsonl");
const SIGNALS_PATH = path.join(OUT_DIR, "pattern_signals.jsonl");
const REGISTRY_PATH = path.join(OUT_DIR, "experiments", "registry.jsonl");

const BE80 = 1 / (1 + 0.8);
const BB_PERIOD = 20;
const BB_K = 2;
const WIDTH_TRAIL = 500;
const RANDOM_SHUFFLES = 1000;

type Outcome = "won" | "lost" | "tie";
type Dir = "up" | "down";
type Side = "upper" | "lower";
type Zone = "TRAIN" | "DEV" | "HOLDOUT";
type RsiSeverity = "mild" | "medium" | "extreme";
type AdxBucket = "le20" | "b20_25" | "b25_30" | "gt30";
type PatternId = "V1" | "V1a" | "V1b";

type DecisionRow = {
  entryMs: number;
  instrument: string;
  dir: Dir;
  zone: "TRAIN" | "DEV";
  state: string;
  scope: string;
  scopeKey: string;
  scopeN: number;
  v2: "FOLLOW" | "WAIT" | "INVERT";
  oldAdaptive: "TAKE" | "WAIT";
  simple: "FOLLOW" | "WAIT" | "INVERT";
  follow: Outcome;
  invert: Outcome;
  followWR: number | null;
  invertWR: number | null;
  chosenEst: number | null;
};

type RichFeatures = {
  beyond: number;
  widthAtr: number;
  widthPctile: number;
  atrPctile: number;
  ret1: number;
  ret3: number;
  ret5: number;
  ret10: number;
  bodyAtr: number;
  upperWickAtr: number;
  lowerWickAtr: number;
  bodyRange: number;
  distHigh20Atr: number;
  distLow20Atr: number;
  distHigh60Atr: number;
  distLow60Atr: number;
  consecutiveDir: number;
};

type RawSignal = {
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
  session: string;
  hourEt: number;
  dow: number;
  month: string;
  monthUtc: string;
  bbMid: number;
  bbUpper: number;
  bbLower: number;
  penetrationAtr: number;
  reentryDepthAtr: number;
  midSlope: number;
  atr: number;
  rich: RichFeatures;
  zone: Zone;
  outcomes?: Record<1 | 5 | 10 | 15, Outcome>;
  decision?: DecisionRow;
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
  widthAtr: Float64Array;
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
};

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  hourCycle: "h23",
});

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
  };
}

function fmtScore(score: Score) {
  return `n=${score.decided} W=${score.won} L=${score.lost} T=${score.tie} WR=${pct(score.wr)} Wilson95=[${pct(score.ciLow)}, ${pct(score.ciHigh)}] EV80=${score.ev80.toFixed(4)}`;
}

function sigKey(value: { instrument: string; entryMs: number }) {
  return `${value.instrument}|${value.entryMs}`;
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

function buildCache(candles: BinaryCandle[]): InstrumentCache {
  const closeMs = candles.map((candle) => Date.parse(candle.time) + 60_000);
  const closes = new Float64Array(candles.map((candle) => candle.close));
  const atr14 = computeAtr14(candles);
  const adx14 = computeAdx14(candles);
  const rsi14 = computeRsi14(closes);
  const bb = computeBollinger(closes);
  const widthAtr = new Float64Array(candles.length).fill(NaN);
  for (let i = 0; i < candles.length; i++) {
    const atr = atr14[i]!;
    if (Number.isFinite(atr) && atr > 0) widthAtr[i] = (bb.upper[i]! - bb.lower[i]!) / atr;
  }
  return {
    candles,
    closeMs,
    atr14,
    adx14,
    rsi14,
    bbMid: bb.mid,
    bbUpper: bb.upper,
    bbLower: bb.lower,
    widthAtr,
  };
}

function etFields(ms: number) {
  const parts = ET_PARTS.formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekdays: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const year = get("year");
  const monthNumber = get("month");
  const hourEt = Number(get("hour"));
  return {
    hourEt,
    dow: weekdays[get("weekday")] ?? -1,
    month: `${year}-${monthNumber}`,
  };
}

function sessionOf(ms: number): string {
  const { hourEt } = etFields(ms);
  if (hourEt >= 19 || hourEt < 3) return "asia";
  if (hourEt < 8) return "london";
  if (hourEt < 12) return "overlap";
  if (hourEt < 17) return "ny";
  return "off";
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

function trailingPercentile(series: Float64Array, index: number) {
  const current = series[index]!;
  if (!Number.isFinite(current)) return NaN;
  let valid = 0;
  let atOrBelow = 0;
  for (let i = Math.max(0, index - WIDTH_TRAIL + 1); i <= index; i++) {
    const value = series[i]!;
    if (!Number.isFinite(value)) continue;
    valid += 1;
    if (value <= current) atOrBelow += 1;
  }
  return valid ? atOrBelow / valid : NaN;
}

function returnOver(candles: BinaryCandle[], index: number, bars: number) {
  if (index < bars || candles[index - bars]!.close === 0) return NaN;
  return candles[index]!.close / candles[index - bars]!.close - 1;
}

function consecutiveDirection(candles: BinaryCandle[], index: number) {
  if (index < 1) return 0;
  const firstDelta = candles[index]!.close - candles[index - 1]!.close;
  if (firstDelta === 0) return 0;
  const sign = Math.sign(firstDelta);
  let count = 0;
  for (let i = index; i >= 1; i--) {
    const delta = candles[i]!.close - candles[i - 1]!.close;
    if (Math.sign(delta) !== sign) break;
    count += 1;
  }
  return sign * count;
}

function distanceFeatures(candles: BinaryCandle[], index: number, atr: number) {
  const distance = (bars: number) => {
    const start = Math.max(0, index - bars + 1);
    let high = -Infinity;
    let low = Infinity;
    for (let i = start; i <= index; i++) {
      high = Math.max(high, candles[i]!.high);
      low = Math.min(low, candles[i]!.low);
    }
    return {
      high: atr > 0 ? (high - candles[index]!.close) / atr : NaN,
      low: atr > 0 ? (candles[index]!.close - low) / atr : NaN,
    };
  };
  const d20 = distance(20);
  const d60 = distance(60);
  return {
    distHigh20Atr: d20.high,
    distLow20Atr: d20.low,
    distHigh60Atr: d60.high,
    distLow60Atr: d60.low,
  };
}

type SideState = { outside: boolean; signaled: boolean; extremePrice: number };

function collectSignals(instrument: string, cache: InstrumentCache): RawSignal[] {
  const signals: RawSignal[] = [];
  const upper: SideState = { outside: false, signaled: false, extremePrice: NaN };
  const lower: SideState = { outside: false, signaled: false, extremePrice: NaN };
  for (let i = 0; i < cache.candles.length; i++) {
    const candle = cache.candles[i]!;
    const entryMs = cache.closeMs[i]!;
    const mid = cache.bbMid[i]!;
    const upperBand = cache.bbUpper[i]!;
    const lowerBand = cache.bbLower[i]!;
    if (![mid, upperBand, lowerBand].every(Number.isFinite)) continue;

    for (const [side, state] of [["upper", upper], ["lower", lower]] as const) {
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

    const pushSignal = (side: Side, dir: Dir, extremePrice: number) => {
      const rsi = cache.rsi14[i]!;
      const adx = cache.adx14[i]!;
      const atr = cache.atr14[i]!;
      const band = side === "upper" ? upperBand : lowerBand;
      const previousMid = i >= 5 && Number.isFinite(cache.bbMid[i - 5]!) ? cache.bbMid[i - 5]! : mid;
      const range = candle.high - candle.low;
      const et = etFields(entryMs);
      const distances = distanceFeatures(cache.candles, i, atr);
      const beyond = dir === "up" ? 30 - rsi : rsi - 70;
      signals.push({
        instrument,
        side,
        dir,
        entry: candle.close,
        entryMs,
        barIdx: i,
        rsi,
        rsiSeverity: rsiSeverityOf(dir, rsi),
        adx,
        adxBucket: adxBucketOf(adx),
        session: sessionOf(entryMs),
        hourEt: et.hourEt,
        dow: et.dow,
        month: et.month,
        monthUtc: new Date(entryMs).toISOString().slice(0, 7),
        bbMid: mid,
        bbUpper: upperBand,
        bbLower: lowerBand,
        penetrationAtr: atr > 0 ? Math.abs(extremePrice - band) / atr : NaN,
        reentryDepthAtr: atr > 0 ? Math.abs(band - candle.close) / atr : NaN,
        midSlope: atr > 0 ? (mid - previousMid) / (5 * atr) : NaN,
        atr,
        rich: {
          beyond,
          widthAtr: cache.widthAtr[i]!,
          widthPctile: trailingPercentile(cache.widthAtr, i),
          atrPctile: trailingPercentile(cache.atr14, i),
          ret1: returnOver(cache.candles, i, 1),
          ret3: returnOver(cache.candles, i, 3),
          ret5: returnOver(cache.candles, i, 5),
          ret10: returnOver(cache.candles, i, 10),
          bodyAtr: atr > 0 ? Math.abs(candle.close - candle.open) / atr : NaN,
          upperWickAtr: atr > 0 ? (candle.high - Math.max(candle.open, candle.close)) / atr : NaN,
          lowerWickAtr: atr > 0 ? (Math.min(candle.open, candle.close) - candle.low) / atr : NaN,
          bodyRange: range > 0 ? Math.abs(candle.close - candle.open) / range : 0,
          ...distances,
          consecutiveDir: consecutiveDirection(cache.candles, i),
        },
        zone: "TRAIN",
      });
    };

    const upperReentry = upper.outside && candle.close <= upperBand;
    if (upperReentry) {
      if (!upper.signaled) {
        const rsi = cache.rsi14[i]!;
        if (Number.isFinite(rsi) && rsi >= 70) pushSignal("upper", "down", upper.extremePrice);
        upper.signaled = true;
      }
      upper.outside = false;
      upper.extremePrice = NaN;
    }

    const lowerReentry = lower.outside && candle.close >= lowerBand;
    if (lowerReentry) {
      if (!lower.signaled) {
        const rsi = cache.rsi14[i]!;
        if (Number.isFinite(rsi) && rsi <= 30) pushSignal("lower", "up", lower.extremePrice);
        lower.signaled = true;
      }
      lower.outside = false;
      lower.extremePrice = NaN;
    }
  }
  return signals;
}

function firstCloseAtOrAfter(closeMs: number[], targetMs: number) {
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

function scoreTrainDevSignals(instrument: string, signals: RawSignal[]) {
  const candles = loadCandles(instrument);
  const closeMs = candles.map((candle) => Date.parse(candle.time) + 60_000);
  const precision = instrument.includes("JPY") ? 3 : 5;
  for (const signal of signals) {
    const outcomes = {} as Record<1 | 5 | 10 | 15, Outcome>;
    for (const expiry of [1, 5, 10, 15] as const) {
      const index = firstCloseAtOrAfter(closeMs, signal.entryMs + expiry * 60_000);
      if (index < 0) stop(`no ${expiry}m resolution for ${sigKey(signal)}`);
      outcomes[expiry] = classifyBinaryResult(
        signal.dir,
        signal.entry,
        candles[index]!.close,
        precision,
      );
    }
    signal.outcomes = outcomes;
  }
}

function outcome10(signal: RawSignal): Outcome {
  if (!signal.outcomes) stop(`unscored TRAIN+DEV signal ${sigKey(signal)}`);
  return signal.outcomes[10];
}

function matchesPattern(signal: RawSignal, pattern: PatternId) {
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

function groupScores(
  signals: RawSignal[],
  keyOf: (signal: RawSignal) => string,
  expiry: 1 | 5 | 10 | 15 = 10,
) {
  const grouped = new Map<string, Outcome[]>();
  for (const signal of signals) {
    if (!signal.outcomes) stop(`unscored signal in group ${sigKey(signal)}`);
    const key = keyOf(signal);
    const values = grouped.get(key) ?? [];
    values.push(signal.outcomes[expiry]);
    grouped.set(key, values);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, outcomes]) => `${key}: ${fmtScore(scoreOutcomes(outcomes))}`)
    .join("\n");
}

function mean(values: number[]) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : NaN;
}

function median(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const NUMERIC_FEATURES: Record<string, (signal: RawSignal) => number> = {
  rsi: (s) => s.rsi,
  beyond: (s) => s.rich.beyond,
  adx: (s) => s.adx,
  widthAtr: (s) => s.rich.widthAtr,
  widthPctile: (s) => s.rich.widthPctile,
  penetrationAtr: (s) => s.penetrationAtr,
  reentryDepthAtr: (s) => s.reentryDepthAtr,
  midSlope: (s) => s.midSlope,
  atrPctile: (s) => s.rich.atrPctile,
  ret1: (s) => s.rich.ret1,
  ret3: (s) => s.rich.ret3,
  ret5: (s) => s.rich.ret5,
  ret10: (s) => s.rich.ret10,
  bodyAtr: (s) => s.rich.bodyAtr,
  upperWickAtr: (s) => s.rich.upperWickAtr,
  lowerWickAtr: (s) => s.rich.lowerWickAtr,
  bodyRange: (s) => s.rich.bodyRange,
  distHigh20Atr: (s) => s.rich.distHigh20Atr,
  distLow20Atr: (s) => s.rich.distLow20Atr,
  distHigh60Atr: (s) => s.rich.distHigh60Atr,
  distLow60Atr: (s) => s.rich.distLow60Atr,
  consecutiveDir: (s) => s.rich.consecutiveDir,
};

function profile(name: string, signals: RawSignal[]) {
  const score = scoreOutcomes(signals.map(outcome10));
  const numeric = Object.entries(NUMERIC_FEATURES)
    .map(([feature, getter]) => {
      const values = signals.map(getter);
      return `${feature}=${mean(values).toPrecision(5)}/${median(values).toPrecision(5)}`;
    })
    .join(", ");
  const bucket = (getter: (signal: RawSignal) => string) =>
    [...new Set(signals.map(getter))]
      .sort()
      .map((value) => `${value}:${pct(signals.filter((signal) => getter(signal) === value).length / Math.max(1, signals.length))}`)
      .join(" ");
  return `${name}: ${fmtScore(score)}
  means/medians: ${numeric}
  rsiSeverity: ${bucket((s) => s.rsiSeverity)}
  adxBucket: ${bucket((s) => s.adxBucket)}
  session: ${bucket((s) => s.session)}`;
}

function distinguishingTraits(target: RawSignal[], control: RawSignal[]) {
  const traits: { label: string; magnitude: number }[] = [];
  for (const [feature, getter] of Object.entries(NUMERIC_FEATURES)) {
    const targetValues = target.map(getter).filter(Number.isFinite);
    const controlValues = control.map(getter).filter(Number.isFinite);
    const targetMean = mean(targetValues);
    const controlMean = mean(controlValues);
    const variance = mean(controlValues.map((value) => (value - controlMean) ** 2));
    const standardized = variance > 0 ? (targetMean - controlMean) / Math.sqrt(variance) : 0;
    traits.push({
      magnitude: Math.abs(standardized),
      label: `${feature}: 42 mean=${targetMean.toPrecision(5)} vs control=${controlMean.toPrecision(5)} (standardized diff=${standardized.toFixed(2)})`,
    });
  }
  const categorical: [string, (signal: RawSignal) => string][] = [
    ["rsiSeverity", (s) => s.rsiSeverity],
    ["adxBucket", (s) => s.adxBucket],
    ["session", (s) => s.session],
    ["monthET", (s) => s.month],
    ["instrument", (s) => s.instrument],
  ];
  for (const [name, getter] of categorical) {
    for (const value of new Set([...target.map(getter), ...control.map(getter)])) {
      const targetShare = target.filter((signal) => getter(signal) === value).length / Math.max(1, target.length);
      const controlShare = control.filter((signal) => getter(signal) === value).length / Math.max(1, control.length);
      traits.push({
        magnitude: Math.abs(targetShare - controlShare) * 2,
        label: `${name}=${value}: 42=${pct(targetShare)} vs control=${pct(controlShare)} (${((targetShare - controlShare) * 100).toFixed(1)}pp)`,
      });
    }
  }
  return traits.sort((a, b) => b.magnitude - a.magnitude).slice(0, 3).map((trait) => trait.label);
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle<T>(values: T[], random: () => number) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

function matchedRandom(target: RawSignal[], pool: RawSignal[], seedBase: number) {
  const strata = new Map<string, number>();
  for (const signal of target) {
    const key = `${signal.instrument}|${signal.month}|${signal.dir}`;
    strata.set(key, (strata.get(key) ?? 0) + 1);
  }
  const pools = new Map<string, RawSignal[]>();
  for (const signal of pool) {
    const key = `${signal.instrument}|${signal.month}|${signal.dir}`;
    const values = pools.get(key) ?? [];
    values.push(signal);
    pools.set(key, values);
  }
  for (const [key, needed] of strata) {
    if ((pools.get(key)?.length ?? 0) < needed) {
      return { available: false, percentile: NaN, meanWr: NaN, lo: NaN, hi: NaN };
    }
  }
  const wrs: number[] = [];
  for (let iteration = 0; iteration < RANDOM_SHUFFLES; iteration++) {
    const random = mulberry32(seedBase + iteration * 131);
    const sample: RawSignal[] = [];
    for (const [key, needed] of strata) sample.push(...shuffle(pools.get(key)!, random).slice(0, needed));
    wrs.push(scoreOutcomes(sample.map(outcome10)).wr);
  }
  wrs.sort((a, b) => a - b);
  const targetWr = scoreOutcomes(target.map(outcome10)).wr;
  const quantile = (p: number) => wrs[Math.floor((wrs.length - 1) * p)]!;
  const belowOrEqual = wrs.filter((value) => value <= targetWr).length;
  return {
    available: true,
    percentile: belowOrEqual / wrs.length,
    meanWr: mean(wrs),
    lo: quantile(0.025),
    hi: quantile(0.975),
  };
}

function scoreWithoutSymbols(signals: RawSignal[], symbols: string[]) {
  return scoreOutcomes(
    signals.filter((signal) => !symbols.includes(signal.instrument)).map(outcome10),
  );
}

console.log("follow-pocket-42-audit: loading frozen decisions");
fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
const decisions = readJsonl<DecisionRow>(DECISIONS_PATH);
if (decisions.length !== 11_185) stop(`expected 11185 decisions, found ${decisions.length}`);
const followDecisions = decisions.filter((decision) => decision.v2 === "FOLLOW");
const frozenScore = scoreOutcomes(followDecisions.map((decision) => decision.follow));
if (
  followDecisions.length !== 42 ||
  frozenScore.won !== 31 ||
  frozenScore.lost !== 11 ||
  frozenScore.tie !== 0 ||
  Math.abs(frozenScore.wr - 31 / 42) > 1e-12
) {
  stop(`FOLLOW reproduction mismatch: ${fmtScore(frozenScore)}`);
}

fs.writeFileSync(
  FROZEN_PATH,
  followDecisions
    .map((decision) =>
      JSON.stringify({
        entryMs: decision.entryMs,
        instrument: decision.instrument,
        dir: decision.dir,
        scope: decision.scope,
        scopeKey: decision.scopeKey,
        scopeN: decision.scopeN,
        followWR: decision.followWR,
        outcome: decision.follow,
        iso: new Date(decision.entryMs).toISOString(),
      }),
    )
    .join("\n") + "\n",
);

console.log("Rebuilding frozen BB+RSI stream and pre-entry features...");
const allSignals: RawSignal[] = [];
for (const instrument of MAJOR_INSTRUMENTS) {
  const candles = loadCandles(instrument);
  const signals = collectSignals(instrument, buildCache(candles));
  allSignals.push(...signals);
  console.log(`  ${instrument}: bars=${candles.length} signals=${signals.length}`);
}
allSignals.sort((a, b) => a.entryMs - b.entryMs || a.instrument.localeCompare(b.instrument));
const trainN = Math.floor(allSignals.length * 0.6);
const devN = Math.floor(allSignals.length * 0.2);
for (let i = 0; i < allSignals.length; i++) {
  allSignals[i]!.zone = i < trainN ? "TRAIN" : i < trainN + devN ? "DEV" : "HOLDOUT";
}
const trainDev = allSignals.filter((signal) => signal.zone !== "HOLDOUT");
if (trainDev.length !== decisions.length) {
  stop(`split mismatch: rebuilt TRAIN+DEV=${trainDev.length}, decisions=${decisions.length}, total=${allSignals.length}`);
}

const decisionMap = new Map(decisions.map((decision) => [sigKey(decision), decision]));
const signalMap = new Map(trainDev.map((signal) => [sigKey(signal), signal]));
for (const signal of trainDev) {
  const decision = decisionMap.get(sigKey(signal));
  if (!decision) stop(`TRAIN+DEV signal has no decision: ${sigKey(signal)}`);
  signal.decision = decision;
}
for (const decision of decisions) {
  if (!signalMap.has(sigKey(decision))) stop(`decision unmatched by rebuilt stream: ${sigKey(decision)}`);
}
for (const decision of followDecisions) {
  if (!signalMap.has(sigKey(decision))) stop(`one of frozen 42 unmatched: ${sigKey(decision)}`);
}

console.log("Scoring TRAIN+DEV only; HOLDOUT remains sealed...");
for (const instrument of MAJOR_INSTRUMENTS) {
  scoreTrainDevSignals(
    instrument,
    trainDev.filter((signal) => signal.instrument === instrument),
  );
}
let outcomeMismatches = 0;
for (const signal of trainDev) {
  if (outcome10(signal) !== signal.decision!.follow) outcomeMismatches += 1;
}
if (outcomeMismatches > 0) stop(`${outcomeMismatches} rebuilt 10m outcomes differ from decisions`);

const frozenKeys = new Set(followDecisions.map(sigKey));
const frozenSignals = followDecisions.map((decision) => signalMap.get(sigKey(decision))!);
const frozenSignalScore = scoreOutcomes(frozenSignals.map(outcome10));
if (
  frozenSignalScore.won !== frozenScore.won ||
  frozenSignalScore.lost !== frozenScore.lost ||
  frozenSignalScore.tie !== frozenScore.tie
) {
  stop(`frozen feature match outcomes differ: ${fmtScore(frozenSignalScore)}`);
}

const non42 = trainDev.filter((signal) => !frozenKeys.has(sigKey(signal)));
const outsideByPattern = {
  V1: non42.filter((signal) => matchesPattern(signal, "V1")),
  V1a: non42.filter((signal) => matchesPattern(signal, "V1a")),
  V1b: non42.filter((signal) => matchesPattern(signal, "V1b")),
};
const includingByPattern = {
  V1: trainDev.filter((signal) => matchesPattern(signal, "V1")),
  V1a: trainDev.filter((signal) => matchesPattern(signal, "V1a")),
  V1b: trainDev.filter((signal) => matchesPattern(signal, "V1b")),
};
const outsideScores = {
  V1: scoreOutcomes(outsideByPattern.V1.map(outcome10)),
  V1a: scoreOutcomes(outsideByPattern.V1a.map(outcome10)),
  V1b: scoreOutcomes(outsideByPattern.V1b.map(outcome10)),
};

const directionOnlyExtreme = frozenSignals.filter(
  (signal) => signal.decision!.scopeKey === "direction|rsiSeverity|up|extreme",
);
const directionOnlyMatchesA =
  directionOnlyExtreme.length === 1 && matchesPattern(directionOnlyExtreme[0]!, "V1a");

const randomPool = non42.filter((signal) => signal.dir === "up" && !matchesPattern(signal, "V1"));
const matched = matchedRandom(outsideByPattern.V1, randomPool, 42_001);
const altMatched = matchedRandom(
  outsideByPattern.V1,
  non42.filter((signal) => signal.dir === "up"),
  84_001,
);

const v1MonthCounts = new Map<string, number>();
const v1SymbolCounts = new Map<string, number>();
for (const signal of outsideByPattern.V1) {
  v1MonthCounts.set(signal.month, (v1MonthCounts.get(signal.month) ?? 0) + 1);
  v1SymbolCounts.set(signal.instrument, (v1SymbolCounts.get(signal.instrument) ?? 0) + 1);
}
const maxMonthShare = Math.max(0, ...v1MonthCounts.values()) / Math.max(1, outsideByPattern.V1.length);
const maxSymbolShare = Math.max(0, ...v1SymbolCounts.values()) / Math.max(1, outsideByPattern.V1.length);
const excludingApril = outsideByPattern.V1.filter((signal) => signal.monthUtc !== "2026-04");
const excludingAprilScore = scoreOutcomes(excludingApril.map(outcome10));
const positiveExcludingApril = excludingAprilScore.decided > 0 && excludingAprilScore.ev80 > 0;
const distinctSymbols = new Set(outsideByPattern.V1.map((signal) => signal.instrument)).size;
const distinctMonths = new Set(outsideByPattern.V1.map((signal) => signal.month)).size;
const beatsRandom =
  matched.available &&
  matched.percentile > 0.975 &&
  outsideScores.V1.wr > matched.meanWr;
const gateChecks = [
  ["n>=200", outsideScores.V1.decided >= 200],
  ["WR>55.56%", outsideScores.V1.wr > BE80],
  ["EV80>0", outsideScores.V1.ev80 > 0],
  ["CI low>BE80", (outsideScores.V1.ciLow ?? 0) > BE80],
  ["month share<40%", maxMonthShare < 0.4],
  ["symbol share<40%", maxSymbolShare < 0.4],
  [">=3 symbols", distinctSymbols >= 3],
  ["multiple months", distinctMonths >= 2],
  ["positive excluding April 2026", positiveExcludingApril],
  ["beats matched random", beatsRandom],
] as const;
const qualifies = gateChecks.every(([, pass]) => pass);

const frozenExAprilUtc = frozenSignals.filter((signal) => signal.monthUtc !== "2026-04");
const frozenExAprilUtcScore = scoreOutcomes(frozenExAprilUtc.map(outcome10));
const aprilUtcScore = scoreOutcomes(
  frozenSignals.filter((signal) => signal.monthUtc === "2026-04").map(outcome10),
);

const symbolStats = [...new Set(frozenSignals.map((signal) => signal.instrument))]
  .map((instrument) => {
    const signals = frozenSignals.filter((signal) => signal.instrument === instrument);
    return { instrument, signals, score: scoreOutcomes(signals.map(outcome10)) };
  })
  .sort((a, b) => b.score.won - a.score.won || b.score.decided - a.score.decided);
const topSymbol = symbolStats[0]?.instrument ?? "";
const topTwoSymbols = symbolStats.slice(0, 2).map((row) => row.instrument);
const excludingTopSymbol = scoreWithoutSymbols(frozenSignals, [topSymbol]);
const excludingTopTwo = scoreWithoutSymbols(frozenSignals, topTwoSymbols);
const topTraits = distinguishingTraits(frozenSignals, non42);

const controls = [
  profile("A all BB+RSI TRAIN+DEV", trainDev),
  profile("B V2 WAIT", trainDev.filter((signal) => signal.decision!.v2 === "WAIT")),
  profile("C oldAdaptive TAKE", trainDev.filter((signal) => signal.decision!.oldAdaptive === "TAKE")),
  profile("D all BB+RSI winners", trainDev.filter((signal) => outcome10(signal) === "won")),
  profile("D all BB+RSI losers", trainDev.filter((signal) => outcome10(signal) === "lost")),
  profile("F UP not in 42", non42.filter((signal) => signal.dir === "up")),
].join("\n\n");

const expiryDiagnostics = ([1, 5, 10, 15] as const)
  .map((expiry) => {
    const outcomes = outsideByPattern.V1.map((signal) => signal.outcomes![expiry]);
    return `${expiry}m: ${fmtScore(scoreOutcomes(outcomes))}`;
  })
  .join("\n");

const patternSignalRows = trainDev
  .filter((signal) => matchesPattern(signal, "V1"))
  .map((signal) =>
    JSON.stringify({
      entryMs: signal.entryMs,
      iso: new Date(signal.entryMs).toISOString(),
      instrument: signal.instrument,
      dir: signal.dir,
      zone: signal.zone,
      discovery42: frozenKeys.has(sigKey(signal)),
      patternV1a: matchesPattern(signal, "V1a"),
      patternV1b: matchesPattern(signal, "V1b"),
      outcome10: outcome10(signal),
      rsi: signal.rsi,
      rsiSeverity: signal.rsiSeverity,
      adx: signal.adx,
      adxBucket: signal.adxBucket,
      month: signal.month,
      monthUtc: signal.monthUtc,
      session: signal.session,
      penetrationAtr: signal.penetrationAtr,
      reentryDepthAtr: signal.reentryDepthAtr,
      midSlope: signal.midSlope,
      rich: signal.rich,
    }),
  );
fs.writeFileSync(SIGNALS_PATH, patternSignalRows.join("\n") + "\n");

const whySelected = [...new Set(followDecisions.map((decision) => decision.scopeKey))]
  .sort()
  .map((scopeKey) => {
    const rows = followDecisions.filter((decision) => decision.scopeKey === scopeKey);
    const minN = Math.min(...rows.map((row) => row.scopeN));
    const maxN = Math.max(...rows.map((row) => row.scopeN));
    const wrMin = Math.min(...rows.map((row) => row.followWR ?? NaN));
    const wrMax = Math.max(...rows.map((row) => row.followWR ?? NaN));
    const ciExamples = rows.map((row) => {
      const wins = Math.round(row.scopeN * (row.followWR ?? 0));
      return wilsonInterval(wins, row.scopeN).ciLow ?? 0;
    });
    return `${scopeKey}: decisions=${rows.length}, scopeN=${minN}-${maxN}, followWR=${pct(wrMin)}-${pct(wrMax)}, reconstructed CI_low range=${pct(Math.min(...ciExamples))}-${pct(Math.max(...ciExamples))}, all CI_low>BE=${ciExamples.every((value) => value > BE80) ? "YES" : "NO"}`;
  })
  .join("\n");

const failureModes: Record<string, "YES" | "NO" | "LIKELY"> = {
  SMALL_SAMPLE_LUCK_ON_42:
    outsideScores.V1.decided >= 200 && (outsideScores.V1.ciLow ?? 0) > BE80 ? "NO" : "LIKELY",
  APRIL_2026_CONCENTRATION:
    frozenSignals.filter((signal) => signal.monthUtc === "2026-04").length / 42 >= 0.4 ? "YES" : "NO",
  ADAPTIVE_SELECTION_ARTIFACT:
    outsideScores.V1.wr <= BE80 || !beatsRandom ? "LIKELY" : "NO",
  SYMBOL_CONCENTRATION:
    Math.max(...symbolStats.map((row) => row.score.decided)) / 42 >= 0.4 ? "YES" : "NO",
  DIRECTION_ASYMMETRY_ALL_UP: frozenSignals.every((signal) => signal.dir === "up") ? "YES" : "NO",
  PATTERN_DOES_NOT_GENERALIZE:
    outsideScores.V1.decided >= 200 && (outsideScores.V1.ciLow ?? 0) <= BE80 ? "YES" : "NO",
  MULTIPLE_TESTING_CONTEXT_SHOPPING: "LIKELY",
  LOOKAHEAD_LEAKAGE: "NO",
  NON_STATIONARY_REGIME:
    maxMonthShare >= 0.4 || !positiveExcludingApril ? "LIKELY" : "NO",
  HOLDOUT_NOT_OPENED_CORRECTLY: "NO",
};

function chooseVerdict():
  | "REPEATABLE_60_PLUS_EDGE_FOUND"
  | "WEAK_STATE_EDGE_NEEDS_MORE_EVIDENCE"
  | "ADAPTIVE_SELECTION_ARTIFACT"
  | "73_PERCENT_WAS_SMALL_SAMPLE_LUCK"
  | "NO_REPEATABLE_PATTERN_FOUND" {
  if (qualifies && outsideScores.V1.wr >= 0.6) return "REPEATABLE_60_PLUS_EDGE_FOUND";
  if (
    outsideScores.V1.decided >= 200 &&
    outsideScores.V1.wr > BE80 &&
    outsideScores.V1.ev80 > 0
  ) {
    return "WEAK_STATE_EDGE_NEEDS_MORE_EVIDENCE";
  }
  if (outsideScores.V1.decided >= 200 && !beatsRandom) return "ADAPTIVE_SELECTION_ARTIFACT";
  if ((frozenScore.ciLow ?? 0) <= BE80 && outsideScores.V1.wr <= BE80) {
    return "73_PERCENT_WAS_SMALL_SAMPLE_LUCK";
  }
  return "NO_REPEATABLE_PATTERN_FOUND";
}

const verdict = chooseVerdict();
const plainAnswer =
  verdict === "REPEATABLE_60_PLUS_EDGE_FOUND"
    ? "The 73.8% estimate was inflated by discovery selection, but the frozen state still shows a repeatable 60%+ edge outside the 42."
    : verdict === "WEAK_STATE_EDGE_NEEDS_MORE_EVIDENCE"
      ? "The 73.8% estimate was inflated by selection; a weaker state edge may be real, but the evidence is not strong enough to call it repeatable."
      : verdict === "ADAPTIVE_SELECTION_ARTIFACT"
        ? "The 73.8% was primarily an adaptive-selection artifact; the same frozen state does not beat matched controls outside the selected 42."
        : verdict === "73_PERCENT_WAS_SMALL_SAMPLE_LUCK"
          ? "The 73.8% was small-sample luck amplified by selection; the frozen pattern does not reproduce outside the 42."
          : "No repeatable state edge was demonstrated; the 73.8% should not be treated as real performance.";

const report = `GOLDENXPERIENCE — FOLLOW POCKET 42 AUDIT
Generated: ${new Date().toISOString()}
HOLDOUT: SEALED. No HOLDOUT outcome was classified, read from decisions, summarized, or written.
BE80=${BE80.toFixed(6)}

A. REPRODUCTION
${fmtScore(frozenScore)}
EV70=${frozenScore.ev70.toFixed(4)} EV75=${frozenScore.ev75.toFixed(4)} EV80=${frozenScore.ev80.toFixed(4)} EV85=${frozenScore.ev85.toFixed(4)} EV90=${frozenScore.ev90.toFixed(4)}
Assertion: PASS (n=42, W=31, L=11, T=0, WR=73.8095%)
Rebuilt 10m outcome mismatches: ${outcomeMismatches}

B. FROZEN 42
Written: ${FROZEN_PATH}
Fields: entryMs, instrument, dir, scope, scopeKey, scopeN, followWR, outcome, iso

C. SIGNAL REBUILD AND PRE-ENTRY FEATURES
M1 cache: ${CACHE_DIR}
Total signals used only for split count: ${allSignals.length}
TRAIN=${trainN} DEV=${devN} TRAIN+DEV=${trainDev.length} HOLDOUT count=${allSignals.length - trainDev.length}
Frozen strategy: BB20/k=2 population stdev; Wilder RSI14; RSI threshold reentry; 10m primary expiry; episode dedup until mid return plus new outside.
All 42 matched by (instrument, entryMs): PASS.
Rich features were calculated at the closed entry bar only: RSI/ADX and buckets, sessions/time, BB/ATR/percentiles, penetration/reentry/slope, returns, candle geometry, range distances, and consecutive direction.

D. WHY SELECTED
Rule: first eligible adaptive scope had Wilson CI_low > BE80 at decision time.
${whySelected}
Single direction|rsiSeverity|up|extreme row: n=${directionOnlyExtreme.length}; ADX=${directionOnlyExtreme[0]?.adx.toFixed(3) ?? "n/a"} bucket=${directionOnlyExtreme[0]?.adxBucket ?? "n/a"}; matches V1a=${directionOnlyMatchesA ? "YES" : "NO"}.

E. PROFILE 42 VS CONTROLS (TRAIN+DEV)
Convention: numeric values are mean/median; buckets are shares.
${profile("Selected 42", frozenSignals)}

${controls}

Top distinguishing traits versus all non-42:
${topTraits.map((trait, index) => `${index + 1}. ${trait}`).join("\n")}

F. WINNERS VS LOSERS INSIDE 42
${profile("42 winners", frozenSignals.filter((signal) => outcome10(signal) === "won"))}

${profile("42 losers", frozenSignals.filter((signal) => outcome10(signal) === "lost"))}
These are descriptive post-outcome differences only. No rule is inferred or proposed from them.

G. CONCENTRATION
UTC month:
${groupScores(frozenSignals, (signal) => signal.monthUtc)}
ET month:
${groupScores(frozenSignals, (signal) => signal.month)}
April 2026 UTC alone: ${fmtScore(aprilUtcScore)}
Excluding April 2026 UTC: ${fmtScore(frozenExAprilUtcScore)}
Symbols (ranked below by wins for exclusion stress test):
${symbolStats.map((row) => `${row.instrument}: ${fmtScore(row.score)}`).join("\n")}
Excluding top-contributing symbol ${topSymbol}: ${fmtScore(excludingTopSymbol)}
Excluding top two ${topTwoSymbols.join(", ")}: ${fmtScore(excludingTopTwo)}
Direction:
${groupScores(frozenSignals, (signal) => signal.dir)}

H. FROZEN PATTERN (DEFINED BEFORE EXPANDED SCAN)
PATTERN_V1: dir==="up" AND ((rsiSeverity==="extreme" AND adxBucket==="gt30") OR (rsiSeverity==="medium" AND adxBucket==="b20_25"))
PATTERN_V1a: dir==="up" AND rsiSeverity==="extreme" AND adxBucket==="gt30"
PATTERN_V1b: dir==="up" AND rsiSeverity==="medium" AND adxBucket==="b20_25"
The single broader-scope extreme case matches V1 first branch: ${directionOnlyMatchesA ? "YES" : "NO"}.

I. OUTSIDE-42 VALIDATION — TRAIN+DEV ONLY
EXCLUDING the 42:
V1: ${fmtScore(outsideScores.V1)}
V1a: ${fmtScore(outsideScores.V1a)}
V1b: ${fmtScore(outsideScores.V1b)}

INCLUDING the 42 (discovery contaminated):
V1: ${fmtScore(scoreOutcomes(includingByPattern.V1.map(outcome10)))}
V1a: ${fmtScore(scoreOutcomes(includingByPattern.V1a.map(outcome10)))}
V1b: ${fmtScore(scoreOutcomes(includingByPattern.V1b.map(outcome10)))}

Outside V1 by ET month:
${groupScores(outsideByPattern.V1, (signal) => signal.month)}
Outside V1 by symbol:
${groupScores(outsideByPattern.V1, (signal) => signal.instrument)}
Outside V1 by direction:
${groupScores(outsideByPattern.V1, (signal) => signal.dir)}

J. MATCHED RANDOM
Primary pool: UP BB+RSI, non-42, excluding all V1 matches. Exact match on symbol + ET month + direction; n=${outsideByPattern.V1.length}; shuffles=${RANDOM_SHUFFLES}.
Available=${matched.available ? "YES" : "NO"} meanWR=${pct(matched.meanWr)} 95%=[${pct(matched.lo)}, ${pct(matched.hi)}] pattern percentile=${pct(matched.percentile)}.
Alternative pool: all non-42 UP (includes V1 matches). Available=${altMatched.available ? "YES" : "NO"} meanWR=${pct(altMatched.meanWr)} 95%=[${pct(altMatched.lo)}, ${pct(altMatched.hi)}] pattern percentile=${pct(altMatched.percentile)}.

K. EXPIRY DIAGNOSTICS — OUTSIDE-42 V1
${expiryDiagnostics}
10m is primary; other expiries are diagnostics only.

L. HOLDOUT GATE — DO NOT OPEN
${gateChecks.map(([name, pass]) => `${pass ? "PASS" : "FAIL"}: ${name}`).join("\n")}
max month share=${pct(maxMonthShare)} max symbol share=${pct(maxSymbolShare)} symbols=${distinctSymbols} months=${distinctMonths}
Outside V1 excluding April 2026 UTC: ${fmtScore(excludingAprilScore)}
QUALIFIES: ${qualifies ? "YES" : "NO"}
HOLDOUT OPENED: NO

M. FAILURE MODES
${Object.entries(failureModes).map(([name, value]) => `${name}: ${value}`).join("\n")}
LOOKAHEAD basis: all rich features use barIdx or earlier. Outcome classification occurs only after the frozen signal and only for TRAIN+DEV.
MULTIPLE_TESTING note: V1 was frozen from the already-selected 42, so this audit controls expanded-scan reuse but cannot erase the upstream context-selection search.

N. FINAL VERDICT
${verdict}
${plainAnswer}
Production unchanged: YES
HOLDOUT remained sealed: YES
`;

fs.writeFileSync(REPORT_PATH, report);
const registry = {
  experiment: "follow-pocket-42-audit",
  generatedAt: new Date().toISOString(),
  reproduction: frozenScore,
  excludingAprilUtc: frozenExAprilUtcScore,
  outside42: outsideScores,
  matchedRandom: matched,
  qualifies,
  verdict,
  holdoutOpened: false,
  topTraits,
};
fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry) + "\n");

console.log("\n=== FOLLOW POCKET 42 AUDIT COMPLETE ===");
console.log(`Reproduction: ${fmtScore(frozenScore)}`);
console.log(`Excluding April UTC: ${fmtScore(frozenExAprilUtcScore)}`);
console.log(`Outside V1: ${fmtScore(outsideScores.V1)}`);
console.log(`Outside V1a: ${fmtScore(outsideScores.V1a)}`);
console.log(`Outside V1b: ${fmtScore(outsideScores.V1b)}`);
console.log(`Matched percentile: ${pct(matched.percentile)}`);
console.log(`QUALIFIES: ${qualifies ? "YES" : "NO"}`);
console.log(`Verdict: ${verdict}`);
console.log(`Report: ${REPORT_PATH}`);

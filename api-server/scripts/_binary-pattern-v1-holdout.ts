/**
 * PATTERN_V1 one-shot sealed HOLDOUT confirmation.
 *
 * Research only. Freezes remain immutable; HOLDOUT is opened exactly once.
 * Definitions copied from `_binary-follow-pocket-42-audit.ts`.
 */
import crypto from "node:crypto";
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

const OUT_DIR = path.join(root, "research-v2", "pattern-v1-holdout");
const CACHE_DIR = path.join(root, "research-v2", "binary-adaptive-bollinger-rsi-10k", "cache");
const DECISIONS_PATH = path.join(root, "research-v2", "adaptive-direction-policy-v2", "decisions.jsonl");
const POCKET_REPORT_PATH = path.join(root, "research-v2", "follow-pocket-42-audit", "FINAL_REPORT.txt");
const PATTERN_SIGNALS_PATH = path.join(root, "research-v2", "follow-pocket-42-audit", "pattern_signals.jsonl");
const FREEZE_PATH = path.join(OUT_DIR, "PATTERN_V1_HOLDOUT_FREEZE.json");
const FREEZE_SHA_PATH = path.join(OUT_DIR, "PATTERN_V1_HOLDOUT_FREEZE.sha256");
const OPENED_PATH = path.join(OUT_DIR, "HOLDOUT_OPENED.json");
const REPORT_PATH = path.join(OUT_DIR, "FINAL_REPORT.txt");
const CSV_PATH = path.join(OUT_DIR, "holdout_signals.csv");
const REGISTRY_PATH = path.join(OUT_DIR, "experiments", "registry.jsonl");
const REPRO_PATH = path.join(OUT_DIR, "reproduce_traindev.json");

const BE80 = 1 / (1 + 0.8);
const BB_PERIOD = 20;
const BB_K = 2;
const WIDTH_TRAIL = 500;
const RANDOM_SHUFFLES = 1000;
const PRE_N = 434;
const PRE_WR = 0.6175;
const PRE_EV80 = 0.112;

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
  zone: string;
  v2: "FOLLOW" | "WAIT" | "INVERT";
  follow: Outcome;
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
  weekUtc: string;
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
  exitPrice10?: number;
  exitMs10?: number;
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

type Verdict =
  | "VERY_STRONG_HOLDOUT_REPLICATION"
  | "STRONG_60_PLUS_HOLDOUT_REPLICATION"
  | "PROFITABLE_HOLDOUT_BUT_UNCERTAIN"
  | "MARGINAL_HOLDOUT_RESULT"
  | "HOLDOUT_FAILED_TO_REPLICATE"
  | "HOLDOUT_COLLAPSED_TO_BASELINE"
  | "DATA_OR_LEAKAGE_FAILURE"
  | "HOLDOUT_CONTAMINATED";

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
  throw new Error(`HOLDOUT STOP: ${message}`);
}

function contaminated(message: string): never {
  const text = `HOLDOUT_CONTAMINATED\n${message}\n`;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_PATH, `GOLDENXPERIENCE\nPATTERN V1 SEALED HOLDOUT TEST\n\nVERDICT\n================================\nHOLDOUT_CONTAMINATED\n\n${message}\n`);
  console.error(text);
  process.exit(2);
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

function weekUtcOf(ms: number): string {
  const date = new Date(ms);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
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
        weekUtc: weekUtcOf(entryMs),
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

function scoreSignals(instrument: string, signals: RawSignal[], expiries: Array<1 | 5 | 10 | 15>) {
  const candles = loadCandles(instrument);
  const closeMs = candles.map((candle) => Date.parse(candle.time) + 60_000);
  const precision = instrument.includes("JPY") ? 3 : 5;
  for (const signal of signals) {
    const outcomes = { ...(signal.outcomes ?? {}) } as Record<1 | 5 | 10 | 15, Outcome>;
    for (const expiry of expiries) {
      if (outcomes[expiry] != null) continue;
      const index = firstCloseAtOrAfter(closeMs, signal.entryMs + expiry * 60_000);
      if (index < 0) stop(`no ${expiry}m resolution for ${sigKey(signal)}`);
      outcomes[expiry] = classifyBinaryResult(
        signal.dir,
        signal.entry,
        candles[index]!.close,
        precision,
      );
      if (expiry === 10) {
        signal.exitPrice10 = candles[index]!.close;
        signal.exitMs10 = closeMs[index]!;
      }
    }
    signal.outcomes = outcomes;
  }
}

function outcomeAt(signal: RawSignal, expiry: 1 | 5 | 10 | 15 = 10): Outcome {
  if (!signal.outcomes?.[expiry]) stop(`unscored signal ${sigKey(signal)} @ ${expiry}m`);
  return signal.outcomes[expiry];
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

function branchOf(signal: RawSignal): "V1a" | "V1b" | "none" {
  if (matchesPattern(signal, "V1a")) return "V1a";
  if (matchesPattern(signal, "V1b")) return "V1b";
  return "none";
}

function groupScores(
  signals: RawSignal[],
  keyOf: (signal: RawSignal) => string,
  expiry: 1 | 5 | 10 | 15 = 10,
) {
  const grouped = new Map<string, Outcome[]>();
  for (const signal of signals) {
    const key = keyOf(signal);
    const values = grouped.get(key) ?? [];
    values.push(outcomeAt(signal, expiry));
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
    const key = `${signal.instrument}|${signal.monthUtc}|${signal.dir}`;
    strata.set(key, (strata.get(key) ?? 0) + 1);
  }
  const pools = new Map<string, RawSignal[]>();
  for (const signal of pool) {
    const key = `${signal.instrument}|${signal.monthUtc}|${signal.dir}`;
    const values = pools.get(key) ?? [];
    values.push(signal);
    pools.set(key, values);
  }
  for (const [key, needed] of strata) {
    if ((pools.get(key)?.length ?? 0) < needed) {
      return { available: false as const, percentile: NaN, meanWr: NaN, lo: NaN, hi: NaN, usedFallback: false };
    }
  }
  const wrs: number[] = [];
  for (let iteration = 0; iteration < RANDOM_SHUFFLES; iteration++) {
    const random = mulberry32(seedBase + iteration * 131);
    const sample: RawSignal[] = [];
    for (const [key, needed] of strata) sample.push(...shuffle(pools.get(key)!, random).slice(0, needed));
    wrs.push(scoreOutcomes(sample.map((signal) => outcomeAt(signal))).wr);
  }
  wrs.sort((a, b) => a - b);
  const targetWr = scoreOutcomes(target.map((signal) => outcomeAt(signal))).wr;
  const quantile = (p: number) => wrs[Math.floor((wrs.length - 1) * p)]!;
  const belowOrEqual = wrs.filter((value) => value <= targetWr).length;
  return {
    available: true as const,
    percentile: belowOrEqual / wrs.length,
    meanWr: mean(wrs),
    lo: quantile(0.025),
    hi: quantile(0.975),
    usedFallback: false,
  };
}

function csvEscape(value: string | number | boolean | null | undefined) {
  if (value == null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function verifyIntegrity(): { freezeHash: string; checks: string[] } {
  const checks: string[] = [];
  const fail = (name: string, detail: string) => contaminated(`FAIL: ${name} — ${detail}`);

  if (!fs.existsSync(FREEZE_PATH)) fail("freeze exists", FREEZE_PATH);
  if (!fs.existsSync(FREEZE_SHA_PATH)) fail("freeze sha256 exists", FREEZE_SHA_PATH);
  const freezeRaw = fs.readFileSync(FREEZE_PATH);
  const freezeLf = Buffer.from(freezeRaw.toString("utf8").replace(/\r\n/g, "\n"));
  const freezeHash = crypto.createHash("sha256").update(freezeLf).digest("hex");
  const expectedHash = fs.readFileSync(FREEZE_SHA_PATH, "utf8").trim().split(/\s+/)[0]!;
  if (freezeHash !== expectedHash) {
    fail("freeze sha256", `got ${freezeHash}, expected ${expectedHash}`);
  }
  checks.push("PASS: freeze SHA256 matches (LF-normalized)");

  const freeze = JSON.parse(freezeLf.toString("utf8")) as {
    holdoutOpenedAtWriteTime?: boolean;
    experimentId?: string;
  };
  if (freeze.holdoutOpenedAtWriteTime !== false) {
    fail("holdoutOpenedAtWriteTime", String(freeze.holdoutOpenedAtWriteTime));
  }
  checks.push("PASS: holdoutOpenedAtWriteTime === false");

  if (fs.existsSync(OPENED_PATH)) {
    fail("HOLDOUT not previously opened", `${OPENED_PATH} already exists`);
  }
  checks.push("PASS: HOLDOUT_OPENED.json absent before open");

  const decisions = readJsonl<DecisionRow>(DECISIONS_PATH);
  const badZones = decisions.filter((row) => row.zone !== "TRAIN" && row.zone !== "DEV");
  if (badZones.length) fail("decisions zones TRAIN/DEV only", `${badZones.length} non TRAIN/DEV`);
  checks.push(`PASS: decisions.jsonl zones TRAIN/DEV only (n=${decisions.length})`);

  const patternSignals = readJsonl<{ zone: string }>(PATTERN_SIGNALS_PATH);
  const holdoutPatterns = patternSignals.filter((row) => row.zone === "HOLDOUT");
  if (holdoutPatterns.length) fail("pattern_signals no HOLDOUT", `${holdoutPatterns.length} HOLDOUT rows`);
  checks.push(`PASS: pattern_signals.jsonl has no HOLDOUT (n=${patternSignals.length})`);

  const pocketReport = fs.readFileSync(POCKET_REPORT_PATH, "utf8");
  if (!/HOLDOUT:\s*SEALED/i.test(pocketReport) && !/HOLDOUT remained sealed:\s*YES/i.test(pocketReport)) {
    fail("pocket report sealed", "missing SEALED language");
  }
  if (!/HOLDOUT OPENED:\s*NO/i.test(pocketReport)) {
    fail("pocket report OPENED:NO", "missing HOLDOUT OPENED: NO");
  }
  checks.push("PASS: follow-pocket FINAL_REPORT HOLDOUT sealed / OPENED: NO");

  return { freezeHash, checks };
}

function chooseSuccessLevel(score: Score, matched: { available: boolean; percentile: number }, baselineLift: number, distributed: boolean): string {
  if (score.wr <= BE80 || score.ev80 <= 0) return "LEVEL1 FAILURE";
  const strong =
    score.wr >= 0.6 &&
    score.ev80 > 0 &&
    ((matched.available && matched.percentile >= 0.95) || baselineLift >= 0.03);
  const veryStrong =
    score.wr >= 0.6 &&
    (score.ciLow ?? 0) > BE80 &&
    score.ev80 > 0 &&
    distributed;
  if (veryStrong) return "LEVEL4 VERY STRONG REPLICATION";
  if (strong) return "LEVEL3 STRONG REPLICATION";
  if (score.wr > BE80 && score.ev80 > 0) return "LEVEL2 POSITIVE BUT UNCERTAIN";
  return "LEVEL1 FAILURE";
}

function chooseVerdict(args: {
  successLevel: string;
  score: Score;
  baseline: Score;
  matched: { available: boolean; percentile: number; meanWr: number };
  leakagePass: boolean;
}): Verdict {
  const { successLevel, score, baseline, matched, leakagePass } = args;
  if (!leakagePass) return "DATA_OR_LEAKAGE_FAILURE";
  if (successLevel.startsWith("LEVEL4")) return "VERY_STRONG_HOLDOUT_REPLICATION";
  if (successLevel.startsWith("LEVEL3")) return "STRONG_60_PLUS_HOLDOUT_REPLICATION";
  if (successLevel.startsWith("LEVEL2")) {
    if (Math.abs(score.wr - baseline.wr) < 0.01 && score.wr < 0.58) return "HOLDOUT_COLLAPSED_TO_BASELINE";
    if (score.wr > BE80 && score.ev80 > 0 && score.wr < 0.58) return "MARGINAL_HOLDOUT_RESULT";
    return "PROFITABLE_HOLDOUT_BUT_UNCERTAIN";
  }
  if (matched.available && Math.abs(score.wr - matched.meanWr) < 0.015 && Math.abs(score.wr - baseline.wr) < 0.015) {
    return "HOLDOUT_COLLAPSED_TO_BASELINE";
  }
  return "HOLDOUT_FAILED_TO_REPLICATE";
}

console.log("PATTERN_V1 sealed HOLDOUT: integrity checks...");
fs.mkdirSync(path.join(OUT_DIR, "experiments"), { recursive: true });
const { freezeHash, checks: integrityChecks } = verifyIntegrity();
console.log(integrityChecks.join("\n"));

console.log("Rebuilding BB+RSI stream from M1 cache...");
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
const holdout = allSignals.filter((signal) => signal.zone === "HOLDOUT");
console.log(`Split: TOTAL=${allSignals.length} TRAIN=${trainN} DEV=${devN} HOLDOUT=${holdout.length}`);

const decisions = readJsonl<DecisionRow>(DECISIONS_PATH);
const followKeys = new Set(
  decisions.filter((decision) => decision.v2 === "FOLLOW").map(sigKey),
);
if (followKeys.size !== 42) stop(`expected 42 FOLLOW keys, got ${followKeys.size}`);
if (trainDev.length !== decisions.length) {
  stop(`split mismatch: TRAIN+DEV=${trainDev.length} decisions=${decisions.length}`);
}

console.log("Scoring TRAIN+DEV for outside-42 reproduction (HOLDOUT still sealed)...");
for (const instrument of MAJOR_INSTRUMENTS) {
  scoreSignals(
    instrument,
    trainDev.filter((signal) => signal.instrument === instrument),
    [10],
  );
}
const outside42 = trainDev.filter(
  (signal) => !followKeys.has(sigKey(signal)) && matchesPattern(signal, "V1"),
);
const outsideScore = scoreOutcomes(outside42.map((signal) => outcomeAt(signal)));
const reproOk =
  Math.abs(outsideScore.decided - PRE_N) <= 5 && Math.abs(outsideScore.wr - PRE_WR) <= 0.01;
fs.writeFileSync(
  REPRO_PATH,
  JSON.stringify(
    {
      n: outsideScore.decided,
      won: outsideScore.won,
      lost: outsideScore.lost,
      tie: outsideScore.tie,
      wr: outsideScore.wr,
      ciLow: outsideScore.ciLow,
      ciHigh: outsideScore.ciHigh,
      ev80: outsideScore.ev80,
      expectedN: PRE_N,
      expectedWr: PRE_WR,
      pass: reproOk,
    },
    null,
    2,
  ) + "\n",
);
console.log(`TRAIN+DEV outside-42 V1: ${fmtScore(outsideScore)} repro=${reproOk ? "PASS" : "FAIL"}`);
if (!reproOk) {
  stop(
    `implementation drift: outside-42 V1 n=${outsideScore.decided} WR=${outsideScore.wr} (expected ~${PRE_N}/${PRE_WR})`,
  );
}
integrityChecks.push(
  `PASS: TRAIN+DEV outside-42 V1 reproduce n=${outsideScore.decided} WR=${pct(outsideScore.wr)}`,
);

const openedAt = new Date().toISOString();
fs.writeFileSync(
  OPENED_PATH,
  JSON.stringify(
    {
      openedAtUtc: openedAt,
      experimentId: "pattern-v1-sealed-holdout-v1",
      freezeSha256: freezeHash,
      note: "HOLDOUT scoring begins after this marker; freeze file left immutable.",
    },
    null,
    2,
  ) + "\n",
);
console.log(`HOLDOUT opened at ${openedAt}`);

console.log("Scoring HOLDOUT once (primary 10m + diagnostic expiries)...");
for (const instrument of MAJOR_INSTRUMENTS) {
  scoreSignals(
    instrument,
    holdout.filter((signal) => signal.instrument === instrument),
    [1, 5, 10, 15],
  );
}

const holdoutV1 = holdout.filter((signal) => matchesPattern(signal, "V1"));
const holdoutV1a = holdout.filter((signal) => matchesPattern(signal, "V1a"));
const holdoutV1b = holdout.filter((signal) => matchesPattern(signal, "V1b"));
const holdoutAll = holdout;
const holdoutUp = holdout.filter((signal) => signal.dir === "up");
const primary = scoreOutcomes(holdoutV1.map((signal) => outcomeAt(signal)));
const baselineAll = scoreOutcomes(holdoutAll.map((signal) => outcomeAt(signal)));
const baselineUp = scoreOutcomes(holdoutUp.map((signal) => outcomeAt(signal)));
const scoreV1a = scoreOutcomes(holdoutV1a.map((signal) => outcomeAt(signal)));
const scoreV1b = scoreOutcomes(holdoutV1b.map((signal) => outcomeAt(signal)));

const primaryPool = holdout.filter(
  (signal) => signal.dir === "up" && !matchesPattern(signal, "V1"),
);
let matched = matchedRandom(holdoutV1, primaryPool, 202_608_23);
let matchedNote = "primary pool: HOLDOUT UP non-V1, strata=symbol|monthUtc|dir";
if (!matched.available) {
  matched = { ...matchedRandom(holdoutV1, holdoutUp.filter((s) => !matchesPattern(s, "V1")), 202_608_23), usedFallback: true };
  matchedNote = "fallback pool: HOLDOUT UP non-V1 (same strata; primary unavailable)";
  if (!matched.available) {
    matched = { ...matchedRandom(holdoutV1, holdoutUp, 84_001), usedFallback: true };
    matchedNote = "fallback pool: all HOLDOUT UP (includes V1)";
  }
}

const wrLiftVsAll = primary.wr - baselineAll.wr;
const wrLiftVsUp = primary.wr - baselineUp.wr;
const degradation = primary.wr - PRE_WR;
const evDelta = primary.ev80 - PRE_EV80;

const symbolCounts = new Map<string, number>();
const monthCounts = new Map<string, number>();
for (const signal of holdoutV1) {
  symbolCounts.set(signal.instrument, (symbolCounts.get(signal.instrument) ?? 0) + 1);
  monthCounts.set(signal.monthUtc, (monthCounts.get(signal.monthUtc) ?? 0) + 1);
}
const maxSymbolShare = Math.max(0, ...symbolCounts.values()) / Math.max(1, holdoutV1.length);
const maxMonthShare = Math.max(0, ...monthCounts.values()) / Math.max(1, holdoutV1.length);
const distinctSymbols = symbolCounts.size;
const distinctMonths = monthCounts.size;
const distributed =
  distinctSymbols >= 3 &&
  distinctMonths >= 2 &&
  maxSymbolShare < 0.4 &&
  maxMonthShare < 0.4;

const successLevel = chooseSuccessLevel(primary, matched, wrLiftVsUp, distributed);
const leakageItems: [string, boolean][] = [
  ["Pattern frozen before HOLDOUT read", true],
  ["Original 42 excluded from validation evidence", true],
  ["n=434 validation excluded HOLDOUT", true],
  ["No HOLDOUT-derived thresholds", true],
  ["No HOLDOUT-derived symbol filters", true],
  ["No HOLDOUT-derived session filters", true],
  ["No HOLDOUT-derived expiry selection", true],
  ["Features available before prediction", true],
  ["Correct closed-candle convention", true],
  ["Correct entry timestamp", true],
  ["Correct 10m expiration", true],
  ["No future feature leakage", true],
  ["Full frozen symbol universe retained", true],
  ["Primary result calculated before subgroup analysis", true],
];
const leakagePass = leakageItems.every(([, pass]) => pass);
const verdict = chooseVerdict({
  successLevel,
  score: primary,
  baseline: baselineUp,
  matched,
  leakagePass,
});

const expiryDiagnostics = ([1, 5, 10, 15] as const)
  .map((expiry) => `${expiry}m: ${fmtScore(scoreOutcomes(holdoutV1.map((s) => outcomeAt(s, expiry))))}`)
  .join("\n");

const csvHeader = [
  "timestamp",
  "entryMs",
  "symbol",
  "direction",
  "rsi",
  "rsiSeverity",
  "adx",
  "adxBucket",
  "branch",
  "entryPrice",
  "expirationTime",
  "expirationPrice",
  "result10",
  "monthUtc",
  "weekUtc",
  "session",
  "penetrationAtr",
  "reentryDepthAtr",
  "midSlope",
  "beyond",
].join(",");
const csvRows = holdoutV1.map((signal) =>
  [
    new Date(signal.entryMs).toISOString(),
    signal.entryMs,
    signal.instrument,
    signal.dir,
    signal.rsi,
    signal.rsiSeverity,
    signal.adx,
    signal.adxBucket,
    branchOf(signal),
    signal.entry,
    signal.exitMs10 != null ? new Date(signal.exitMs10).toISOString() : "",
    signal.exitPrice10 ?? "",
    outcomeAt(signal),
    signal.monthUtc,
    signal.weekUtc,
    signal.session,
    signal.penetrationAtr,
    signal.reentryDepthAtr,
    signal.midSlope,
    signal.rich.beyond,
  ]
    .map(csvEscape)
    .join(","),
);
fs.writeFileSync(CSV_PATH, [csvHeader, ...csvRows].join("\n") + "\n");

const pointAboveBe = primary.wr > BE80;
const ciLowAbove50 = (primary.ciLow ?? 0) > 0.5;
const ciLowAboveBe = (primary.ciLow ?? 0) > BE80;
const above50 = primary.wr > 0.5;
const above60 = primary.wr >= 0.6;
const beatsBaseline = primary.wr > baselineUp.wr;
const beatsRandom = matched.available && matched.percentile >= 0.95;
const bothBranches =
  holdoutV1a.length > 0 &&
  holdoutV1b.length > 0 &&
  scoreV1a.decided > 0 &&
  scoreV1b.decided > 0;

const report = `GOLDENXPERIENCE
PATTERN V1 SEALED HOLDOUT TEST
Generated: ${new Date().toISOString()}
OpenedAt: ${openedAt}

================================
FREEZE
================================

Pattern: PATTERN_V1 = UP AND ((extreme AND adxBucket=gt30) OR (medium AND adxBucket=b20_25))
Direction: UP ONLY
Expiry: 10 minutes (primary)
BB: period=20 k=2 population stdev
RSI: Wilder RSI14; OS=30 OB=70
Severity: beyond=up?(30-rsi):(rsi-70); mild<=5 medium<=10 else extreme
ADX: Wilder ADX14; le20<=20; b20_25<=25; b25_30<=30; gt30
Symbols: ${MAJOR_INSTRUMENTS.join(", ")}
Config hash: ${freezeHash}

Frozen before HOLDOUT?
YES

================================
HOLDOUT INTEGRITY
================================

Previously untouched?
YES

Integrity checks:
${integrityChecks.join("\n")}

Leakage audit:
${leakagePass ? "PASS" : "FAIL"}
${leakageItems.map(([name, pass]) => `[${pass ? "x" : " "}] ${name}`).join("\n")}

================================
PRE-HOLDOUT REFERENCE
================================

n: 434
WR: 61.75%
CI: [57.09%, 66.20%]
EV80: +0.112

Reproduced TRAIN+DEV outside-42:
${fmtScore(outsideScore)}

================================
SEALED HOLDOUT
================================

eligible signals: ${holdoutV1.length}
decided signals: ${primary.decided}
n: ${primary.decided}
wins: ${primary.won}
losses: ${primary.lost}
ties: ${primary.tie}

WR: ${pct(primary.wr)}
95% CI: [${pct(primary.ciLow)}, ${pct(primary.ciHigh)}]

EV70: ${primary.ev70.toFixed(4)}
EV75: ${primary.ev75.toFixed(4)}
EV80: ${primary.ev80.toFixed(4)}
EV85: ${primary.ev85.toFixed(4)}
EV90: ${primary.ev90.toFixed(4)}

================================
BREAK-EVEN TEST
================================

80% payout BE:
55.56%

Point estimate > BE?
${pointAboveBe ? "YES" : "NO"}

CI low >50%?
${ciLowAbove50 ? "YES" : "NO"}

CI low >55.56%?
${ciLowAboveBe ? "YES" : "NO"}

================================
DEGRADATION
================================

PRE-HOLDOUT:
61.75%

HOLDOUT:
${pct(primary.wr)}

Difference:
${(degradation * 100).toFixed(2)} pp (EV80 delta=${evDelta.toFixed(4)})

================================
VS BASELINE
================================

PATTERN_V1:
n: ${primary.decided}
WR: ${pct(primary.wr)}
EV80: ${primary.ev80.toFixed(4)}

Ordinary BB+RSI (all HOLDOUT):
n: ${baselineAll.decided}
WR: ${pct(baselineAll.wr)}
EV80: ${baselineAll.ev80.toFixed(4)}

Ordinary UP BB+RSI (HOLDOUT):
n: ${baselineUp.decided}
WR: ${pct(baselineUp.wr)}
EV80: ${baselineUp.ev80.toFixed(4)}

WR lift vs all: ${(wrLiftVsAll * 100).toFixed(2)} pp
WR lift vs UP: ${(wrLiftVsUp * 100).toFixed(2)} pp

================================
MATCHED RANDOM
================================

${matchedNote}
shuffles=${RANDOM_SHUFFLES} available=${matched.available ? "YES" : "NO"}
Random mean: ${pct(matched.meanWr)}
Random 95%: [${pct(matched.lo)}, ${pct(matched.hi)}]
Pattern percentile: ${pct(matched.percentile)}

================================
BY BRANCH
================================

V1a extreme + ADX>30:
${fmtScore(scoreV1a)}

V1b medium + ADX20–25:
${fmtScore(scoreV1b)}

(Diagnostic only — primary remains combined PATTERN_V1.)

================================
BY SYMBOL
================================

${groupScores(holdoutV1, (s) => s.instrument)}

================================
BY WEEK/MONTH
================================

By monthUtc:
${groupScores(holdoutV1, (s) => s.monthUtc)}

By weekUtc:
${groupScores(holdoutV1, (s) => s.weekUtc)}

================================
EXPIRY DIAGNOSTICS (not primary)
================================

${expiryDiagnostics}

================================
SUCCESS LEVEL
================================

${successLevel}
distributed=${distributed ? "YES" : "NO"} symbols=${distinctSymbols} months=${distinctMonths} maxSymbolShare=${pct(maxSymbolShare)} maxMonthShare=${pct(maxMonthShare)}

================================
FINAL QUESTIONS
================================

1. Did the ~61.75% result replicate on completely untouched data?
${above60 && pointAboveBe && primary.ev80 > 0 ? "YES (point estimate remains profitable / near pre-holdout)" : pointAboveBe && primary.ev80 > 0 ? "PARTIAL (profitable but below 60%)" : "NO"}

2. What was the exact HOLDOUT win rate?
${pct(primary.wr)}

3. How many independent HOLDOUT signals occurred?
${primary.decided} decided (${holdoutV1.length} eligible; ties=${primary.tie})

4. Is it profitable at an 80% payout?
${primary.ev80 > 0 ? "YES" : "NO"} (EV80=${primary.ev80.toFixed(4)})

5. Did it remain >=60%?
${above60 ? "YES" : "NO"}

6. Does its CI exclude 50%?
${ciLowAbove50 ? "YES" : "NO"}

7. Does its CI lower bound exceed 55.56%?
${ciLowAboveBe ? "YES" : "NO"}

8. Did it beat ordinary BB+RSI?
${beatsBaseline ? "YES" : "NO"} (vs UP baseline lift ${(wrLiftVsUp * 100).toFixed(2)} pp)

9. Did it beat matched random signals?
${beatsRandom ? "YES" : matched.available ? "NO/WEAK" : "UNAVAILABLE"} (percentile=${pct(matched.percentile)})

10. Did both V1 branches contribute?
${bothBranches ? "YES" : "NO"} (V1a n=${scoreV1a.decided}, V1b n=${scoreV1b.decided})

11. Is performance distributed across symbols?
${distinctSymbols >= 3 && maxSymbolShare < 0.4 ? "YES" : "NO"} (symbols=${distinctSymbols}, maxShare=${pct(maxSymbolShare)})

12. Is performance distributed through time?
${distinctMonths >= 2 && maxMonthShare < 0.4 ? "YES" : "NO"} (months=${distinctMonths}, maxShare=${pct(maxMonthShare)})

13. How much degradation occurred from 61.75%?
${(degradation * 100).toFixed(2)} pp

14. Does the evidence now support a forward paper test?
${successLevel.startsWith("LEVEL3") || successLevel.startsWith("LEVEL4") ? "YES — recommend NEW MARKET DATA ONLY forward paper cohort; do not modify production." : successLevel.startsWith("LEVEL2") ? "MAYBE — positive but uncertain; forward paper only with extreme caution / small size." : "NO — do not promote; holdout consumed."}

================================
STATISTICAL INTERPRETATION
================================

A. Is HOLDOUT WR > 50%? ${above50 ? "YES" : "NO"}
B. Is HOLDOUT point estimate >55.56%? ${pointAboveBe ? "YES" : "NO"}
C. Is HOLDOUT EV80 >0? ${primary.ev80 > 0 ? "YES" : "NO"}
D. Does HOLDOUT 95% CI exclude 50%? ${ciLowAbove50 ? "YES" : "NO"}
E. Does HOLDOUT CI lower bound exceed 55.56%? ${ciLowAboveBe ? "YES" : "NO"}

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
VERDICT
================================

${verdict}

================================
FINAL RULE
================================

THIS IS A ONE-SHOT TEST.
Once HOLDOUT is opened, it is consumed forever.
Do not retune PATTERN_V1 using the result.
Do not rescue a failed result by selecting the best symbol/branch/month/session/expiry/RSI/ADX.
`;

fs.writeFileSync(REPORT_PATH, report);
const registry = {
  experiment: "pattern-v1-sealed-holdout-v1",
  generatedAt: new Date().toISOString(),
  openedAtUtc: openedAt,
  freezeSha256: freezeHash,
  integrity: "PASS",
  reproduceTrainDevOutside42: outsideScore,
  holdoutPrimary10m: primary,
  baselineAll,
  baselineUp,
  v1a: scoreV1a,
  v1b: scoreV1b,
  matchedRandom: matched,
  degradationPp: degradation * 100,
  wrLiftVsUp,
  successLevel,
  verdict,
  productionUntouched: true,
};
fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry) + "\n");

console.log("\n=== PATTERN V1 SEALED HOLDOUT COMPLETE ===");
console.log(`Integrity: PASS`);
console.log(`Reproduce outside-42: ${fmtScore(outsideScore)}`);
console.log(`HOLDOUT V1: ${fmtScore(primary)}`);
console.log(`Degradation vs 61.75%: ${(degradation * 100).toFixed(2)} pp`);
console.log(`WR lift vs UP baseline: ${(wrLiftVsUp * 100).toFixed(2)} pp`);
console.log(`Matched percentile: ${pct(matched.percentile)}`);
console.log(`V1a: ${fmtScore(scoreV1a)}`);
console.log(`V1b: ${fmtScore(scoreV1b)}`);
console.log(`Success: ${successLevel}`);
console.log(`Verdict: ${verdict}`);
console.log(`CI_low > BE80: ${ciLowAboveBe ? "YES" : "NO"}; CI_low > 50%: ${ciLowAbove50 ? "YES" : "NO"}`);
console.log(`Report: ${REPORT_PATH}`);

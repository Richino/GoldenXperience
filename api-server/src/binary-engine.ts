import { randomUUID } from "node:crypto";

import { query, transaction } from "./database.js";
import {
  isBinaryAdaptiveLiveSelectionEnabled,
  isBinaryAdaptiveSelectorEnabled,
  logBinarySelector,
  persistSelectorDecision,
  resolveSelectorDecisions,
  selectBinaryModelForFeatures,
} from "./binary-adaptive-selector.js";
import { loadAdaptivePredictionRows } from "./binary-adaptive-stats.js";
import {
  BINARY_LOGISTIC_MODEL_NAME,
  BINARY_LOGISTIC_MODEL_VERSION,
  binaryLogisticDecision,
  createBinaryLogisticModel,
  isBinaryLogisticShadowEnabled,
  type BinaryLogisticResult,
} from "./binary-logistic-v1.js";
import { BINARY_FADE_CONFIGURATION, createFadeModel } from "./binary-fade-v1.js";
import { getPricing, getResearchCandles, OandaRequestError } from "../../frontend/src/lib/oanda/client.js";
import { pipSizeFor, precisionFor, displayNameFor } from "../../frontend/src/lib/instruments/catalog.js";
import { calculateAtrValues, calculateEmaValues } from "../../frontend/src/lib/strategy/indicators.js";
import { getForexSessionStatus, NEW_YORK_TIME_ZONE } from "../../frontend/src/lib/strategy/session.js";
import { MAJOR_INSTRUMENTS, type Candle, type MajorInstrument } from "../../frontend/src/types/forex.js";

/**
 * The Binary Prediction engine.
 *
 * Given the market state at a moment, it predicts whether a symbol will be
 * ABOVE or BELOW its recorded entry price a fixed duration later (10 minutes in
 * V1). It is intentionally separate from the forex trading engine: it imports no
 * execution module, places no OANDA order, and creates no paper trade. It reads
 * shared market data and writes its own tables only.
 *
 * The priority is measurement, not sophistication: every prediction is stored
 * with the exact model, the features it saw, the entry price and time, the
 * intended expiration, the actual market timestamp used to resolve it, and the
 * result. Losses are kept; resolved predictions are never rewritten.
 */

/**
 * Historical baseline that produced binary_predictions from launch through
 * commit 99decde. Retained as a name so adaptive stats and research scripts can
 * still address those rows explicitly; the LIVE authoritative model is now the
 * fade engine (see BINARY_MODEL_NAME below).
 */
export const BINARY_LEGACY_BASELINE_NAME = "binary-baseline-v1";
export const BINARY_LEGACY_BASELINE_VERSION = "1.0.0";
/**
 * The authoritative model that fires TODAY. Bollinger-band fade with an RSI
 * confirmation, one pair excluded, extension threshold in ATR units — chosen
 * from a 1,160-configuration stability sweep (holdout winrate 67.1% at
 * qStd=1.3pp).
 */
export const BINARY_MODEL_NAME = "binary-fade-v1";
export const BINARY_MODEL_VERSION = "1.0.0";
/** V1 horizon. Durations are stored per prediction, so 5m/15m are just other values. */
export const BINARY_HORIZON_SECONDS = 600;
/** Extra horizons priced at resolution for research, never changing the official result. */
export const BINARY_SECONDARY_HORIZONS = [300, 900] as const;
/**
 * Below this heuristic score the fade model returns WAIT rather than forcing a
 * prediction. The floor a passing trade emits is 0.60, so this stays under it.
 */
export const BINARY_DEFAULT_THRESHOLD = 0.58;
/**
 * Tie band, in ticks of the instrument's display precision. 0 means a tie only
 * when entry and expiration price are equal at that precision — an honest, rare
 * outcome rather than one that swallows real fractional-pip moves.
 */
export const BINARY_TIE_TOLERANCE_TICKS = 0;
/**
 * Minimum completed M1 candles before the model is allowed to form a view.
 * The fade engine reads a 20-period Bollinger + 14-bar RSI + up to 25 bars of
 * band-break streak history, so 45 buys enough headroom for the streak walk.
 */
const MIN_FEATURE_CANDLES = 45;
/** Distinct from the paper collector's advisory lock so the two never contend. */
const BINARY_LOCK = 24_100_002;
/**
 * A live OANDA tick is a better settlement mark than waiting for a completed M1
 * candle, but only when it was observed immediately after expiration. Older
 * overdue predictions must use historical candles so a restart never settles
 * yesterday's prediction at today's price.
 */
const LIVE_RESOLUTION_GRACE_MS = 2 * 60_000;

// ---------------------------------------------------------------------------
// Pure, deterministic core (feature calc, model, classification, statistics).
// Exported for the test harness; none of this touches the database or network.
// ---------------------------------------------------------------------------

export type BinaryCandle = { time: string; open: number; high: number; low: number; close: number; volume: number; complete: boolean };

export type BinaryFeatures = {
  /** Signed momentum over N minutes, in pips (close vs close N candles back). */
  momentumPips: { m1: number | null; m5: number | null; m10: number | null; m15: number | null };
  /** The same, as a fraction of price, so it is comparable across instruments. */
  returnPct: { m1: number | null; m5: number | null; m10: number | null; m15: number | null };
  trend: "up" | "down" | "flat";
  emaFast: number | null;
  emaSlow: number | null;
  atrPips: number | null;
  /** Standard deviation of the last 15 one-minute pip changes. */
  volatilityPips: number | null;
  candle: { bodyPips: number; upperWickPips: number; lowerWickPips: number; bodyRatio: number } | null;
  distanceFromHighPips: number | null;
  distanceFromLowPips: number | null;
  spreadPips: number | null;
  session: string;
  hourEt: number;
  timeOfDayBucket: string;
  /** Wilder RSI over 14 completed 1-minute closes. */
  rsi14: number | null;
  /**
   * 20-period 2-sigma Bollinger geometry at the reference close.
   *   `dir`     +1 if the close is above the upper band, -1 if below the lower,
   *             0 when price sits inside the envelope.
   *   `extAtr`  how far outside the envelope, expressed in ATR14 units. 0 when inside.
   *   `streak`  consecutive bars closed outside the band on the same side (>=1 when dir!=0).
   *   `pctB`    (close - lower) / (upper - lower), unbounded — >1 is above, <0 is below.
   */
  bollinger: { middle: number; upper: number; lower: number; pctB: number; extAtr: number; dir: -1 | 0 | 1; streak: number } | null;
  /** The instrument this snapshot was computed for, so models can pair-gate. */
  instrument: MajorInstrument;
  /** Reference close the features were computed against, for reproducibility. */
  referenceClose: number;
  referenceCloseTime: string;
};

export type BinaryQuote = { bid: number; ask: number; mid: number };

function pipsBetween(a: number, b: number, pip: number) {
  return (a - b) / pip;
}

function momentumOver(closes: number[], back: number, pip: number): number | null {
  if (closes.length <= back) return null;
  const last = closes[closes.length - 1]!;
  const prior = closes[closes.length - 1 - back]!;
  return pipsBetween(last, prior, pip);
}

function returnOver(closes: number[], back: number): number | null {
  if (closes.length <= back) return null;
  const last = closes[closes.length - 1]!;
  const prior = closes[closes.length - 1 - back]!;
  return prior === 0 ? null : (last - prior) / prior;
}

function standardDeviation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function populationStdev(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Wilder RSI on the last `period + 1` closes. Returns `null` if there aren't
 * enough completed bars, or if the input contains a run of identical closes
 * that would produce a divide-by-zero.
 */
function computeRsi14(closes: number[], period = 14): number | null {
  if (closes.length <= period) return null;
  const window = closes.slice(-period - 1);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < window.length; i++) {
    const diff = window[i]! - window[i - 1]!;
    if (diff >= 0) gain += diff; else loss -= diff;
  }
  gain /= period;
  loss /= period;
  if (loss === 0) return gain === 0 ? null : 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

/**
 * 20-period 2-sigma Bollinger geometry plus the bank-break streak. Reports
 * the extension in ATR units so it's directly comparable across pairs.
 */
function computeBollinger(
  closes: number[],
  atrValue: number | null,
  period = 20,
  numStdev = 2,
): { middle: number; upper: number; lower: number; pctB: number; extAtr: number; dir: -1 | 0 | 1; streak: number } | null {
  if (closes.length < period || atrValue === null || atrValue <= 0) return null;
  // Streak lookback: the max useful streak is bounded by (closes.length - period).
  const window = closes.slice(-period);
  const middle = window.reduce((s, v) => s + v, 0) / window.length;
  const sd = populationStdev(window);
  const upper = middle + numStdev * sd;
  const lower = middle - numStdev * sd;
  const price = closes[closes.length - 1]!;
  const range = upper - lower;
  const pctB = range > 0 ? (price - lower) / range : 0.5;
  let dir: -1 | 0 | 1 = 0;
  let extAtr = 0;
  if (price > upper) { dir = 1; extAtr = (price - upper) / atrValue; }
  else if (price < lower) { dir = -1; extAtr = (lower - price) / atrValue; }
  let streak = 0;
  if (dir !== 0) {
    // Walk backwards computing the rolling 20-period band at each historic bar.
    // Sums of price and price^2 let us slide the window without recomputing.
    let sum = window.reduce((s, v) => s + v, 0);
    let sumSq = window.reduce((s, v) => s + v * v, 0);
    for (let i = closes.length - 1; i >= period - 1; i--) {
      const p = closes[i]!;
      const mean = sum / period;
      const varPop = Math.max(0, sumSq / period - mean * mean);
      const s = Math.sqrt(varPop);
      const up = mean + numStdev * s;
      const lo = mean - numStdev * s;
      const outsideOnDirSide = dir === 1 ? p > up : p < lo;
      if (!outsideOnDirSide) break;
      streak += 1;
      // slide the window one bar earlier
      const dropped = closes[i]!;
      const added = closes[i - period];
      if (added === undefined) break;
      sum = sum - dropped + added;
      sumSq = sumSq - dropped * dropped + added * added;
    }
  }
  return { middle, upper, lower, pctB, extAtr, dir, streak };
}

function timeOfDayBucketFor(hourEt: number) {
  const start = Math.floor(hourEt / 4) * 4;
  const end = start + 4;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(start)}-${pad(end)} ET`;
}

function hourInNewYork(at: Date) {
  const value = new Intl.DateTimeFormat("en-US", { timeZone: NEW_YORK_TIME_ZONE, hour: "2-digit", hourCycle: "h23" }).format(at);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Everything the model is allowed to see at prediction time. Computed only from
 * COMPLETED candles at or before `now` and the current quote, so it can never
 * leak information from after the prediction was made.
 */
export function computeBinaryFeatures(
  instrument: string,
  completedCandles: BinaryCandle[],
  quote: BinaryQuote | null,
  now: Date,
): BinaryFeatures | null {
  if (completedCandles.length < MIN_FEATURE_CANDLES) return null;
  const pip = pipSizeFor(instrument);
  const closes = completedCandles.map((candle) => candle.close);
  const last = completedCandles[completedCandles.length - 1]!;

  const emaFast = calculateEmaValues(closes, 9).at(-1) ?? null;
  const emaSlow = calculateEmaValues(closes, 21).at(-1) ?? null;
  const trend: BinaryFeatures["trend"] = emaFast !== null && emaSlow !== null
    ? emaFast > emaSlow ? "up" : emaFast < emaSlow ? "down" : "flat"
    : "flat";

  const atrValue = calculateAtrValues(completedCandles as unknown as Candle[], 14).at(-1) ?? null;
  const atrPips = atrValue === null ? null : atrValue / pip;

  const recentReturns: number[] = [];
  for (let index = Math.max(1, closes.length - 15); index < closes.length; index += 1) {
    recentReturns.push(pipsBetween(closes[index]!, closes[index - 1]!, pip));
  }
  const volatilityPips = standardDeviation(recentReturns);

  const range = last.high - last.low;
  const candle = range > 0
    ? {
        bodyPips: Math.abs(last.close - last.open) / pip,
        upperWickPips: (last.high - Math.max(last.open, last.close)) / pip,
        lowerWickPips: (Math.min(last.open, last.close) - last.low) / pip,
        bodyRatio: Math.abs(last.close - last.open) / range,
      }
    : null;

  const window = completedCandles.slice(-15);
  const recentHigh = Math.max(...window.map((c) => c.high));
  const recentLow = Math.min(...window.map((c) => c.low));
  const mid = quote?.mid ?? last.close;

  const hourEt = hourInNewYork(now);
  const rsi14 = computeRsi14(closes, 14);
  const bollinger = computeBollinger(closes, atrValue, 20, 2);
  return {
    momentumPips: {
      m1: momentumOver(closes, 1, pip),
      m5: momentumOver(closes, 5, pip),
      m10: momentumOver(closes, 10, pip),
      m15: momentumOver(closes, 15, pip),
    },
    returnPct: {
      m1: returnOver(closes, 1),
      m5: returnOver(closes, 5),
      m10: returnOver(closes, 10),
      m15: returnOver(closes, 15),
    },
    trend,
    emaFast,
    emaSlow,
    atrPips,
    volatilityPips,
    candle,
    distanceFromHighPips: pipsBetween(recentHigh, mid, pip),
    distanceFromLowPips: pipsBetween(mid, recentLow, pip),
    spreadPips: quote ? pipsBetween(quote.ask, quote.bid, pip) : null,
    session: getForexSessionStatus(now).label,
    hourEt,
    timeOfDayBucket: timeOfDayBucketFor(hourEt),
    rsi14,
    bollinger,
    instrument,
    referenceClose: last.close,
    referenceCloseTime: last.time,
  };
}

export type BinaryDecision = { direction: "up" | "down" | "wait"; score: number; rationale: string };

export interface BinaryModel {
  name: string;
  version: string;
  scoreKind: "heuristic_score" | "probability";
  threshold: number;
  evaluate(features: BinaryFeatures): BinaryDecision;
}

/**
 * binary-baseline-v1: a deterministic momentum-and-trend heuristic. Retired
 * from live production in favour of binary-fade-v1; kept exported so research
 * scripts can reproduce the historical prediction stream. NOT authoritative.
 */
export function createBaselineModel(threshold = BINARY_DEFAULT_THRESHOLD): BinaryModel {
  const SCALE = 1.5; // momentum, in ATRs over the window, that approaches full strength
  return {
    name: BINARY_LEGACY_BASELINE_NAME,
    version: BINARY_LEGACY_BASELINE_VERSION,
    scoreKind: "heuristic_score",
    threshold,
    evaluate(features) {
      const m5 = features.momentumPips.m5;
      const m15 = features.momentumPips.m15;
      const atr = features.atrPips;
      if (m5 === null || m15 === null || atr === null || atr <= 0) {
        return { direction: "wait", score: 0.5, rationale: "Insufficient data for a momentum reading." };
      }
      // Momentum normalised by volatility, so a 3-pip move on a calm pair and a
      // 3-pip move on a wild one are not treated as equal evidence.
      const signal = (0.6 * m5 + 0.4 * m15) / atr;
      let strength = Math.min(Math.abs(signal) / SCALE, 1);
      const direction: "up" | "down" = signal >= 0 ? "up" : "down";
      const trendAgrees = (direction === "up" && features.trend === "up") || (direction === "down" && features.trend === "down");
      // A signal fighting the short-term trend is discounted, not flipped.
      if (features.trend !== "flat" && !trendAgrees) strength *= 0.6;
      const score = 0.5 + 0.45 * strength;
      if (score < this.threshold) {
        return { direction: "wait", score, rationale: `Score ${score.toFixed(3)} below threshold ${this.threshold}.` };
      }
      return {
        direction,
        score,
        rationale: `${direction === "up" ? "Upward" : "Downward"} momentum ${signal.toFixed(2)} ATR${trendAgrees ? ", trend-aligned" : ""}.`,
      };
    },
  };
}

function roundToPrecision(value: number, precision: number) {
  return Number(value.toFixed(precision));
}

/** True when entry and expiration price are equal within the instrument's tie band. */
export function isBinaryTie(entry: number, resolution: number, precision: number, toleranceTicks = BINARY_TIE_TOLERANCE_TICKS) {
  const tolerance = toleranceTicks * 10 ** -precision;
  return Math.abs(roundToPrecision(resolution, precision) - roundToPrecision(entry, precision)) <= tolerance;
}

/**
 * The resolution rule. Ties are never silently folded into a win or a loss.
 *   UP  won when expiration price > entry, lost when < entry.
 *   DOWN won when expiration price < entry, lost when > entry.
 */
export function classifyBinaryResult(
  direction: "up" | "down",
  entry: number,
  resolution: number,
  precision: number,
  toleranceTicks = BINARY_TIE_TOLERANCE_TICKS,
): "won" | "lost" | "tie" {
  if (isBinaryTie(entry, resolution, precision, toleranceTicks)) return "tie";
  const higher = roundToPrecision(resolution, precision) > roundToPrecision(entry, precision);
  if (direction === "up") return higher ? "won" : "lost";
  return higher ? "lost" : "won";
}

/** Close time of an M1 candle whose OANDA `time` is its open time. */
function candleCloseTime(candle: BinaryCandle) {
  return new Date(new Date(candle.time).getTime() + 60_000);
}

/**
 * The earliest reliable price at or after a target instant, from completed M1
 * candles. This is what makes resolution durable: if the app was down at the
 * exact expiration, the first completed candle at or after it is used, and its
 * real timestamp is returned so nothing is passed off as the exact mark.
 */
export function resolutionPriceAtOrAfter(
  completedCandles: BinaryCandle[],
  target: Date,
): { price: number; time: string } | null {
  for (const candle of completedCandles) {
    const close = candleCloseTime(candle);
    if (close.getTime() >= target.getTime()) {
      return { price: candle.close, time: close.toISOString() };
    }
  }
  return null;
}

/** Secondary research horizons priced from the same candles, without touching the official result. */
export function computeSecondaryMarks(
  direction: "up" | "down",
  entry: number,
  precision: number,
  startAt: Date,
  completedCandles: BinaryCandle[],
  horizons: readonly number[] = BINARY_SECONDARY_HORIZONS,
) {
  const marks: Record<string, { price: number; priceTime: string; result: "won" | "lost" | "tie" }> = {};
  for (const seconds of horizons) {
    const target = new Date(startAt.getTime() + seconds * 1000);
    const mark = resolutionPriceAtOrAfter(completedCandles, target);
    if (!mark) continue;
    marks[`${seconds}s`] = {
      price: mark.price,
      priceTime: mark.time,
      result: classifyBinaryResult(direction, entry, mark.price, precision),
    };
  }
  return marks;
}

export type SecondaryMark = { price: number; priceTime: string; result: "won" | "lost" | "tie" };

/**
 * Combines already-recorded secondary marks with freshly computed ones, with the
 * EXISTING marks winning. A mark written at resolution (the 5m) is therefore
 * never altered by a later back-fill; the back-fill only adds horizons that had
 * not elapsed yet when the prediction resolved (the 15m).
 */
export function mergeSecondaryMarks(
  existing: Record<string, unknown> | null | undefined,
  fresh: Record<string, SecondaryMark>,
): Record<string, unknown> {
  return { ...fresh, ...(existing ?? {}) };
}

// ---------------------------------------------------------------------------
// Statistics (pure; computed from stored rows, never claiming significance).
// ---------------------------------------------------------------------------

export type BinaryStatRow = {
  instrument: string;
  direction: "up" | "down";
  status: string;
  result: "won" | "lost" | "tie" | null;
  confidence: number | string;
  session: string | null;
  model_version: string;
  start_at: string | Date;
};

export function binaryStats(rows: BinaryStatRow[]) {
  const resolved = rows.filter((row) => row.status === "resolved" && row.result !== null);
  const won = resolved.filter((row) => row.result === "won").length;
  const lost = resolved.filter((row) => row.result === "lost").length;
  const tie = resolved.filter((row) => row.result === "tie").length;
  const decided = won + lost;
  return {
    total: rows.length,
    active: rows.filter((row) => row.status === "active").length,
    resolved: resolved.length,
    won,
    lost,
    tie,
    // Wins over decided predictions (ties excluded from the denominator), as a
    // fraction. Null until at least one prediction has decided a direction.
    winRate: decided > 0 ? won / decided : null,
    // Enough resolved to look at, not a significance claim — the UI shows counts.
    evidenceEligible: resolved.length >= 30,
  };
}

function scoreBucket(confidence: number) {
  if (!Number.isFinite(confidence)) return "unknown";
  const lower = Math.floor(confidence / 0.05) * 0.05;
  const upper = lower + 0.05;
  return `${lower.toFixed(2)}-${upper.toFixed(2)}`;
}

export function binaryBreakdown(rows: BinaryStatRow[], keyFor: (row: BinaryStatRow) => string) {
  const groups = new Map<string, BinaryStatRow[]>();
  for (const row of rows) {
    const key = keyFor(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()]
    .map(([group, groupRows]) => ({ group, ...binaryStats(groupRows) }))
    .sort((a, b) => b.resolved - a.resolved || a.group.localeCompare(b.group));
}

export function binaryPerformanceBreakdowns(rows: BinaryStatRow[]) {
  return {
    symbol: binaryBreakdown(rows, (row) => row.instrument),
    direction: binaryBreakdown(rows, (row) => row.direction),
    session: binaryBreakdown(rows, (row) => row.session ?? "Unknown"),
    timeOfDay: binaryBreakdown(rows, (row) => timeOfDayBucketFor(hourInNewYork(new Date(row.start_at)))),
    score: binaryBreakdown(rows, (row) => scoreBucket(Number(row.confidence))),
    model: binaryBreakdown(rows, (row) => row.model_version),
  };
}

/** The three horizons compared side by side, labelled for the UI. */
export const BINARY_HORIZON_LABELS: Record<number, string> = { 300: "5m", 600: "10m", 900: "15m" };
const BINARY_REPORTED_HORIZONS = [300, 600, 900] as const;

export type HorizonResultRow = {
  status: string;
  /** Official result at the prediction's own horizon (duration_seconds). */
  result: "won" | "lost" | "tie" | null;
  durationSeconds: number;
  /** Prices/results captured at the other horizons, keyed like "300s"/"900s". */
  secondaryMarks: Record<string, { result?: "won" | "lost" | "tie" }> | null;
};

/**
 * Win rate at 5m / 10m / 15m over the SAME resolved predictions, so the horizons
 * can be compared like-for-like. Each prediction's official result counts at its
 * own horizon; the other horizons come from the secondary marks recorded at
 * resolution. `missing` counts predictions whose data at a horizon was never
 * captured (e.g. an M1 gap), so a horizon's win rate is never silently inflated
 * by a smaller, different sample. Win rate excludes ties from the denominator.
 */
export function binaryHorizonBreakdown(rows: HorizonResultRow[]) {
  return BINARY_REPORTED_HORIZONS.map((seconds) => {
    let won = 0;
    let lost = 0;
    let tie = 0;
    let missing = 0;
    for (const row of rows) {
      if (row.status !== "resolved") continue;
      const result = seconds === row.durationSeconds ? row.result : row.secondaryMarks?.[`${seconds}s`]?.result ?? null;
      if (result === "won") won += 1;
      else if (result === "lost") lost += 1;
      else if (result === "tie") tie += 1;
      else missing += 1;
    }
    const decided = won + lost;
    return {
      horizonSeconds: seconds,
      label: BINARY_HORIZON_LABELS[seconds] ?? `${seconds}s`,
      resolved: won + lost + tie,
      won,
      lost,
      tie,
      missing,
      winRate: decided > 0 ? won / decided : null,
      evidenceEligible: won + lost + tie >= 30,
    };
  });
}

// ---------------------------------------------------------------------------
// IO layer: model registration, evaluation/opening, durable resolution, reads.
// ---------------------------------------------------------------------------

function toBinaryCandles(candles: Awaited<ReturnType<typeof getResearchCandles>>): BinaryCandle[] {
  return candles.map((candle) => ({
    time: candle.time,
    open: candle.mid.open,
    high: candle.mid.high,
    low: candle.mid.low,
    close: candle.mid.close,
    volume: candle.volume,
    complete: candle.complete,
  }));
}

async function ownerUserId(): Promise<string | null> {
  const owner = await query<{ id: string }>("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1");
  return owner.rows[0]?.id ?? null;
}

/** Shadow logistic model row; registered alongside baseline when shadow collection is enabled. */
async function ensureLogisticModel(): Promise<{ id: string; name: string; version: string }> {
  const configuration = JSON.stringify({
    kind: "logistic_regression",
    horizonSeconds: BINARY_HORIZON_SECONDS,
    scoreKind: "probability",
    artifact: "src/data/binary-logistic-v1.json",
    note: "Shadow-only L2 logistic regression. Not used for trading or model selection in Phase 1.",
  });
  const result = await query<{ id: string; name: string; version: string }>(
    `INSERT INTO binary_models(name,version,score_kind,configuration) VALUES($1,$2,'probability',$3::jsonb)
     ON CONFLICT(name,version) DO UPDATE SET configuration=EXCLUDED.configuration
     RETURNING id,name,version`,
    [BINARY_LOGISTIC_MODEL_NAME, BINARY_LOGISTIC_MODEL_VERSION, configuration],
  );
  return result.rows[0]!;
}

/**
 * The current authoritative model's row, created on first use so a version
 * bump is code-only. Registers binary-fade-v1 alongside a hard-coded copy of
 * its configuration for provenance.
 */
async function ensureBinaryModel(): Promise<{ id: string; name: string; version: string }> {
  const configuration = JSON.stringify({
    kind: "bollinger-band-fade",
    scoreKind: "heuristic_score",
    ...BINARY_FADE_CONFIGURATION,
  });
  const result = await query<{ id: string; name: string; version: string }>(
    `INSERT INTO binary_models(name,version,score_kind,configuration) VALUES($1,$2,'heuristic_score',$3::jsonb)
     ON CONFLICT(name,version) DO UPDATE SET configuration=EXCLUDED.configuration
     RETURNING id,name,version`,
    [BINARY_MODEL_NAME, BINARY_MODEL_VERSION, configuration],
  );
  return result.rows[0]!;
}

async function persistBinaryWatchSnapshot(
  instrument: string,
  model: { name: string; version: string },
  evaluatedAt: Date,
  dataStatus: "connected" | "unavailable" | "stale",
  decision: BinaryDecision | null,
  quote: BinaryQuote | null,
  features: BinaryFeatures | null,
) {
  const active = await query<{ id: string }>(
    "SELECT id FROM binary_predictions WHERE instrument=$1 AND status='active' AND is_authoritative=true ORDER BY created_at DESC LIMIT 1",
    [instrument],
  );
  const spreadPips = quote ? (quote.ask - quote.bid) / pipSizeFor(instrument) : null;
  await query(
    `INSERT INTO binary_watch_snapshots(instrument,model_name,model_version,evaluated_at,data_status,bias,score,score_kind,bid,ask,spread_pips,session,active_prediction_id,features)
     VALUES($1,$2,$3,$4,$5,$6,$7,'heuristic_score',$8,$9,$10,$11,$12,$13::jsonb)
     ON CONFLICT(instrument) DO UPDATE SET model_name=EXCLUDED.model_name,model_version=EXCLUDED.model_version,evaluated_at=EXCLUDED.evaluated_at,data_status=EXCLUDED.data_status,bias=EXCLUDED.bias,score=EXCLUDED.score,bid=EXCLUDED.bid,ask=EXCLUDED.ask,spread_pips=EXCLUDED.spread_pips,session=EXCLUDED.session,active_prediction_id=EXCLUDED.active_prediction_id,features=EXCLUDED.features,updated_at=now()`,
    [
      instrument,
      model.name,
      model.version,
      evaluatedAt.toISOString(),
      dataStatus,
      decision ? decision.direction : null,
      decision ? decision.score : null,
      quote?.bid ?? null,
      quote?.ask ?? null,
      spreadPips,
      getForexSessionStatus(evaluatedAt).label,
      active.rows[0]?.id ?? null,
      JSON.stringify(features ?? {}),
    ],
  );
}

type OpenBinaryPredictionOptions = {
  opportunityId?: string;
  isShadow?: boolean;
  isAuthoritative?: boolean;
  scoreKind?: "heuristic_score" | "probability";
  inferenceContext?: Record<string, unknown>;
};

async function openBinaryPrediction(
  userId: string,
  model: { id: string; name: string; version: string },
  instrument: string,
  quote: BinaryQuote,
  features: BinaryFeatures,
  decision: BinaryDecision,
  now: Date,
  durationSeconds = BINARY_HORIZON_SECONDS,
  options: OpenBinaryPredictionOptions = {},
): Promise<{ id: string; opportunityId: string } | null> {
  if (decision.direction === "wait") return null;
  const precision = precisionFor(instrument);
  const intendedExpiration = new Date(now.getTime() + durationSeconds * 1000);
  const opportunityId = options.opportunityId ?? randomUUID();
  const isShadow = options.isShadow ?? false;
  const isAuthoritative = options.isAuthoritative ?? !isShadow;
  const scoreKind = options.scoreKind ?? "heuristic_score";
  const marketContext = {
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    spreadPips: features.spreadPips,
    session: features.session,
    hourEt: features.hourEt,
    dataSource: "oanda",
    referenceCloseTime: features.referenceCloseTime,
    referenceClose: features.referenceClose,
  };
  return transaction(async (client) => {
    // Serialises openers so the "one active per (instrument, duration, model)" check and
    // the insert are atomic; the partial unique index is the backstop.
    await client.query("SELECT pg_advisory_xact_lock($1)", [BINARY_LOCK]);
    const existing = await client.query(
      "SELECT 1 FROM binary_predictions WHERE instrument=$1 AND duration_seconds=$2 AND model_name=$3 AND status='active'",
      [instrument, durationSeconds, model.name],
    );
    if (existing.rowCount) return null;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO binary_predictions(user_id,model_id,model_name,model_version,instrument,direction,start_at,entry_price,duration_seconds,intended_expiration,price_precision,tie_tolerance,confidence,score_kind,features,market_context,opportunity_id,is_shadow,is_authoritative,inference_context)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18,$19,$20::jsonb)
       RETURNING id`,
      [
        userId,
        model.id,
        model.name,
        model.version,
        instrument,
        decision.direction,
        now.toISOString(),
        quote.mid,
        durationSeconds,
        intendedExpiration.toISOString(),
        precision,
        BINARY_TIE_TOLERANCE_TICKS * 10 ** -precision,
        decision.score,
        scoreKind,
        JSON.stringify(features),
        JSON.stringify(marketContext),
        opportunityId,
        isShadow,
        isAuthoritative,
        JSON.stringify(options.inferenceContext ?? {}),
      ],
    );
    const id = inserted.rows[0]?.id;
    return id ? { id, opportunityId } : null;
  });
}

function logBinaryShadow(event: "generated" | "skipped" | "resolved" | "error", fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event: `binary.shadow.${event}`, model: BINARY_LOGISTIC_MODEL_NAME, ...fields }));
}

async function openShadowLogisticPrediction(
  userId: string,
  opportunityId: string,
  model: { id: string; name: string; version: string },
  instrument: string,
  quote: BinaryQuote,
  features: BinaryFeatures,
  now: Date,
  options: { isAuthoritative?: boolean; isShadow?: boolean } = {},
  durationSeconds = BINARY_HORIZON_SECONDS,
): Promise<string | null> {
  const logistic = createBinaryLogisticModel();
  const inference: BinaryLogisticResult = logistic.evaluate(features);
  if ("skipReason" in inference) {
    logBinaryShadow("skipped", { symbol: instrument, opportunityId, reason: inference.skipReason });
    return null;
  }
  const decision = binaryLogisticDecision(inference);
  const isAuthoritative = options.isAuthoritative ?? false;
  const isShadow = options.isShadow ?? !isAuthoritative;
  const opened = await openBinaryPrediction(userId, model, instrument, quote, features, decision, now, durationSeconds, {
    opportunityId,
    isShadow,
    isAuthoritative,
    scoreKind: "probability",
    inferenceContext: {
      rawProbabilityUp: inference.rawProbabilityUp,
      modelArtifactVersion: logistic.artifact.version,
      coefficientVersion: logistic.artifact.version,
    },
  });
  if (!opened) {
    logBinaryShadow("skipped", { symbol: instrument, opportunityId, reason: "An active shadow prediction already exists for this symbol and horizon." });
    return null;
  }
  logBinaryShadow("generated", {
    symbol: instrument,
    opportunityId,
    direction: decision.direction,
    probability: inference.rawProbabilityUp,
    confidence: decision.score,
    predictionId: opened.id,
    isAuthoritative,
  });
  return opened.id;
}

type DuePredictionRow = {
  id: string;
  instrument: string;
  direction: "up" | "down";
  entry_price: string;
  start_at: string;
  intended_expiration: string;
  duration_seconds: number;
  price_precision: number;
  tie_tolerance: string;
  model_name: string;
};

/**
 * Resolves every prediction whose intended expiration has passed and for which a
 * reliable price at or after that instant exists. Durable and idempotent:
 *
 *  - Durable: it re-scans all active-and-overdue rows every cycle, so a
 *    prediction that expired while the app was down is picked up on restart.
 *  - Idempotent: the UPDATE is guarded by `status='active'`, so a second run (or
 *    two overlapping runs) can never re-resolve a row or record it twice.
 *
 * The preferred price is a verified live OANDA tick observed just after the
 * intended expiration. If that short window is missed (for example after a
 * restart), the first completed M1 candle at or after expiration is used.
 * The actual source and timestamp are both stored for auditability.
 */
export async function resolveDueBinaryPredictions(): Promise<number> {
  const due = await query<DuePredictionRow>(
    `SELECT id,instrument,direction,entry_price,start_at,intended_expiration,duration_seconds,price_precision,tie_tolerance,model_name
     FROM binary_predictions WHERE status='active' AND intended_expiration <= now()
     ORDER BY intended_expiration`,
  );
  if (!due.rows.length) return 0;

  // Fetch all due instruments together. Only a connected OANDA response can
  // settle a prediction; getPricing deliberately falls back to mock quotes on
  // errors, which must never decide a real recorded outcome.
  const dueInstruments = [...new Set(due.rows.map((prediction) => prediction.instrument as MajorInstrument))];
  const livePrices = new Map<string, { price: number; time: string }>();
  try {
    const pricing = await getPricing(dueInstruments);
    if (pricing.status.state === "connected" && pricing.status.source === "oanda") {
      for (const quote of pricing.data) {
        const observedAt = new Date(quote.time);
        if (Number.isFinite(quote.mid) && !Number.isNaN(observedAt.getTime())) {
          livePrices.set(quote.instrument, { price: quote.mid, time: observedAt.toISOString() });
        }
      }
    }
  } catch (error) {
    // Historical candles below remain the durable fallback. Do not let one
    // transient quote request block resolution for every overdue prediction.
    console.warn("[binary] live resolution quote unavailable", error);
  }

  let resolved = 0;
  for (const prediction of due.rows) {
    const startAt = new Date(prediction.start_at);
    const intended = new Date(prediction.intended_expiration);

    // A prediction whose intended expiration fell while the market was closed
    // (the Friday 17:00 ET weekly close is the only such gap) has no
    // contemporaneous settlement price. Void it — status 'error', no result —
    // rather than record a meaningless weekend-gap win or loss. The status guard
    // keeps this idempotent, and the immutability trigger permits it because no
    // result is ever set.
    if (binaryExpiredWhileClosed(intended)) {
      const voided = await query<{ id: string }>(
        `UPDATE binary_predictions
         SET status='error',error_reason=$2,resolved_at=now(),updated_at=now()
         WHERE id=$1 AND status='active' RETURNING id`,
        [prediction.id, "Market was closed at the intended expiration (weekly close/gap); no valid settlement price, so the prediction was voided."],
      );
      if (voided.rowCount) resolved += 1;
      continue;
    }

    const liveMark = livePrices.get(prediction.instrument);
    const liveMarkTime = liveMark ? new Date(liveMark.time) : null;
    const canUseLiveMark = Boolean(
      liveMarkTime
      && liveMarkTime.getTime() >= intended.getTime()
      && liveMarkTime.getTime() - intended.getTime() <= LIVE_RESOLUTION_GRACE_MS,
    );

    // Enough M1 candles to cover start → now even after a long downtime.
    const minutesSinceStart = Math.floor((Date.now() - startAt.getTime()) / 60_000);
    const count = Math.min(1500, Math.max(60, minutesSinceStart + 30));
    let completed: BinaryCandle[] = [];
    try {
      completed = toBinaryCandles(await getResearchCandles(prediction.instrument, "M1", count)).filter((candle) => candle.complete);
    } catch (error) {
      if (!(error instanceof OandaRequestError)) throw error;
      // A fresh, verified live mark is enough to settle. Candle history only
      // enriches secondary research marks in that case; it must not turn a
      // decisive live outcome back into an indefinite "resolving" state.
      if (!canUseLiveMark) continue;
    }
    const candleMark = resolutionPriceAtOrAfter(completed, intended);
    const mark = canUseLiveMark && liveMark && liveMarkTime
      ? { price: liveMark.price, time: liveMarkTime.toISOString(), source: "live_tick" as const }
      : candleMark
        ? { ...candleMark, source: "m1_candle" as const }
        : null;
    if (!mark) continue; // No candle at/after expiration yet — try again next cycle.

    const entry = Number(prediction.entry_price);
    const precision = Number(prediction.price_precision);
    const toleranceTicks = precision > 0 ? Math.round(Number(prediction.tie_tolerance) / 10 ** -precision) : 0;
    const result = classifyBinaryResult(prediction.direction, entry, mark.price, precision, toleranceTicks);
    const secondary = computeSecondaryMarks(prediction.direction, entry, precision, startAt, completed);

    const updated = await query<{ id: string }>(
      `UPDATE binary_predictions
       SET status='resolved',resolution_price=$2,resolution_price_time=$3,resolution_source=$4,resolved_at=now(),result=$5,secondary_marks=$6::jsonb,updated_at=now()
       WHERE id=$1 AND status='active'
       RETURNING id`,
      [prediction.id, mark.price, mark.time, mark.source, result, JSON.stringify(secondary)],
    );
    if (updated.rowCount) {
      resolved += 1;
      if (prediction.model_name === BINARY_LOGISTIC_MODEL_NAME) {
        logBinaryShadow("resolved", {
          symbol: prediction.instrument,
          predictionId: prediction.id,
          direction: prediction.direction,
          result,
          resolutionPrice: mark.price,
        });
      }
    }
  }
  return resolved;
}

type BackfillRow = {
  id: string;
  instrument: string;
  direction: "up" | "down";
  entry_price: string;
  start_at: string;
  price_precision: number;
  secondary_marks: Record<string, unknown> | null;
};

/**
 * Fills in secondary research horizons that could not be priced at resolution
 * because they had not elapsed yet. The 15m mark on a 10m prediction is the
 * motivating case: the prediction settles at 10m, so its 15m price only exists
 * five minutes later. Once that time has passed, this back-fills the missing mark
 * from historical candles.
 *
 * It writes ONLY secondary_marks, and existing marks are preserved (the earlier
 * 5m mark is never touched). The immutability trigger forbids changing direction,
 * entry, start, expiration or the decided result — so the official outcome is
 * untouched and this only completes the research picture. Bounded to recent rows
 * so a permanently un-gettable horizon (e.g. a weekend gap) is not retried
 * forever.
 */
export async function backfillBinarySecondaryMarks(limit = 50): Promise<number> {
  const horizons = [...BINARY_SECONDARY_HORIZONS];
  const maxHorizon = Math.max(...horizons); // internal constant; safe to inline in SQL
  const due = await query<BackfillRow>(
    `SELECT id,instrument,direction,entry_price,start_at,price_precision,secondary_marks
     FROM binary_predictions
     WHERE status='resolved'
       AND start_at <= now() - make_interval(secs => ${maxHorizon})
       AND start_at >= now() - interval '3 days'
       AND NOT jsonb_exists(secondary_marks, '${maxHorizon}s')
     ORDER BY resolved_at DESC NULLS LAST
     LIMIT $1`,
    [Math.min(200, Math.max(1, limit))],
  );
  let filled = 0;
  for (const row of due.rows) {
    const startAt = new Date(row.start_at);
    // A tight M1 window ending just past the last horizon, so the prediction's
    // age never inflates the candle count.
    const to = new Date(startAt.getTime() + (maxHorizon + 300) * 1000).toISOString();
    let completed: BinaryCandle[];
    try {
      completed = toBinaryCandles(await getResearchCandles(row.instrument, "M1", 60, { to })).filter((candle) => candle.complete);
    } catch (error) {
      if (!(error instanceof OandaRequestError)) throw error;
      continue;
    }
    const precision = Number(row.price_precision);
    const fresh = computeSecondaryMarks(row.direction, Number(row.entry_price), precision, startAt, completed, horizons);
    const existing = row.secondary_marks ?? {};
    const merged = mergeSecondaryMarks(existing, fresh);
    if (Object.keys(merged).length <= Object.keys(existing).length) continue; // nothing new to add yet
    await query(
      "UPDATE binary_predictions SET secondary_marks=$2::jsonb,updated_at=now() WHERE id=$1 AND status='resolved'",
      [row.id, JSON.stringify(merged)],
    );
    filled += 1;
  }
  return filled;
}

/**
 * Whether the engine may OPEN new predictions right now: only while a major
 * session — London or New York, including their overlap — is trading. This
 * deliberately excludes the Asian/off-hours between the New York close and the
 * London open, when these pairs are thin and directional. Resolution and
 * back-fill are NOT gated by this — a prediction opened near the New York close
 * still settles normally.
 */
export function isBinaryOpeningSession(now = new Date()): boolean {
  const status = getForexSessionStatus(now);
  return status.marketOpen && status.entrySession !== null;
}

/**
 * Whether a prediction opened now can both start in a session AND expire while
 * the market is still open, so it can actually resolve. This is what stops a
 * prediction being opened in the last ~10 minutes before the Friday 17:00 ET
 * weekly close, where it would otherwise sit unresolved — showing ACTIVE — until
 * the Sunday reopen and then settle at a meaningless weekend-gap price.
 */
export function canOpenBinaryPrediction(now = new Date(), durationSeconds = BINARY_HORIZON_SECONDS): boolean {
  if (!isBinaryOpeningSession(now)) return false;
  const expiresAt = new Date(now.getTime() + durationSeconds * 1000);
  return getForexSessionStatus(expiresAt).marketOpen;
}

/**
 * True when a prediction's intended expiration fell while the forex market was
 * closed (the weekend). Such a prediction has no contemporaneous settlement
 * price, so the resolver voids it instead of settling it on a weekend-gap price.
 */
export function binaryExpiredWhileClosed(intendedExpiration: string | Date): boolean {
  return !getForexSessionStatus(new Date(intendedExpiration)).marketOpen;
}

/**
 * One evaluation pass: resolve anything due, then (while a major session is
 * trading) take a fresh market read for each symbol, refresh its watchlist bias,
 * and open a new 10-minute prediction where the model has a signal and the symbol
 * has none active.
 */
export async function collectBinaryCycle(): Promise<{ opened: number; resolved: number; evaluated: number; reason?: string }> {
  let resolved = 0;
  try {
    resolved = await resolveDueBinaryPredictions();
  } catch (error) {
    console.error("[binary] resolution failed", error);
  }
  // Late research horizons (e.g. the 15m mark on a 10m prediction) are captured
  // once they have elapsed. Runs regardless of session — it depends on time
  // passing, not the market being open.
  try {
    const filled = await backfillBinarySecondaryMarks();
    if (filled) console.log(`[binary] back-filled ${filled} late secondary marks`);
  } catch (error) {
    console.error("[binary] secondary back-fill failed", error);
  }
  try {
    const selectorResolved = await resolveSelectorDecisions();
    if (selectorResolved) console.log(`[binary] resolved ${selectorResolved} selector decisions`);
  } catch (error) {
    console.error("[binary] selector resolution failed", error);
  }

  const userId = await ownerUserId();
  if (!userId) return { opened: 0, resolved, evaluated: 0, reason: "Owner account is unavailable" };
  const model = await ensureBinaryModel();
  // binary-fade-v1 is now authoritative. createBaselineModel remains exported
  // so research/replay scripts can reproduce the historical prediction stream.
  const engine = createFadeModel();
  const now = new Date();
  const session = getForexSessionStatus(now);
  if (!session.marketOpen) return { opened: 0, resolved, evaluated: 0, reason: "Forex market closed" };
  // Evaluate and open only during the London and New York sessions. Outside them
  // the engine opens nothing new; the durable resolver and the back-fill above
  // keep settling and completing predictions that are already live.
  if (session.entrySession === null) return { opened: 0, resolved, evaluated: 0, reason: "Outside London/New York sessions" };
  // A prediction must be able to finish before the market closes. Near the Friday
  // 17:00 ET weekly close, the 10-minute horizon would run past it and strand the
  // prediction as ACTIVE until Sunday, so stop opening once the horizon no longer
  // clears the close.
  const horizonClearsMarket = getForexSessionStatus(new Date(now.getTime() + BINARY_HORIZON_SECONDS * 1000)).marketOpen;

  const pricing = await getPricing([...MAJOR_INSTRUMENTS]);
  const quoteByInstrument = new Map(pricing.data.map((quote) => [quote.instrument, quote]));
  const pricingLive = pricing.status.state === "connected" && pricing.status.source === "oanda";

  let opened = 0;
  let evaluated = 0;
  const shadowEnabled = isBinaryLogisticShadowEnabled();
  const selectorEnabled = isBinaryAdaptiveSelectorEnabled();
  const liveSelectionEnabled = isBinaryAdaptiveLiveSelectionEnabled();
  let logisticModel: { id: string; name: string; version: string } | null = null;
  let pairedRows = null as Awaited<ReturnType<typeof loadAdaptivePredictionRows>> | null;
  if (shadowEnabled) {
    try {
      logisticModel = await ensureLogisticModel();
    } catch (error) {
      console.error("[binary] shadow model registration failed", error);
      logBinaryShadow("error", { reason: "model_registration_failed", error: String(error) });
    }
  }
  if (selectorEnabled && shadowEnabled) {
    try {
      pairedRows = await loadAdaptivePredictionRows();
    } catch (error) {
      console.error("[binary] adaptive stats load failed", error);
      logBinarySelector("error", { reason: "stats_load_failed", error: String(error) });
    }
  }

  for (const instrument of MAJOR_INSTRUMENTS) {
    const priceQuote = quoteByInstrument.get(instrument);
    const quote: BinaryQuote | null = priceQuote ? { bid: priceQuote.bid, ask: priceQuote.ask, mid: priceQuote.mid } : null;
    const quoteFresh = Boolean(priceQuote && Date.now() - new Date(priceQuote.time).getTime() <= 2 * 60_000);

    let features: BinaryFeatures | null = null;
    try {
      const candles = toBinaryCandles(await getResearchCandles(instrument, "M1", 80)).filter((candle) => candle.complete);
      features = computeBinaryFeatures(instrument, candles, quote, now);
    } catch (error) {
      if (!(error instanceof OandaRequestError)) throw error;
      features = null;
    }

    const dataStatus: "connected" | "unavailable" | "stale" =
      pricingLive && quoteFresh && features ? "connected" : "unavailable";
    const decision = features ? engine.evaluate(features) : null;
    await persistBinaryWatchSnapshot(instrument, model, now, dataStatus, decision, quote, features);
    evaluated += 1;

    // Fail closed: only a live, fresh read with computable features may open one,
    // and only when the 10-minute horizon still clears the market close.
    if (dataStatus !== "connected" || !decision || !features || !quote || decision.direction === "wait" || !horizonClearsMarket) continue;

    const opportunityId = randomUUID();
    let selectorDecision = null;
    if (selectorEnabled && pairedRows) {
      try {
        selectorDecision = selectBinaryModelForFeatures(
          features,
          instrument,
          decision.score,
          "heuristic_score",
          pairedRows,
          { liveSelectionEnabled: selectorEnabled && liveSelectionEnabled },
        );
        if (selectorDecision.state === "COLLECTING") {
          logBinarySelector("collecting", { symbol: instrument, opportunityId, pairedSamples: selectorDecision.pairedSamples, reason: selectorDecision.reason });
        } else if (selectorDecision.recommendationOnly) {
          logBinarySelector("recommendation", {
            symbol: instrument,
            opportunityId,
            state: selectorDecision.state,
            recommendedModel: selectorDecision.recommendedModel,
            authoritativeModel: selectorDecision.authoritativeModel,
            scope: selectorDecision.evidence.scope,
            sampleSize: selectorDecision.evidence.sampleSize,
            reason: selectorDecision.reason,
          });
        } else {
          logBinarySelector("active", {
            symbol: instrument,
            opportunityId,
            recommendedModel: selectorDecision.recommendedModel,
            authoritativeModel: selectorDecision.authoritativeModel,
            scope: selectorDecision.evidence.scope,
            sampleSize: selectorDecision.evidence.sampleSize,
          });
        }
        if (selectorDecision.fallbackUsed) {
          logBinarySelector("fallback", { symbol: instrument, opportunityId, reason: selectorDecision.reason });
        }
      } catch (error) {
        console.error("[binary] selector failed", error);
        logBinarySelector("error", { symbol: instrument, opportunityId, error: String(error) });
      }
    }

    const baselineAuthoritative = selectorDecision
      ? selectorDecision.authoritativeModel === BINARY_MODEL_NAME
      : true;
    const openedPrediction = await openBinaryPrediction(userId, model, instrument, quote, features, decision, now, BINARY_HORIZON_SECONDS, {
      opportunityId,
      isAuthoritative: baselineAuthoritative,
      isShadow: false,
    });
    if (!openedPrediction) continue;
    opened += 1;

    let logisticPredictionId: string | null = null;
    if (shadowEnabled && logisticModel) {
      try {
        const logisticAuthoritative = selectorDecision
          ? selectorDecision.authoritativeModel === BINARY_LOGISTIC_MODEL_NAME
          : false;
        logisticPredictionId = await openShadowLogisticPrediction(
          userId,
          openedPrediction.opportunityId,
          logisticModel,
          instrument,
          quote,
          features,
          now,
          { isAuthoritative: logisticAuthoritative, isShadow: !logisticAuthoritative },
        );
      } catch (error) {
        console.error("[binary] shadow prediction failed", error);
        logBinaryShadow("error", { symbol: instrument, opportunityId: openedPrediction.opportunityId, error: String(error) });
      }
    }

    if (selectorDecision && selectorEnabled) {
      try {
        await persistSelectorDecision(
          selectorDecision,
          openedPrediction.opportunityId,
          openedPrediction.id,
          logisticPredictionId,
        );
      } catch (error) {
        console.error("[binary] selector decision persist failed", error);
        logBinarySelector("error", { symbol: instrument, opportunityId: openedPrediction.opportunityId, error: String(error) });
      }
    }
  }

  return { opened, resolved, evaluated };
}

// ---------------------------------------------------------------------------
// Read models for the API endpoints.
// ---------------------------------------------------------------------------

const PREDICTION_SELECT = `
  id, prediction_sequence::text AS "sequence", instrument, direction, status,
  model_name AS "modelName", model_version AS "modelVersion",
  created_at AS "createdAt", start_at AS "startAt", entry_price::float AS "entryPrice",
  duration_seconds AS "durationSeconds", intended_expiration AS "intendedExpiration",
  resolution_price::float AS "resolutionPrice", resolution_price_time AS "resolutionPriceTime",
  resolution_source AS "resolutionSource", resolved_at AS "resolvedAt", result,
  confidence::float AS confidence, score_kind AS "scoreKind", price_precision AS "pricePrecision",
  strategy_source AS "strategySource", inference_context->>'branch' AS "patternBranch"`;

/**
 * The strategies a journal reader can ask for.
 *
 * Deliberately explicit rather than "everything authoritative": Pattern V1 is a
 * separate frozen experiment, and its rows must never be folded into a baseline
 * statistic by default.
 */
export type BinaryStrategyFilter = "all" | "baseline" | "pattern-v1";

export const BINARY_BASELINE_MODEL = "binary-baseline-v1";
export const BINARY_PATTERN_V1_MODEL = "binary-pattern-v1";

/** SQL scope for a strategy filter, as a model_name predicate. */
function strategyScope(strategy: BinaryStrategyFilter): string {
  if (strategy === "baseline") return `AND model_name='${BINARY_BASELINE_MODEL}'`;
  if (strategy === "pattern-v1") return `AND model_name='${BINARY_PATTERN_V1_MODEL}'`;
  // "all" spans the two real strategies but still excludes the logistic shadow,
  // which is a shadow OF baseline rather than a strategy in its own right.
  return `AND model_name IN ('${BINARY_BASELINE_MODEL}','${BINARY_PATTERN_V1_MODEL}')`;
}

/** Active predictions for the dashboard "Open binary position" section. Authoritative rows only. */
export async function recentBinaryPredictions(limit = 8) {
  const rows = await query(
    `SELECT ${PREDICTION_SELECT} FROM binary_predictions
     WHERE is_authoritative=true AND status='active'
     ORDER BY created_at DESC LIMIT $1`,
    [Math.min(50, Math.max(1, limit))],
  );
  return rows.rows;
}

/** Full prediction history for the Journal "Binary Predictions" tab. */
export type BinaryJournalFilter = "all" | "won" | "lost" | "tie" | "active";

export async function binaryJournal(
  userId: string,
  { limit = 20, offset = 0, filter = "all", strategy = "all" }:
    { limit?: number; offset?: number; filter?: BinaryJournalFilter; strategy?: BinaryStrategyFilter } = {},
) {
  const where =
    filter === "active" ? "AND status='active'"
    : filter === "won" ? "AND result='won'"
    : filter === "lost" ? "AND result='lost'"
    : filter === "tie" ? "AND result='tie'"
    : "";
  const rows = await query(
    // Scoped by model_name rather than is_authoritative so Pattern V1 — an
    // independent strategy that is deliberately NOT the authoritative baseline
    // signal — is visible here without being pulled into baseline statistics.
    `SELECT ${PREDICTION_SELECT} FROM binary_predictions WHERE user_id=$1 ${strategyScope(strategy)} ${where} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [userId, Math.min(50, Math.max(1, limit)), Math.max(0, offset)],
  );
  return rows.rows;
}

/** One prediction with its stored feature snapshot and market context. */
export async function binaryPredictionDetail(userId: string, id: string) {
  const rows = await query(
    `SELECT ${PREDICTION_SELECT}, features, market_context AS "marketContext", secondary_marks AS "secondaryMarks", error_reason AS "errorReason"
     FROM binary_predictions WHERE id=$1 AND user_id=$2`,
    [id, userId],
  );
  return rows.rows[0] ?? null;
}

/** Per-symbol Binary Watchlist view. */
export async function binaryWatchlistSnapshot() {
  const rows = await query(
    `SELECT watch.instrument, watch.model_name AS "modelName", watch.model_version AS "modelVersion",
            watch.evaluated_at AS "evaluatedAt", watch.data_status AS "dataStatus", watch.bias, watch.score::float AS score,
            watch.score_kind AS "scoreKind", watch.bid::float, watch.ask::float, watch.spread_pips::float AS "spreadPips",
            watch.session, watch.active_prediction_id AS "activePredictionId", watch.updated_at AS "updatedAt",
            prediction.direction AS "activeDirection", prediction.entry_price::float AS "activeEntry",
            prediction.start_at AS "activeStartAt", prediction.intended_expiration AS "activeExpiration"
     FROM binary_watch_snapshots watch
     LEFT JOIN binary_predictions prediction ON prediction.id = watch.active_prediction_id
     ORDER BY array_position($1::text[], watch.instrument)`,
    [[...MAJOR_INSTRUMENTS]],
  );
  const byInstrument = new Map(rows.rows.map((row) => [(row as { instrument: string }).instrument, row]));
  return MAJOR_INSTRUMENTS.map((instrument) => byInstrument.get(instrument) ?? {
    instrument,
    modelName: BINARY_MODEL_NAME,
    modelVersion: BINARY_MODEL_VERSION,
    evaluatedAt: null,
    dataStatus: "unavailable",
    bias: null,
    score: null,
    scoreKind: "heuristic_score",
    bid: null,
    ask: null,
    spreadPips: null,
    session: "Unavailable",
    activePredictionId: null,
    updatedAt: null,
  });
}

/** Performance analytics for the resolved prediction record. Authoritative rows only. */
export async function binaryPerformance(userId?: string) {
  const rows = await query<BinaryStatRow & HorizonResultRow>(
    `SELECT instrument, direction, status, result, confidence, market_context->>'session' AS session, model_version, start_at,
            duration_seconds AS "durationSeconds", secondary_marks AS "secondaryMarks"
     -- Baseline ONLY. Adding this scope is a no-op against today's data (every
     -- authoritative row is baseline) and is what keeps Pattern V1 rows from
     -- ever being folded into the baseline win rate.
     FROM binary_predictions WHERE is_authoritative=true AND model_name='${BINARY_BASELINE_MODEL}'${userId ? " AND user_id=$1" : ""}`,
    userId ? [userId] : [],
  );
  return {
    model: { name: BINARY_MODEL_NAME, version: BINARY_MODEL_VERSION, scoreKind: "heuristic_score" as const },
    summary: binaryStats(rows.rows),
    breakdowns: binaryPerformanceBreakdowns(rows.rows),
    // Same predictions scored at 5m / 10m / 15m, so the horizons compare like-for-like.
    horizons: binaryHorizonBreakdown(rows.rows),
  };
}

/** Dashboard/journal helper: label a pair for display. */
export function binaryDisplayName(instrument: string) {
  return displayNameFor(instrument);
}

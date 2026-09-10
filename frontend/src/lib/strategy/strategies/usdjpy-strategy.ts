import { displayNameFor } from "@/lib/instruments/catalog";
import { calculateAtrValues } from "@/lib/strategy/indicators";
import { completedCandles, evaluateHardGates } from "@/lib/strategy/strategy-common";
import type { StrategyCandidate } from "@/lib/strategy/strategy";
import type {
  MarketRegime, PairStrategyId, StrategyCondition, StrategyEvaluationInput, UsdjpyStrategyFeatures,
} from "@/lib/strategy/types";
import type { Candle } from "@/types/forex";

/**
 * USDJPY Body Extreme V6 — the frozen long-only Pine rules supplied for the
 * research/paper replacement. These constants must not be optimized in place.
 */
export const USDJPY_STRATEGY_ID = "usdjpy_strategy" as const;
export const USDJPY_STRATEGY_NAME = "USDJPY Body Extreme V6" as const;
export const USDJPY_STRATEGY_VERSION = 6 as const;
export const USDJPY_STRATEGY_VERSION_LABEL = "v6" as const;
export const USDJPY_STRATEGY_CONFIG_VERSION = "usdjpy-strategy-cfg-v6" as const;
export const USDJPY_STRATEGY_SYMBOL = "USD_JPY" as const;
export const USDJPY_STRATEGY_TIMEFRAME = "H1" as const;
export const USDJPY_STRATEGY_SETUP = "USDJPY_BODY_EXTREME" as const;

export const EMA_FAST = 20;
export const EMA_SLOW = 50;
export const ATR_LENGTH = 14;
export const PRE_RANGE_START_UTC = 8;
export const PRE_RANGE_END_UTC = 10;
export const ENTRY_WINDOW_START_UTC = 11;
export const ENTRY_WINDOW_END_UTC = 14;
export const BODY_ATR_MIN = 0.40;
export const EXTREME_CLOSE_PCT = 0.40;
export const STOP_ATR_MULTIPLIER = 1.0;
export const REWARD_R = 2.0;
export const MAX_HOLD_BARS = 3;

export const USDJPY_STRATEGY_CONFIG = Object.freeze({
  emaFastPeriod: EMA_FAST,
  emaSlowPeriod: EMA_SLOW,
  atrPeriod: ATR_LENGTH,
  preRangeStartUtcHour: PRE_RANGE_START_UTC,
  preRangeEndUtcHour: PRE_RANGE_END_UTC,
  entryWindowStartUtcHour: ENTRY_WINDOW_START_UTC,
  entryWindowEndUtcHour: ENTRY_WINDOW_END_UTC,
  minimumBodyAtr: BODY_ATR_MIN,
  extremeClosePct: EXTREME_CLOSE_PCT,
  stopAtr: STOP_ATR_MULTIPLIER,
  rewardR: REWARD_R,
  maxHoldBars: MAX_HOLD_BARS,
});

export type UsdjpyStrategyWaitReason =
  | "WRONG_SYMBOL"
  | "WRONG_TIMEFRAME"
  | "CANDLE_NOT_CLOSED"
  | "MALFORMED_CANDLES"
  | "OUTSIDE_ENTRY_WINDOW"
  | "MISSING_RANGE"
  | "INVALID_ATR"
  | "TREND_NOT_LONG"
  | "NO_CLOSE_BREAKOUT"
  | "BODY_TOO_SMALL"
  | "INVALID_BAR_RANGE"
  | "BAD_CLOSE_LOCATION"
  | "DAILY_TRADE_ALREADY_TAKEN"
  | "POSITION_ALREADY_OPEN"
  | "NUMERICAL_SAFETY";

export interface UsdjpyStrategyTraceRow {
  timestamp: string;
  signalCloseTime: string;
  preHigh: number | null;
  preLow: number | null;
  preRangeBarCount: number;
  rangeReady: boolean;
  tradedEarlierUtcDay: boolean;
  ema20: number | null;
  ema50: number | null;
  atr14: number | null;
  trendDirection: "LONG" | "SHORT" | "WAIT";
  body: number;
  bodyATRRatio: number | null;
  bodyPassed: boolean;
  barRange: number;
  closePositionPct: number | null;
  breakoutLong: boolean;
  breakoutShort: boolean;
  bullExtremeClose: boolean;
  bearExtremeClose: boolean;
  finalLongSignal: boolean;
  finalShortSignal: boolean;
  signalPrice: number | null;
  stop: number | null;
  target: number | null;
}
export interface UsdjpyStrategyEvaluationOptions {
  timeframe?: string;
  hasActivePosition?: boolean;
  onDebug?: (features: UsdjpyStrategyFeatures) => void;
}

type NormalizedCandles = { candles: Candle[]; error: string | null };

function finite(value: number) {
  return Number.isFinite(value);
}

function validCandle(candle: Candle) {
  const timestamp = Date.parse(candle.time);
  return Number.isFinite(timestamp)
    && finite(candle.open) && finite(candle.high) && finite(candle.low) && finite(candle.close)
    && candle.high >= Math.max(candle.open, candle.close)
    && candle.low <= Math.min(candle.open, candle.close)
    && candle.high >= candle.low;
}

function sameCandle(left: Candle, right: Candle) {
  return left.open === right.open && left.high === right.high && left.low === right.low
    && left.close === right.close && left.complete === right.complete;
}

/** Completed H1 bars only, sorted ascending; conflicting duplicate bars fail closed. */
export function normalizeUsdjpyH1Candles(candles: readonly Candle[]): NormalizedCandles {
  const completed = candles.filter((candle) => candle.complete);
  if (!completed.length) return { candles: [], error: null };
  if (completed.some((candle) => !validCandle(candle))) {
    return { candles: [], error: "Completed H1 history contains a malformed candle." };
  }
  const sorted = [...completed].sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  const unique: Candle[] = [];
  for (const candle of sorted) {
    const previous = unique.at(-1);
    if (!previous || Date.parse(previous.time) !== Date.parse(candle.time)) {
      unique.push(candle);
      continue;
    }
    if (!sameCandle(previous, candle)) {
      return { candles: [], error: `Conflicting H1 candles share timestamp ${candle.time}.` };
    }
  }
  return { candles: unique, error: null };
}

/** Pine ta.ema seed semantics: the first non-na source value starts the EMA. */
export function calculatePineEmaValues(closes: readonly number[], period: number) {
  const alpha = 2 / (period + 1);
  let previous: number | null = null;
  return closes.map((close) => {
    previous = previous === null ? close : alpha * close + (1 - alpha) * previous;
    return previous;
  });
}

function utcDay(timestamp: string) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function isExactH1Start(date: Date) {
  return date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
}

function allPreRangeHoursSeen(hours: ReadonlySet<number>) {
  for (let hour = PRE_RANGE_START_UTC; hour <= PRE_RANGE_END_UTC; hour += 1) {
    if (!hours.has(hour)) return false;
  }
  return true;
}

/**
 * Causal Pine-parity trace. The candle timestamp is its H1 START; signalCloseTime
 * is one hour later. At most the first qualifying 11:00-14:00 candle per UTC
 * day is emitted, matching the frozen one-trade-per-day rule.
 */
export function evaluateUsdjpyStrategyTrace(candles: readonly Candle[]): { rows: UsdjpyStrategyTraceRow[]; error: string | null } {
  const normalized = normalizeUsdjpyH1Candles(candles);
  if (normalized.error) return { rows: [], error: normalized.error };
  const values = normalized.candles;
  const ema20Values = calculatePineEmaValues(values.map((candle) => candle.close), EMA_FAST);
  const ema50Values = calculatePineEmaValues(values.map((candle) => candle.close), EMA_SLOW);
  const atr14Values = calculateAtrValues(values, ATR_LENGTH);
  const rows: UsdjpyStrategyTraceRow[] = [];
  let day: string | null = null;
  let preHigh: number | null = null;
  let preLow: number | null = null;
  let preRangeHours = new Set<number>();
  let tradeTakenUtcDay = false;

  for (let index = 0; index < values.length; index += 1) {
    const candle = values[index]!;
    const date = new Date(candle.time);
    const currentDay = utcDay(candle.time);
    if (currentDay !== day) {
      day = currentDay;
      preHigh = null;
      preLow = null;
      preRangeHours = new Set<number>();
      tradeTakenUtcDay = false;
    }
    const hour = date.getUTCHours();
    if (isExactH1Start(date) && hour >= PRE_RANGE_START_UTC && hour <= PRE_RANGE_END_UTC) {
      preRangeHours.add(hour);
      preHigh = preHigh === null ? candle.high : Math.max(preHigh, candle.high);
      preLow = preLow === null ? candle.low : Math.min(preLow, candle.low);
    }

    const rangeReady = preHigh !== null && preLow !== null
      && preRangeHours.size === PRE_RANGE_END_UTC - PRE_RANGE_START_UTC + 1
      && allPreRangeHoursSeen(preRangeHours);
    const ema20 = ema20Values[index] ?? null;
    const ema50 = ema50Values[index] ?? null;
    const atr14 = atr14Values[index] ?? null;
    const trendDirection = ema20 === null || ema50 === null || ema20 === ema50
      ? "WAIT" as const : ema20 > ema50 ? "LONG" as const : "SHORT" as const;
    const body = Math.abs(candle.close - candle.open);
    const bodyATRRatio = atr14 !== null && atr14 > 0 ? body / atr14 : null;
    const bodyPassed = atr14 !== null && atr14 > 0 && body >= atr14 * BODY_ATR_MIN;
    const barRange = candle.high - candle.low;
    const closePositionPct = barRange > 0 ? ((candle.close - candle.low) / barRange) * 100 : null;
    const bullExtremeClose = barRange > 0 && candle.close >= candle.high - barRange * EXTREME_CLOSE_PCT;
    const bearExtremeClose = false;
    const inEntryWindow = hour >= ENTRY_WINDOW_START_UTC && hour <= ENTRY_WINDOW_END_UTC;
    const tradedEarlierUtcDay = tradeTakenUtcDay;
    const isOrigin = isExactH1Start(date) && inEntryWindow && rangeReady && !tradedEarlierUtcDay
      && atr14 !== null && atr14 > 0 && finite(atr14) && trendDirection === "LONG";
    const breakoutLong = Boolean(isOrigin && candle.close > preHigh!);
    const breakoutShort = false;
    const finalLongSignal = breakoutLong && bodyPassed && bullExtremeClose;
    const finalShortSignal = false;
    const signalPrice = finalLongSignal ? candle.close : null;
    const risk = signalPrice === null || atr14 === null ? null : atr14 * STOP_ATR_MULTIPLIER;
    const stop = signalPrice === null || risk === null ? null : signalPrice - risk;
    const target = signalPrice === null || risk === null ? null : signalPrice + risk * REWARD_R;

    rows.push({
      timestamp: candle.time,
      signalCloseTime: new Date(Date.parse(candle.time) + 60 * 60_000).toISOString(),
      preHigh, preLow, preRangeBarCount: preRangeHours.size, rangeReady, tradedEarlierUtcDay,
      ema20, ema50, atr14, trendDirection, body, bodyATRRatio, bodyPassed, barRange, closePositionPct,
      breakoutLong, breakoutShort, bullExtremeClose, bearExtremeClose,
      finalLongSignal, finalShortSignal, signalPrice, stop, target,
    });
    if (finalLongSignal) tradeTakenUtcDay = true;
  }
  return { rows, error: null };
}

function condition(name: string, passed: boolean, reason: string, currentValue: string): StrategyCondition {
  return { name, passed, required: true, reason, currentValue };
}

function waitReasonFor(trace: UsdjpyStrategyTraceRow, candle: Candle): UsdjpyStrategyWaitReason | null {
  const hour = new Date(candle.time).getUTCHours();
  if (!isExactH1Start(new Date(candle.time)) || hour < ENTRY_WINDOW_START_UTC || hour > ENTRY_WINDOW_END_UTC) return "OUTSIDE_ENTRY_WINDOW";
  if (!trace.rangeReady) return "MISSING_RANGE";
  if (trace.atr14 === null || !finite(trace.atr14) || !(trace.atr14 > 0)) return "INVALID_ATR";
  if (trace.tradedEarlierUtcDay) return "DAILY_TRADE_ALREADY_TAKEN";
  if (trace.trendDirection !== "LONG") return "TREND_NOT_LONG";
  if (!trace.breakoutLong) return "NO_CLOSE_BREAKOUT";
  if (!trace.bodyPassed) return "BODY_TOO_SMALL";
  if (!(trace.barRange > 0)) return "INVALID_BAR_RANGE";
  if (!trace.bullExtremeClose) return "BAD_CLOSE_LOCATION";
  return null;
}

function emptyRegime(evaluatedAt: string, trace: UsdjpyStrategyTraceRow | undefined): MarketRegime {
  return {
    regime: "mixed",
    trendDirection: trace?.trendDirection === "LONG" ? "up" : trace?.trendDirection === "SHORT" ? "down" : "none",
    trendStrength: 0,
    volatility: "normal",
    atr: trace?.atr14 ?? null,
    atrPips: trace?.atr14 == null ? null : trace.atr14 / 0.01,
    momentumState: "steady",
    emaFast: trace?.ema20 ?? null,
    emaMid: trace?.ema50 ?? null,
    emaSlow: null,
    slopeAtrPerBar: null,
    rangeHigh: trace?.preHigh ?? null,
    rangeLow: trace?.preLow ?? null,
    rangeWidthAtr: trace?.atr14 && trace.preHigh !== null && trace.preLow !== null
      ? (trace.preHigh - trace.preLow) / trace.atr14 : null,
    rangeAgeBars: null,
    lookbackBars: EMA_SLOW,
    evaluatedAt,
  };
}

function finitePositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Evaluate only the latest completed H1 candle. No future or forming bar is read. */
export function evaluateUsdjpyStrategy(
  input: StrategyEvaluationInput,
  options: UsdjpyStrategyEvaluationOptions = {},
): StrategyCandidate<PairStrategyId> {
  const timeframe = options.timeframe ?? USDJPY_STRATEGY_TIMEFRAME;
  const normalized = normalizeUsdjpyH1Candles(input.candles1h);
  const traced = normalized.error ? { rows: [] as UsdjpyStrategyTraceRow[], error: normalized.error }
    : evaluateUsdjpyStrategyTrace(normalized.candles);
  const lastCandle = normalized.candles.at(-1);
  const trace = traced.rows.at(-1);
  const signalCloseTime = trace?.signalCloseTime ?? input.evaluatedAt ?? new Date(0).toISOString();
  // These are execution gates, not Pine signal rules. Keeping them on the
  // candidate without changing its signal verdict lets the journal record both
  // facts: V1 fired, but GoldenXperience may have rejected execution.
  const executionGates = evaluateHardGates(
    input,
    signalCloseTime,
    completedCandles(input.candles15m),
    normalized.candles,
    completedCandles(input.candles4h),
  );
  let waitReason: UsdjpyStrategyWaitReason | null = null;

  if (input.instrument !== USDJPY_STRATEGY_SYMBOL) waitReason = "WRONG_SYMBOL";
  else if (timeframe !== USDJPY_STRATEGY_TIMEFRAME) waitReason = "WRONG_TIMEFRAME";
  else if (normalized.error || traced.error) waitReason = "MALFORMED_CANDLES";
  else if (!lastCandle || !trace) waitReason = "CANDLE_NOT_CLOSED";
  else waitReason = waitReasonFor(trace, lastCandle);

  const strategySignalQualified = waitReason === null && trace?.finalLongSignal === true;
  const executionBlockReason = !strategySignalQualified ? "NO_STRATEGY_SIGNAL"
    : options.hasActivePosition ? "POSITION_ALREADY_OPEN"
      : !finitePositive(input.ask) ? "OANDA_PRICE_UNAVAILABLE" : null;
  const executionAllowed = strategySignalQualified && executionBlockReason === null;
  const direction = executionAllowed ? "long" as const : null;
  const signalPrice = trace?.signalPrice ?? null;
  const quotedEntry = direction === "long" ? input.ask : null;
  const entry = direction && finitePositive(quotedEntry) ? quotedEntry : null;
  const riskDistance = direction && trace?.atr14 != null ? trace.atr14 * STOP_ATR_MULTIPLIER : null;
  const stop = entry === null || riskDistance === null ? null : entry - riskDistance;
  const target = entry === null || riskDistance === null ? null : entry + riskDistance * REWARD_R;
  const numericalSafety = direction !== null && finitePositive(entry) && finitePositive(riskDistance)
    && finitePositive(stop) && finitePositive(target)
    && stop < entry && entry < target;
  if (direction && !numericalSafety) waitReason = "NUMERICAL_SAFETY";
  const finalDirection = waitReason === null && numericalSafety ? direction : null;
  const finalEntry = finalDirection ? entry : null;
  const finalStop = finalDirection ? stop : null;
  const finalTarget = finalDirection ? target : null;
  const signalReason = strategySignalQualified
    ? finalDirection === "long"
      ? "USDJPY Pine signal qualified and execution is allowed."
      : `USDJPY Pine signal qualified; execution blocked: ${executionBlockReason ?? "NUMERICAL_SAFETY"}.`
    : `WAIT: ${waitReason ?? "NO_CLOSE_BREAKOUT"}.`;

  const features: UsdjpyStrategyFeatures = {
    strategyId: USDJPY_STRATEGY_ID,
    strategyName: USDJPY_STRATEGY_NAME,
    strategyVersion: USDJPY_STRATEGY_VERSION,
    symbol: USDJPY_STRATEGY_SYMBOL,
    timeframe: USDJPY_STRATEGY_TIMEFRAME,
    session: "USDJPY_11_14_UTC",
    setup: USDJPY_STRATEGY_SETUP,
    signalDirection: strategySignalQualified ? "LONG" : null,
    signalCandleTimestamp: trace?.timestamp ?? null,
    signalTimestampUtc: trace?.signalCloseTime ?? null,
    signalPrice,
    executionEntryPrice: finalEntry,
    actualFillPrice: null,
    ema20: trace?.ema20 ?? null,
    ema50: trace?.ema50 ?? null,
    atr14: trace?.atr14 ?? null,
    entryATR: finalDirection ? trace?.atr14 ?? null : null,
    riskDistance: finalDirection ? riskDistance : null,
    preHigh: trace?.preHigh ?? null,
    preLow: trace?.preLow ?? null,
    preRangeBarCount: trace?.preRangeBarCount ?? 0,
    rangeReady: trace?.rangeReady ?? false,
    tradedEarlierUtcDay: trace?.tradedEarlierUtcDay ?? false,
    signalCandle: lastCandle ? { open: lastCandle.open, high: lastCandle.high, low: lastCandle.low, close: lastCandle.close } : null,
    body: trace?.body ?? null,
    bodyATRRatio: trace?.bodyATRRatio ?? null,
    bodyPassed: trace?.bodyPassed ?? false,
    barRange: trace?.barRange ?? null,
    closePositionPct: trace?.closePositionPct ?? null,
    trendDirection: trace?.trendDirection ?? "WAIT",
    breakoutLong: trace?.breakoutLong ?? false,
    breakoutShort: trace?.breakoutShort ?? false,
    bullExtremeClose: trace?.bullExtremeClose ?? false,
    bearExtremeClose: trace?.bearExtremeClose ?? false,
    extremeClosePassed: finalDirection === "long" ? trace?.bullExtremeClose ?? false : false,
    finalLongSignal: trace?.finalLongSignal ?? false,
    finalShortSignal: trace?.finalShortSignal ?? false,
    strategySignalQualified,
    executionAllowed: finalDirection === "long",
    executionBlockReason: finalDirection === "long" ? null : numericalSafety || !strategySignalQualified ? executionBlockReason : "NUMERICAL_SAFETY",
    stopPrice: finalStop,
    targetPrice: finalTarget,
    stopATRMultiplier: STOP_ATR_MULTIPLIER,
    rewardR: REWARD_R,
    maximumHoldBars: MAX_HOLD_BARS,
    barsHeld: 0,
    exitPrice: null,
    exitReason: null,
    realizedR: null,
    realizedPnL: null,
    reason: signalReason,
    waitReason: strategySignalQualified && !executionAllowed ? executionBlockReason : waitReason,
    signalKey: strategySignalQualified && trace ? `${USDJPY_STRATEGY_ID}:${USDJPY_STRATEGY_SYMBOL}:${utcDay(trace.timestamp)}` : null,
  };
  options.onDebug?.(features);

  const conditions: StrategyCondition[] = [
    condition("Symbol", input.instrument === USDJPY_STRATEGY_SYMBOL, "USDJPY Body Extreme V6 is restricted to USD_JPY.", input.instrument),
    condition("Timeframe", timeframe === USDJPY_STRATEGY_TIMEFRAME, "Only completed H1 candles are eligible.", timeframe),
    condition("Completed 11:00-14:00 UTC candle", Boolean(lastCandle && new Date(lastCandle.time).getUTCHours() >= ENTRY_WINDOW_START_UTC && new Date(lastCandle.time).getUTCHours() <= ENTRY_WINDOW_END_UTC), "Entry evaluation is limited to completed H1 candles starting 11:00 through 14:00 UTC inclusive.", lastCandle?.time ?? "unavailable"),
    condition("08:00-10:00 UTC range", trace?.rangeReady ?? false, "All three current-day UTC range candles are required; entry-window candles are excluded.", trace ? `${trace.preRangeBarCount}/3` : "0/3"),
    condition("Wilder ATR14", Boolean(trace?.atr14 != null && trace.atr14 > 0), "ATR14 must be finite and positive.", trace?.atr14?.toString() ?? "unavailable"),
    condition("EMA20 above EMA50", trace?.trendDirection === "LONG", "V6 is long-only and requires EMA20 > EMA50.", trace?.trendDirection ?? "WAIT"),
    condition("Close breakout", trace?.breakoutLong ?? false, "The close, not merely the wick, must exceed the pre-range high.", trace?.breakoutLong ? "LONG" : "none"),
    condition("Body strength", trace?.bodyPassed ?? false, "Body must be at least 0.40 ATR14.", trace?.bodyATRRatio == null ? "unavailable" : `${trace.bodyATRRatio.toFixed(4)} ATR`),
    condition("Positive candle range", Boolean(trace && trace.barRange > 0), "The signal candle high-low range must be positive.", trace?.barRange?.toString() ?? "unavailable"),
    condition("Upper-40% close", trace?.bullExtremeClose ?? false, "The long signal must close within the upper 40% of its candle range.", trace?.closePositionPct == null ? "unavailable" : `${trace.closePositionPct.toFixed(2)}% from low`),
    condition("One trade per UTC day", !(trace?.tradedEarlierUtcDay ?? false), "Only the first qualifying V6 signal of each UTC day may enter.", trace?.tradedEarlierUtcDay ? "already taken" : "clear"),
    condition("No active strategy position", !options.hasActivePosition, "Pyramiding is disabled for usdjpy_strategy.", options.hasActivePosition ? "active" : "clear"),
    condition("Numerical safety", finalDirection ? numericalSafety : true, "Entry, ATR-frozen risk, stop, and target must be finite and ordered.", finalDirection ? (numericalSafety ? "valid" : "invalid") : "not applicable"),
  ];
  const allConditions = [...conditions, ...executionGates.conditions];
  const regime = emptyRegime(signalCloseTime, trace);
  return {
    family: USDJPY_STRATEGY_ID,
    version: USDJPY_STRATEGY_VERSION_LABEL,
    configVersion: USDJPY_STRATEGY_CONFIG_VERSION,
    regime,
    qualifyReason: signalReason,
    status: finalDirection ? "valid" : waitReason === "MALFORMED_CANDLES" ? "invalid" : "no_setup",
    instrument: input.instrument,
    pair: displayNameFor(input.instrument),
    direction: finalDirection,
    timeframe: "1h",
    entry: finalEntry,
    stop: finalStop,
    target: finalTarget,
    riskReward: finalDirection ? REWARD_R : null,
    positionSize: null,
    features: {
      trend15m: "mixed",
      trend1h: trace?.trendDirection === "LONG" ? "bullish" : trace?.trendDirection === "SHORT" ? "bearish" : "mixed",
      trend4h: null,
      ema21: null,
      ema50: trace?.ema50 ?? null,
      ema200: null,
      rsi14: null,
      atr14: trace?.atr14 ?? null,
      atrPips: trace?.atr14 == null ? null : trace.atr14 / 0.01,
      structureHighs: 0,
      structureLows: 0,
      evaluationMode: input.evaluationMode ?? "live",
      newsStatus: executionGates.newsStatus,
      usdjpyStrategy: features,
    },
    summary: signalReason,
    passedConditions: allConditions.filter((item) => item.passed),
    failedConditions: allConditions.filter((item) => !item.passed),
    conditions: allConditions,
    evaluatedAt: signalCloseTime,
    dataSource: input.dataSource,
  };
}

export interface UsdjpyExitQuote {
  closeTime: string;
  bidHigh: number;
  bidLow: number;
  bidClose: number;
  askHigh: number;
  askLow: number;
  askClose: number;
}

export interface UsdjpyExitResult {
  outcome: "target_first" | "stop_first" | "time_exit";
  exitReason: "TAKE_PROFIT" | "STOP_LOSS" | "TIME_EXIT";
  exit: number;
  resultR: number;
  resolvedAt: string;
  horizonEndsAt: string;
  barsHeld: number;
  maxFavorableR: number | null;
  maxAdverseR: number | null;
}

/** Pure resolver for exactly three future completed H1 bars. Same-M15 collisions charge the stop. */
export function resolveUsdjpyExit(input: {
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  decisionTime: string;
  quotes: readonly UsdjpyExitQuote[];
  now: Date;
}): UsdjpyExitResult | null {
  const decisionMs = Date.parse(input.decisionTime);
  const horizonMs = decisionMs + MAX_HOLD_BARS * 60 * 60_000;
  const horizonEndsAt = new Date(horizonMs).toISOString();
  const risk = Math.abs(input.entry - input.stop);
  if (!Number.isFinite(decisionMs) || !(risk > 0)) return null;
  let maxFavorableR: number | null = null;
  let maxAdverseR: number | null = null;
  let horizonQuote: UsdjpyExitQuote | null = null;
  const quotes = [...input.quotes].sort((left, right) => Date.parse(left.closeTime) - Date.parse(right.closeTime));
  for (const quote of quotes) {
    const quoteMs = Date.parse(quote.closeTime);
    if (!(quoteMs > decisionMs) || quoteMs > horizonMs) continue;
    if (quoteMs === horizonMs) horizonQuote = quote;
    const favorable = input.direction === "long" ? (quote.bidHigh - input.entry) / risk : (input.entry - quote.askLow) / risk;
    const adverse = input.direction === "long" ? (input.entry - quote.bidLow) / risk : (quote.askHigh - input.entry) / risk;
    maxFavorableR = Math.max(maxFavorableR ?? favorable, favorable);
    maxAdverseR = Math.max(maxAdverseR ?? adverse, adverse);
    const targetHit = input.direction === "long" ? quote.bidHigh >= input.target : quote.askLow <= input.target;
    const stopHit = input.direction === "long" ? quote.bidLow <= input.stop : quote.askHigh >= input.stop;
    const barsHeld = Math.max(1, Math.ceil((quoteMs - decisionMs) / (60 * 60_000)));
    if (stopHit) {
      return { outcome: "stop_first", exitReason: "STOP_LOSS", exit: input.stop, resultR: -1, resolvedAt: quote.closeTime, horizonEndsAt, barsHeld, maxFavorableR, maxAdverseR };
    }
    if (targetHit) {
      return { outcome: "target_first", exitReason: "TAKE_PROFIT", exit: input.target, resultR: Math.abs(input.target - input.entry) / risk, resolvedAt: quote.closeTime, horizonEndsAt, barsHeld, maxFavorableR, maxAdverseR };
    }
  }
  if (input.now.getTime() < horizonMs || !horizonQuote) return null;
  const exit = input.direction === "long" ? horizonQuote.bidClose : horizonQuote.askClose;
  const resultR = input.direction === "long" ? (exit - input.entry) / risk : (input.entry - exit) / risk;
  return {
    outcome: "time_exit", exitReason: "TIME_EXIT", exit, resultR,
    resolvedAt: horizonQuote.closeTime, horizonEndsAt, barsHeld: MAX_HOLD_BARS,
    maxFavorableR, maxAdverseR,
  };
}

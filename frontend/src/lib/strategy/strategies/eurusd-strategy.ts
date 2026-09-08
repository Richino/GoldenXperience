import { displayNameFor } from "@/lib/instruments/catalog";
import { calculateAtrValues, calculateEmaValues } from "@/lib/strategy/indicators";
import type { StrategyCandidate } from "@/lib/strategy/strategy";
import type {
  EurusdStrategyFeatures, MarketRegime, PairStrategyId, StrategyCondition, StrategyEvaluationInput,
} from "@/lib/strategy/types";
import type { Candle } from "@/types/forex";

/**
 * EURUSD_STRATEGY V1
 * Frozen source: GX 1H A London Breakout Only V1
 * Pair: EUR_USD
 * Timeframe: H1
 * Asia range: 00:00-06:00 UTC
 * London signals: 06:00-11:00 UTC
 * EMA: 20/50
 * ATR: 14
 * Minimum body: 0.35 ATR
 * Stop: 1 ATR
 * Target: 2 ATR
 * R:R: 1:2
 * Setup: A_LONDON_BO
 *
 * DO NOT OPTIMIZE THESE PARAMETERS WITHOUT CREATING A NEW STRATEGY VERSION.
 */

export const EURUSD_STRATEGY_ID = "eurusd_strategy" as const;
export const EURUSD_STRATEGY_NAME = "EURUSD London Breakout" as const;
export const EURUSD_STRATEGY_VERSION = "v1" as const;
export const EURUSD_STRATEGY_CONFIG_VERSION = "eurusd-strategy-cfg-v1" as const;
export const EURUSD_STRATEGY_SYMBOL = "EUR_USD" as const;
export const EURUSD_STRATEGY_TIMEFRAME = "H1" as const;
export const EURUSD_STRATEGY_SETUP = "A_LONDON_BO" as const;

export const EURUSD_STRATEGY_CONFIG = Object.freeze({
  asiaStartUtcHour: 0,
  asiaEndUtcHour: 6,
  londonStartUtcHour: 6,
  londonEndUtcHour: 11,
  emaFastPeriod: 20,
  emaSlowPeriod: 50,
  atrPeriod: 14,
  minimumBodyAtr: 0.35,
  stopAtr: 1.0,
  rewardR: 2.0,
});

export type EurusdStrategyWaitReason =
  | "WRONG_SYMBOL"
  | "WRONG_TIMEFRAME"
  | "CANDLE_NOT_CLOSED"
  | "MALFORMED_CANDLES"
  | "ASIA_NOT_READY"
  | "OUTSIDE_LONDON"
  | "INDICATORS_NOT_READY"
  | "NO_ASIA_BREAKOUT"
  | "TREND_NOT_CONFIRMED"
  | "STRUCTURE_NOT_CONFIRMED"
  | "BODY_TOO_SMALL"
  | "DUPLICATE_SIGNAL"
  | "POSITION_ALREADY_OPEN"
  | "CONFLICTING_SIGNAL"
  | "NUMERICAL_SAFETY";

export interface EurusdStrategyTraceRow {
  timestamp: string;
  asiaHigh: number | null;
  asiaLow: number | null;
  ema20: number | null;
  ema50: number | null;
  atr14: number | null;
  bullTrend: boolean;
  bearTrend: boolean;
  bullStructure: boolean;
  bearStructure: boolean;
  body: number;
  longSetup: boolean;
  shortSetup: boolean;
  sigA: -1 | 0 | 1;
  evtA: boolean;
  entry: number | null;
  stop: number | null;
  target: number | null;
}
export interface EurusdStrategyEvaluationOptions {
  /** Explicit for parity/replay callers. The production candle slot is H1. */
  timeframe?: string;
  /** Hydrated from the existing journal before this strategy is ever enabled. */
  hasActivePosition?: boolean;
  /** Optional diagnostic hook; signal generation still fails closed. */
  onConflict?: (timestamp: string) => void;
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

/** Sort completed bars ascending and reject ambiguous duplicate timestamps. */
export function normalizeEurusdH1Candles(candles: readonly Candle[]): NormalizedCandles {
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

function utcDateKey(timestamp: string) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function isLondonHour(hour: number) {
  return hour >= EURUSD_STRATEGY_CONFIG.londonStartUtcHour && hour < EURUSD_STRATEGY_CONFIG.londonEndUtcHour;
}

export function isEurusdStrategyEvent(sigA: -1 | 0 | 1, previousSigA: -1 | 0 | 1) {
  return sigA !== 0 && previousSigA === 0;
}

/**
 * Produces the Pine-parity audit row for every completed candle. Each row reads
 * only bars at or before its timestamp; no future candle can affect an earlier row.
 */
export function evaluateEurusdStrategyTrace(candles: readonly Candle[]): { rows: EurusdStrategyTraceRow[]; error: string | null } {
  const normalized = normalizeEurusdH1Candles(candles);
  if (normalized.error) return { rows: [], error: normalized.error };

  const values = normalized.candles;
  const ema20Values = calculateEmaValues(values.map((candle) => candle.close), EURUSD_STRATEGY_CONFIG.emaFastPeriod);
  const ema50Values = calculateEmaValues(values.map((candle) => candle.close), EURUSD_STRATEGY_CONFIG.emaSlowPeriod);
  const atr14Values = calculateAtrValues(values, EURUSD_STRATEGY_CONFIG.atrPeriod);
  const rows: EurusdStrategyTraceRow[] = [];
  let dayKey: string | null = null;
  let asiaHigh: number | null = null;
  let asiaLow: number | null = null;
  let previousSigA: -1 | 0 | 1 = 0;

  for (let index = 0; index < values.length; index += 1) {
    const candle = values[index]!;
    const date = new Date(candle.time);
    const currentDayKey = utcDateKey(candle.time);
    if (currentDayKey !== dayKey) {
      dayKey = currentDayKey;
      asiaHigh = null;
      asiaLow = null;
    }

    const hour = date.getUTCHours();
    if (hour >= EURUSD_STRATEGY_CONFIG.asiaStartUtcHour && hour < EURUSD_STRATEGY_CONFIG.asiaEndUtcHour) {
      asiaHigh = asiaHigh === null ? candle.high : Math.max(asiaHigh, candle.high);
      asiaLow = asiaLow === null ? candle.low : Math.min(asiaLow, candle.low);
    }

    const previous = values[index - 1];
    const ema20 = ema20Values[index] ?? null;
    const ema50 = ema50Values[index] ?? null;
    const atr14 = atr14Values[index] ?? null;
    const body = Math.abs(candle.close - candle.open);
    const bullTrend = ema20 !== null && ema50 !== null && ema20 > ema50;
    const bearTrend = ema20 !== null && ema50 !== null && ema20 < ema50;
    const bullStructure = Boolean(previous && candle.high > previous.high && candle.low > previous.low);
    const bearStructure = Boolean(previous && candle.high < previous.high && candle.low < previous.low);
    const asiaReady = asiaHigh !== null && asiaLow !== null;
    const indicatorsReady = index >= EURUSD_STRATEGY_CONFIG.emaSlowPeriod - 1
      && atr14 !== null && atr14 > 0 && finite(atr14) && ema20 !== null && ema50 !== null;
    const inLondon = isLondonHour(hour);
    const strongBody = indicatorsReady && body >= atr14 * EURUSD_STRATEGY_CONFIG.minimumBodyAtr;
    const longSetup = Boolean(previous && inLondon && asiaReady && indicatorsReady
      && candle.close > asiaHigh! && previous.close <= asiaHigh!
      && bullTrend && bullStructure && strongBody);
    const shortSetup = Boolean(previous && inLondon && asiaReady && indicatorsReady
      && candle.close < asiaLow! && previous.close >= asiaLow!
      && bearTrend && bearStructure && strongBody);
    const sigA: -1 | 0 | 1 = longSetup === shortSetup ? 0 : longSetup ? 1 : -1;
    const evtA = isEurusdStrategyEvent(sigA, previousSigA);
    const entry = evtA ? candle.close : null;
    const stop = entry === null || atr14 === null ? null : sigA === 1
      ? entry - atr14 * EURUSD_STRATEGY_CONFIG.stopAtr
      : entry + atr14 * EURUSD_STRATEGY_CONFIG.stopAtr;
    const target = entry === null || atr14 === null ? null : sigA === 1
      ? entry + atr14 * EURUSD_STRATEGY_CONFIG.rewardR
      : entry - atr14 * EURUSD_STRATEGY_CONFIG.rewardR;

    rows.push({
      timestamp: candle.time, asiaHigh, asiaLow, ema20, ema50, atr14,
      bullTrend, bearTrend, bullStructure, bearStructure, body,
      longSetup, shortSetup, sigA, evtA, entry, stop, target,
    });
    previousSigA = sigA;
  }
  return { rows, error: null };
}

function emptyRegime(evaluatedAt: string, trace: EurusdStrategyTraceRow | undefined): MarketRegime {
  return {
    regime: "mixed",
    trendDirection: trace?.bullTrend ? "up" : trace?.bearTrend ? "down" : "none",
    trendStrength: 0,
    volatility: "normal",
    atr: trace?.atr14 ?? null,
    atrPips: trace?.atr14 == null ? null : trace.atr14 / 0.0001,
    momentumState: "steady",
    emaFast: trace?.ema20 ?? null,
    emaMid: trace?.ema50 ?? null,
    emaSlow: null,
    slopeAtrPerBar: null,
    rangeHigh: trace?.asiaHigh ?? null,
    rangeLow: trace?.asiaLow ?? null,
    rangeWidthAtr: trace?.atr14 && trace.asiaHigh !== null && trace.asiaLow !== null
      ? (trace.asiaHigh - trace.asiaLow) / trace.atr14 : null,
    rangeAgeBars: null,
    lookbackBars: EURUSD_STRATEGY_CONFIG.emaSlowPeriod,
    evaluatedAt,
  };
}

function strategyCondition(name: string, passed: boolean, reason: string, currentValue: string): StrategyCondition {
  return { name, passed, required: true, reason, currentValue };
}

function waitReasonFor(trace: EurusdStrategyTraceRow, candle: Candle, previous: Candle | undefined): EurusdStrategyWaitReason {
  if (trace.ema20 === null || trace.ema50 === null || trace.atr14 === null || !(trace.atr14 > 0)) return "INDICATORS_NOT_READY";
  if (trace.asiaHigh === null || trace.asiaLow === null) return "ASIA_NOT_READY";
  if (!isLondonHour(new Date(candle.time).getUTCHours())) return "OUTSIDE_LONDON";
  const crossedHigh = Boolean(previous && candle.close > trace.asiaHigh && previous.close <= trace.asiaHigh);
  const crossedLow = Boolean(previous && candle.close < trace.asiaLow && previous.close >= trace.asiaLow);
  if (!crossedHigh && !crossedLow) return "NO_ASIA_BREAKOUT";
  if ((crossedHigh && !trace.bullTrend) || (crossedLow && !trace.bearTrend)) return "TREND_NOT_CONFIRMED";
  if ((crossedHigh && !trace.bullStructure) || (crossedLow && !trace.bearStructure)) return "STRUCTURE_NOT_CONFIRMED";
  if (trace.body < trace.atr14 * EURUSD_STRATEGY_CONFIG.minimumBodyAtr) return "BODY_TOO_SMALL";
  if (trace.sigA !== 0 && !trace.evtA) return "DUPLICATE_SIGNAL";
  return "NO_ASIA_BREAKOUT";
}

function reasonFor(direction: "long" | "short") {
  return direction === "long"
    ? "EURUSD London breakout above Asia high with EMA20>EMA50, bullish structure, and candle body >= 0.35 ATR."
    : "EURUSD London breakout below Asia low with EMA20<EMA50, bearish structure, and candle body >= 0.35 ATR.";
}

/** Pure, dormant evaluator. It is registered but not called by any live/paper pipeline. */
export function evaluateEurusdStrategy(
  input: StrategyEvaluationInput,
  options: EurusdStrategyEvaluationOptions = {},
): StrategyCandidate<PairStrategyId> {
  const timeframe = options.timeframe ?? EURUSD_STRATEGY_TIMEFRAME;
  const normalized = normalizeEurusdH1Candles(input.candles1h);
  const lastCandle = normalized.candles.at(-1);
  const signalCloseTime = lastCandle
    ? new Date(Date.parse(lastCandle.time) + 60 * 60_000).toISOString()
    : input.evaluatedAt ?? new Date(0).toISOString();
  const traced = normalized.error ? { rows: [] as EurusdStrategyTraceRow[], error: normalized.error }
    : evaluateEurusdStrategyTrace(normalized.candles);
  const trace = traced.rows.at(-1);
  const previousCandle = normalized.candles.at(-2);
  const conditions: StrategyCondition[] = [];
  let waitReason: EurusdStrategyWaitReason | null = null;

  if (input.instrument !== EURUSD_STRATEGY_SYMBOL) waitReason = "WRONG_SYMBOL";
  else if (timeframe !== EURUSD_STRATEGY_TIMEFRAME) waitReason = "WRONG_TIMEFRAME";
  else if (normalized.error || traced.error) waitReason = "MALFORMED_CANDLES";
  else if (!lastCandle || !trace) waitReason = "CANDLE_NOT_CLOSED";
  else if (options.hasActivePosition) waitReason = "POSITION_ALREADY_OPEN";
  else if (trace.longSetup && trace.shortSetup) {
    waitReason = "CONFLICTING_SIGNAL";
    options.onConflict?.(trace.timestamp);
  } else if (!trace.evtA) waitReason = waitReasonFor(trace, lastCandle, previousCandle);

  const direction = waitReason === null && trace?.evtA ? (trace.sigA === 1 ? "long" : "short") : null;
  const entry = direction ? trace!.entry : null;
  const stop = direction ? trace!.stop : null;
  const target = direction ? trace!.target : null;
  const numericalSafety = entry !== null && stop !== null && target !== null && trace?.atr14 != null
    && [entry, stop, target, trace?.atr14, trace?.ema20, trace?.ema50, trace?.asiaHigh, trace?.asiaLow].every((value) => typeof value === "number" && finite(value))
    && trace!.atr14! > 0
    && (direction === "long" ? stop < entry && entry < target : target < entry && entry < stop);
  if (direction && !numericalSafety) waitReason = "NUMERICAL_SAFETY";
  const finalDirection = waitReason === null ? direction : null;
  const signalReason = finalDirection ? reasonFor(finalDirection) : `WAIT: ${waitReason ?? "NO_ASIA_BREAKOUT"}.`;
  const crossedHigh = Boolean(trace && lastCandle && previousCandle && trace.asiaHigh !== null
    && lastCandle.close > trace.asiaHigh && previousCandle.close <= trace.asiaHigh);
  const crossedLow = Boolean(trace && lastCandle && previousCandle && trace.asiaLow !== null
    && lastCandle.close < trace.asiaLow && previousCandle.close >= trace.asiaLow);
  const trendConfirmed = Boolean(trace && (crossedHigh ? trace.bullTrend : crossedLow ? trace.bearTrend : false));
  const structureConfirmed = Boolean(trace && (crossedHigh ? trace.bullStructure : crossedLow ? trace.bearStructure : false));
  const bodyConfirmed = Boolean(trace?.atr14 != null && trace.body >= trace.atr14 * EURUSD_STRATEGY_CONFIG.minimumBodyAtr);

  conditions.push(
    strategyCondition("Symbol", input.instrument === EURUSD_STRATEGY_SYMBOL, "EURUSD_STRATEGY V1 is restricted to EUR_USD.", input.instrument),
    strategyCondition("Timeframe", timeframe === EURUSD_STRATEGY_TIMEFRAME, "EURUSD_STRATEGY V1 evaluates completed H1 candles only.", timeframe),
    strategyCondition("Completed candle", Boolean(lastCandle), "A completed H1 candle is required.", lastCandle?.time ?? "unavailable"),
    strategyCondition("Asia range", Boolean(trace && trace.asiaHigh !== null && trace.asiaLow !== null), "The current UTC day's 00:00-06:00 Asia range must be complete.", trace ? `${trace.asiaLow ?? "unavailable"}-${trace.asiaHigh ?? "unavailable"}` : "unavailable"),
    strategyCondition("London window", Boolean(lastCandle && isLondonHour(new Date(lastCandle.time).getUTCHours())), "Signals are restricted to 06:00-11:00 UTC.", lastCandle?.time ?? "unavailable"),
    strategyCondition("Indicators", Boolean(trace && trace.ema20 !== null && trace.ema50 !== null && trace.atr14 !== null && trace.atr14 > 0), "EMA20, EMA50, and Wilder ATR14 must be available.", trace ? `${trace.ema20}/${trace.ema50}/${trace.atr14}` : "unavailable"),
    strategyCondition("Asia breakout cross", crossedHigh || crossedLow, "The close must cross the frozen Asia boundary on this candle.", crossedHigh ? "above" : crossedLow ? "below" : "none"),
    strategyCondition("EMA trend", trendConfirmed, "EMA20 must be above EMA50 for a long or below EMA50 for a short.", trace?.bullTrend ? "bull" : trace?.bearTrend ? "bear" : "flat"),
    strategyCondition("Simple structure", structureConfirmed, "Longs require a higher high and higher low; shorts require a lower high and lower low.", trace?.bullStructure ? "bull" : trace?.bearStructure ? "bear" : "none"),
    strategyCondition("Body strength", bodyConfirmed, "The signal candle body must be at least 0.35 ATR14.", trace?.atr14 ? `${(trace.body / trace.atr14).toFixed(4)} ATR` : "unavailable"),
    strategyCondition("Event edge", Boolean(trace?.evtA), "sigA must be non-zero after a zero sigA bar.", trace?.evtA ? "new event" : "none"),
    strategyCondition("No active position", !options.hasActivePosition, "Only one eurusd_strategy EUR_USD position may be active.", options.hasActivePosition ? "active" : "clear"),
    strategyCondition("Numerical safety", finalDirection ? numericalSafety : true, "Entry, ATR, indicators, range, stop, and target must be finite and correctly ordered.", finalDirection ? (numericalSafety ? "valid" : "invalid") : "not applicable"),
  );

  const signalKey = finalDirection && trace ? `${EURUSD_STRATEGY_ID}:${EURUSD_STRATEGY_SYMBOL}:${trace.timestamp}` : null;
  const features: EurusdStrategyFeatures = {
    strategyId: EURUSD_STRATEGY_ID,
    strategyName: EURUSD_STRATEGY_NAME,
    strategyVersion: EURUSD_STRATEGY_VERSION,
    symbol: EURUSD_STRATEGY_SYMBOL,
    timeframe: EURUSD_STRATEGY_TIMEFRAME,
    session: "LONDON",
    setup: EURUSD_STRATEGY_SETUP,
    signalDirection: finalDirection === "long" ? "LONG" : finalDirection === "short" ? "SHORT" : null,
    entryReference: finalDirection ? entry : null,
    stopATR: EURUSD_STRATEGY_CONFIG.stopAtr,
    rewardR: EURUSD_STRATEGY_CONFIG.rewardR,
    atr14: trace?.atr14 ?? null,
    ema20: trace?.ema20 ?? null,
    ema50: trace?.ema50 ?? null,
    asiaHigh: trace?.asiaHigh ?? null,
    asiaLow: trace?.asiaLow ?? null,
    signalCandleTimestamp: trace?.timestamp ?? null,
    body: trace?.body ?? null,
    bullTrend: trace?.bullTrend ?? false,
    bearTrend: trace?.bearTrend ?? false,
    bullStructure: trace?.bullStructure ?? false,
    bearStructure: trace?.bearStructure ?? false,
    longSetup: trace?.longSetup ?? false,
    shortSetup: trace?.shortSetup ?? false,
    sigA: trace?.sigA ?? 0,
    evtA: trace?.evtA ?? false,
    reason: signalReason,
    waitReason,
    signalKey,
  };
  const commonFeatures = {
    trend15m: "mixed" as const,
    trend1h: trace?.bullTrend ? "bullish" as const : trace?.bearTrend ? "bearish" as const : "mixed" as const,
    trend4h: null,
    ema21: null,
    ema50: trace?.ema50 ?? null,
    ema200: null,
    rsi14: null,
    atr14: trace?.atr14 ?? null,
    atrPips: trace?.atr14 == null ? null : trace.atr14 / 0.0001,
    structureHighs: trace?.bullStructure ? 1 : 0,
    structureLows: trace?.bearStructure ? 1 : 0,
    evaluationMode: input.evaluationMode ?? "live" as const,
    eurusdStrategy: features,
  };
  const regime = emptyRegime(signalCloseTime, trace);
  const finalEntry = finalDirection ? entry : null;
  const finalStop = finalDirection ? stop : null;
  const finalTarget = finalDirection ? target : null;
  return {
    family: EURUSD_STRATEGY_ID,
    version: EURUSD_STRATEGY_VERSION,
    configVersion: EURUSD_STRATEGY_CONFIG_VERSION,
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
    riskReward: finalDirection ? EURUSD_STRATEGY_CONFIG.rewardR : null,
    positionSize: null,
    features: commonFeatures,
    summary: finalDirection ? signalReason : `${displayNameFor(input.instrument)} ${signalReason}`,
    passedConditions: conditions.filter((item) => item.passed),
    failedConditions: conditions.filter((item) => !item.passed),
    conditions,
    evaluatedAt: signalCloseTime,
    dataSource: input.dataSource,
  };
}

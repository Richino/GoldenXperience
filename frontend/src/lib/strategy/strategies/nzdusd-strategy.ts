import { displayNameFor, pipSizeFor } from "@/lib/instruments/catalog";
import { calculateAtrValues } from "@/lib/strategy/indicators";
import { completedCandles, evaluateHardGates } from "@/lib/strategy/strategy-common";
import type { StrategyCandidate } from "@/lib/strategy/strategy";
import type {
  MarketRegime, NzdusdStrategyFeatures, PairStrategyId, StrategyCondition, StrategyEvaluationInput,
} from "@/lib/strategy/types";
import type { Candle } from "@/types/forex";

/**
 * Frozen NZDUSD Pre-Range Breakout V1. The supplied Pine v6 strategy is the
 * executable reference. Any rule or threshold change requires a new version.
 */
export const NZDUSD_STRATEGY_ID = "nzdusd_strategy" as const;
export const NZDUSD_STRATEGY_NAME = "NZDUSD Pre-Range Breakout V1" as const;
export const NZDUSD_STRATEGY_VERSION = "NZDUSD_PRE_RANGE_BREAKOUT_V1" as const;
export const NZDUSD_STRATEGY_CONFIG_VERSION = "nzdusd-strategy-cfg-v1" as const;
export const NZDUSD_STRATEGY_SYMBOL = "NZD_USD" as const;
export const NZDUSD_STRATEGY_TIMEFRAME = "H1" as const;
export const NZDUSD_STRATEGY_ORIGIN = "11:00 UTC" as const;

export const NZDUSD_EMA_FAST = 20;
export const NZDUSD_EMA_SLOW = 50;
export const NZDUSD_ATR_LENGTH = 14;
export const NZDUSD_PRE_RANGE_START_UTC = 6;
export const NZDUSD_PRE_RANGE_END_UTC = 10;
export const NZDUSD_SIGNAL_ORIGIN_UTC = 11;
export const NZDUSD_BODY_ATR_MIN = 0.50;
export const NZDUSD_STOP_ATR_MULTIPLIER = 1.0;
export const NZDUSD_REWARD_R = 2.0;
export const NZDUSD_MAX_HOLD_BARS = 3;

export const NZDUSD_STRATEGY_CONFIG = Object.freeze({
  symbol: NZDUSD_STRATEGY_SYMBOL,
  timeframe: NZDUSD_STRATEGY_TIMEFRAME,
  emaFastPeriod: NZDUSD_EMA_FAST,
  emaSlowPeriod: NZDUSD_EMA_SLOW,
  atrPeriod: NZDUSD_ATR_LENGTH,
  preRangeStartUtcHour: NZDUSD_PRE_RANGE_START_UTC,
  preRangeEndUtcHour: NZDUSD_PRE_RANGE_END_UTC,
  signalOriginUtcHour: NZDUSD_SIGNAL_ORIGIN_UTC,
  stopAtr: NZDUSD_STOP_ATR_MULTIPLIER,
  rewardR: NZDUSD_REWARD_R,
  maxHoldBars: NZDUSD_MAX_HOLD_BARS,
  bodyAtrMinimum: NZDUSD_BODY_ATR_MIN,
  confidenceTagOnly: true,
  executionEnabled: true,
  adaptiveParametersMutable: false,
});

export type NzdusdDirection = "LONG" | "SHORT" | "WAIT";

export type NzdusdStrategyWaitReason =
  | "WRONG_SYMBOL"
  | "WRONG_TIMEFRAME"
  | "NOT_1100_UTC"
  | "ORIGIN_NOT_COMPLETE"
  | "MALFORMED_CANDLES"
  | "MISSING_0600_CANDLE"
  | "MISSING_0700_CANDLE"
  | "MISSING_0800_CANDLE"
  | "MISSING_0900_CANDLE"
  | "MISSING_1000_CANDLE"
  | "EMA20_UNAVAILABLE"
  | "EMA50_UNAVAILABLE"
  | "ATR14_UNAVAILABLE"
  | "ATR_INVALID"
  | "EMA_DIRECTION_NEUTRAL"
  | "LONG_BREAKOUT_FAILED"
  | "SHORT_BREAKOUT_FAILED"
  | "DUPLICATE_SIGNAL"
  | "POSITION_ALREADY_OPEN"
  | "NUMERICAL_SAFETY";

export interface NzdusdStrategyTraceRow {
  timestamp: string;
  signalTimeUtc: string;
  signalKey: string;
  signalClose: number;
  missingRangeHours: number[];
  preRangeHigh: number | null;
  preRangeLow: number | null;
  ema20: number | null;
  ema50: number | null;
  atr14: number | null;
  direction: NzdusdDirection;
  candleBody: number;
  bodyAtrRatio: number | null;
  confidenceTag: "NZDUSD_BODY" | "NZDUSD_BASE";
  longBreakout: boolean;
  shortBreakout: boolean;
  finalLongSignal: boolean;
  finalShortSignal: boolean;
  stopLoss: number | null;
  takeProfit: number | null;
  expirationTimeUtc: string;
}

export interface NzdusdStrategyEvaluationOptions {
  timeframe?: string;
  hasActivePosition?: boolean;
  duplicateSignal?: boolean;
  onDebug?: (features: NzdusdStrategyFeatures) => void;
}

function finite(value: number) {
  return Number.isFinite(value);
}

function finitePositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validCandle(candle: Candle) {
  return Number.isFinite(Date.parse(candle.time))
    && finite(candle.open) && finite(candle.high) && finite(candle.low) && finite(candle.close)
    && candle.high >= Math.max(candle.open, candle.close)
    && candle.low <= Math.min(candle.open, candle.close)
    && candle.high >= candle.low;
}

function sameCandle(left: Candle, right: Candle) {
  return left.open === right.open && left.high === right.high && left.low === right.low
    && left.close === right.close && left.complete === right.complete;
}

function isExactH1Start(date: Date) {
  return date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
}

function utcDay(timestamp: string) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** Pine ta.ema recurrence: the first completed source value seeds the EMA. */
export function calculateNzdusdEmaValues(closes: readonly number[], period: number) {
  const alpha = 2 / (period + 1);
  let previous: number | null = null;
  return closes.map((close) => {
    previous = previous === null ? close : alpha * close + (1 - alpha) * previous;
    return previous;
  });
}

export function nzdusdDirection(ema20: number, ema50: number): NzdusdDirection {
  return ema20 > ema50 ? "LONG" : ema20 < ema50 ? "SHORT" : "WAIT";
}

export function nzdusdTradeGeometry(entry: number, entryATR: number, direction: "long" | "short") {
  const risk = entryATR * NZDUSD_STOP_ATR_MULTIPLIER;
  return direction === "long"
    ? { stopLoss: entry - risk, takeProfit: entry + risk * NZDUSD_REWARD_R }
    : { stopLoss: entry + risk, takeProfit: entry - risk * NZDUSD_REWARD_R };
}

/** Completed H1 bars only, sorted ascending; conflicting duplicates fail closed. */
export function normalizeNzdusdH1Candles(candles: readonly Candle[]) {
  const completed = candles.filter((candle) => candle.complete);
  if (completed.some((candle) => !validCandle(candle))) {
    return { candles: [] as Candle[], error: "Completed H1 history contains a malformed candle." };
  }
  const sorted = [...completed].sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  const unique: Candle[] = [];
  for (const candle of sorted) {
    const prior = unique.at(-1);
    if (!prior || Date.parse(prior.time) !== Date.parse(candle.time)) unique.push(candle);
    else if (!sameCandle(prior, candle)) {
      return { candles: [] as Candle[], error: `Conflicting H1 candles share timestamp ${candle.time}.` };
    }
  }
  return { candles: unique, error: null as string | null };
}

/**
 * Causal trace over completed H1 candles. OANDA timestamps are candle starts;
 * the completed 11:00 origin becomes actionable at 12:00 UTC.
 */
export function evaluateNzdusdStrategyTrace(candles: readonly Candle[]): { rows: NzdusdStrategyTraceRow[]; error: string | null } {
  const normalized = normalizeNzdusdH1Candles(candles);
  if (normalized.error) return { rows: [], error: normalized.error };
  const values = normalized.candles;
  const ema20Values = calculateNzdusdEmaValues(values.map((candle) => candle.close), NZDUSD_EMA_FAST);
  const ema50Values = calculateNzdusdEmaValues(values.map((candle) => candle.close), NZDUSD_EMA_SLOW);
  const atr14Values = calculateAtrValues(values, NZDUSD_ATR_LENGTH);
  const rows: NzdusdStrategyTraceRow[] = [];
  let currentDay: string | null = null;
  let dayBars = new Map<number, Candle>();

  for (let index = 0; index < values.length; index += 1) {
    const candle = values[index]!;
    const date = new Date(candle.time);
    const day = utcDay(candle.time);
    if (day !== currentDay) {
      currentDay = day;
      dayBars = new Map();
    }
    const exactH1 = isExactH1Start(date);
    if (exactH1) dayBars.set(date.getUTCHours(), candle);
    const rangeHours = [6, 7, 8, 9, 10] as const;
    const missingRangeHours = rangeHours.filter((hour) => !dayBars.has(hour));
    const rangeBars = rangeHours.map((hour) => dayBars.get(hour)).filter((bar): bar is Candle => Boolean(bar));
    const preRangeHigh = missingRangeHours.length ? null : Math.max(...rangeBars.map((bar) => bar.high));
    const preRangeLow = missingRangeHours.length ? null : Math.min(...rangeBars.map((bar) => bar.low));
    const ema20 = ema20Values[index] ?? null;
    const ema50 = ema50Values[index] ?? null;
    const atr14 = atr14Values[index] ?? null;
    const direction = ema20 === null || ema50 === null ? "WAIT" : nzdusdDirection(ema20, ema50);
    const candleBody = Math.abs(candle.close - candle.open);
    const bodyAtrRatio = atr14 !== null && atr14 > 0 ? candleBody / atr14 : null;
    const confidenceTag = bodyAtrRatio !== null && bodyAtrRatio >= NZDUSD_BODY_ATR_MIN
      ? "NZDUSD_BODY" as const : "NZDUSD_BASE" as const;
    const validOrigin = exactH1 && date.getUTCHours() === NZDUSD_SIGNAL_ORIGIN_UTC
      && missingRangeHours.length === 0 && ema20 !== null && ema50 !== null
      && atr14 !== null && finite(atr14) && atr14 > 0;
    const longBreakout = Boolean(validOrigin && direction === "LONG" && candle.close > preRangeHigh!);
    const shortBreakout = Boolean(validOrigin && direction === "SHORT" && candle.close < preRangeLow!);
    const finalLongSignal = longBreakout;
    const finalShortSignal = shortBreakout;
    const signalDirection = finalLongSignal ? "long" as const : finalShortSignal ? "short" as const : null;
    const geometry = signalDirection && atr14 !== null ? nzdusdTradeGeometry(candle.close, atr14, signalDirection) : null;
    const signalTimeUtc = new Date(Date.parse(candle.time) + 60 * 60_000).toISOString();

    rows.push({
      timestamp: candle.time,
      signalTimeUtc,
      signalKey: `NZDUSD-${day}-1100`,
      signalClose: candle.close,
      missingRangeHours: [...missingRangeHours],
      preRangeHigh,
      preRangeLow,
      ema20,
      ema50,
      atr14,
      direction,
      candleBody,
      bodyAtrRatio,
      confidenceTag,
      longBreakout,
      shortBreakout,
      finalLongSignal,
      finalShortSignal,
      stopLoss: geometry?.stopLoss ?? null,
      takeProfit: geometry?.takeProfit ?? null,
      expirationTimeUtc: new Date(Date.parse(signalTimeUtc) + NZDUSD_MAX_HOLD_BARS * 60 * 60_000).toISOString(),
    });
  }
  return { rows, error: null };
}

function condition(name: string, passed: boolean, reason: string, currentValue: string): StrategyCondition {
  return { name, passed, required: true, reason, currentValue };
}

function missingReason(hour: number): NzdusdStrategyWaitReason {
  return `MISSING_${String(hour).padStart(2, "0")}00_CANDLE` as NzdusdStrategyWaitReason;
}

function waitReasonFor(trace: NzdusdStrategyTraceRow, candle: Candle): NzdusdStrategyWaitReason | null {
  const date = new Date(candle.time);
  if (!isExactH1Start(date) || date.getUTCHours() !== NZDUSD_SIGNAL_ORIGIN_UTC) return "NOT_1100_UTC";
  if (trace.missingRangeHours.length) return missingReason(trace.missingRangeHours[0]!);
  if (trace.ema20 === null) return "EMA20_UNAVAILABLE";
  if (trace.ema50 === null) return "EMA50_UNAVAILABLE";
  if (trace.atr14 === null) return "ATR14_UNAVAILABLE";
  if (!finite(trace.atr14) || !(trace.atr14 > 0)) return "ATR_INVALID";
  if (trace.direction === "WAIT") return "EMA_DIRECTION_NEUTRAL";
  if (trace.direction === "LONG" && !trace.longBreakout) return "LONG_BREAKOUT_FAILED";
  if (trace.direction === "SHORT" && !trace.shortBreakout) return "SHORT_BREAKOUT_FAILED";
  return null;
}

function emptyRegime(evaluatedAt: string, trace: NzdusdStrategyTraceRow | undefined): MarketRegime {
  const pip = pipSizeFor(NZDUSD_STRATEGY_SYMBOL);
  return {
    regime: "mixed",
    trendDirection: trace?.direction === "LONG" ? "up" : trace?.direction === "SHORT" ? "down" : "none",
    trendStrength: 0,
    volatility: "normal",
    atr: trace?.atr14 ?? null,
    atrPips: trace?.atr14 == null ? null : trace.atr14 / pip,
    momentumState: "steady",
    emaFast: trace?.ema20 ?? null,
    emaMid: trace?.ema50 ?? null,
    emaSlow: null,
    slopeAtrPerBar: null,
    rangeHigh: trace?.preRangeHigh ?? null,
    rangeLow: trace?.preRangeLow ?? null,
    rangeWidthAtr: trace?.atr14 && trace.preRangeHigh !== null && trace.preRangeLow !== null
      ? (trace.preRangeHigh - trace.preRangeLow) / trace.atr14 : null,
    rangeAgeBars: null,
    lookbackBars: NZDUSD_EMA_SLOW,
    evaluatedAt,
  };
}

/** Evaluate only the latest completed 11:00 UTC H1 origin. */
export function evaluateNzdusdStrategy(
  input: StrategyEvaluationInput,
  options: NzdusdStrategyEvaluationOptions = {},
): StrategyCandidate<PairStrategyId> {
  const timeframe = options.timeframe ?? NZDUSD_STRATEGY_TIMEFRAME;
  const normalized = normalizeNzdusdH1Candles(input.candles1h);
  const traced = normalized.error ? { rows: [] as NzdusdStrategyTraceRow[], error: normalized.error }
    : evaluateNzdusdStrategyTrace(normalized.candles);
  const lastCandle = normalized.candles.at(-1);
  const trace = traced.rows.at(-1);
  const rawLatest = [...input.candles1h].sort((left, right) => Date.parse(left.time) - Date.parse(right.time)).at(-1);
  const formingOrigin = Boolean(rawLatest && !rawLatest.complete && isExactH1Start(new Date(rawLatest.time))
    && new Date(rawLatest.time).getUTCHours() === NZDUSD_SIGNAL_ORIGIN_UTC);
  const evaluatedAt = trace?.signalTimeUtc ?? input.evaluatedAt ?? new Date(0).toISOString();
  const executionGates = evaluateHardGates(
    input, evaluatedAt, completedCandles(input.candles15m), normalized.candles, completedCandles(input.candles4h),
  );
  let waitReason: NzdusdStrategyWaitReason | null = null;

  if (input.instrument !== NZDUSD_STRATEGY_SYMBOL) waitReason = "WRONG_SYMBOL";
  else if (timeframe !== NZDUSD_STRATEGY_TIMEFRAME) waitReason = "WRONG_TIMEFRAME";
  else if (formingOrigin) waitReason = "ORIGIN_NOT_COMPLETE";
  else if (normalized.error || traced.error) waitReason = "MALFORMED_CANDLES";
  else if (!lastCandle || !trace) waitReason = "ORIGIN_NOT_COMPLETE";
  else waitReason = waitReasonFor(trace, lastCandle);
  if (waitReason === null && options.duplicateSignal) waitReason = "DUPLICATE_SIGNAL";
  if (waitReason === null && options.hasActivePosition) waitReason = "POSITION_ALREADY_OPEN";

  const rawDirection = waitReason === null && trace
    ? trace.finalLongSignal ? "long" as const : trace.finalShortSignal ? "short" as const : null
    : null;
  const executionEntry = rawDirection === "long"
    ? (finitePositive(input.ask) ? input.ask : trace?.signalClose ?? null)
    : rawDirection === "short"
      ? (finitePositive(input.bid) ? input.bid : trace?.signalClose ?? null)
      : null;
  const geometry = executionEntry !== null && trace?.atr14 != null && rawDirection
    ? nzdusdTradeGeometry(executionEntry, trace.atr14, rawDirection) : null;
  const stop = geometry?.stopLoss ?? null;
  const target = geometry?.takeProfit ?? null;
  const numericalSafety = rawDirection !== null && finitePositive(executionEntry) && finitePositive(trace?.atr14)
    && finitePositive(stop) && finitePositive(target)
    && (rawDirection === "long" ? stop < executionEntry && executionEntry < target : target < executionEntry && executionEntry < stop);
  if (rawDirection && !numericalSafety) waitReason = "NUMERICAL_SAFETY";
  const direction = waitReason === null && numericalSafety ? rawDirection : null;
  const signalReason = direction === "long"
    ? "NZDUSD LONG: EMA20 is above EMA50 and the completed 11:00 UTC close is strictly above the 06:00-10:00 range."
    : direction === "short"
      ? "NZDUSD SHORT: EMA20 is below EMA50 and the completed 11:00 UTC close is strictly below the 06:00-10:00 range."
      : `WAIT: ${waitReason ?? "LONG_BREAKOUT_FAILED"}.`;

  const features: NzdusdStrategyFeatures = {
    strategyId: NZDUSD_STRATEGY_ID,
    strategyName: NZDUSD_STRATEGY_NAME,
    strategyVersion: NZDUSD_STRATEGY_VERSION,
    symbol: NZDUSD_STRATEGY_SYMBOL,
    timeframe: NZDUSD_STRATEGY_TIMEFRAME,
    origin: NZDUSD_STRATEGY_ORIGIN,
    signalKey: direction && trace ? trace.signalKey : null,
    direction: direction === "long" ? "LONG" : direction === "short" ? "SHORT" : null,
    signalCandleTimestamp: trace?.timestamp ?? null,
    signalTimeUtc: trace?.signalTimeUtc ?? null,
    entryTimeUtc: direction ? trace?.signalTimeUtc ?? null : null,
    signalClose: trace?.signalClose ?? null,
    executionEntry: direction ? executionEntry : null,
    actualEntry: null,
    actualBrokerFill: null,
    ema20: trace?.ema20 ?? null,
    ema50: trace?.ema50 ?? null,
    preRangeHigh: trace?.preRangeHigh ?? null,
    preRangeLow: trace?.preRangeLow ?? null,
    atr14: trace?.atr14 ?? null,
    entryATR: direction ? trace?.atr14 ?? null : null,
    candleBody: trace?.candleBody ?? null,
    bodyAtrRatio: trace?.bodyAtrRatio ?? null,
    confidenceTag: direction ? trace?.confidenceTag ?? null : null,
    stopLoss: direction ? stop : null,
    takeProfit: direction ? target : null,
    maximumHoldBars: NZDUSD_MAX_HOLD_BARS,
    expirationTimeUtc: direction ? trace?.expirationTimeUtc ?? null : null,
    actualExit: null,
    exitTimeUtc: null,
    exitReason: null,
    realizedPnL: null,
    realizedR: null,
    brokerOrderId: null,
    brokerTradeId: null,
    waitReason,
    blockReason: null,
  };
  options.onDebug?.(features);

  const conditions: StrategyCondition[] = [
    condition("Symbol", input.instrument === NZDUSD_STRATEGY_SYMBOL, "nzdusd_strategy is restricted to NZD_USD.", input.instrument),
    condition("Timeframe", timeframe === NZDUSD_STRATEGY_TIMEFRAME, "Only H1 candles are eligible.", timeframe),
    condition("Completed 11:00 UTC candle", Boolean(lastCandle && !formingOrigin && isExactH1Start(new Date(lastCandle.time)) && new Date(lastCandle.time).getUTCHours() === 11), "The completed H1 candle stamped 11:00 UTC is the sole origin.", formingOrigin ? "forming" : lastCandle?.time ?? "unavailable"),
    condition("06:00-10:00 UTC range", Boolean(trace && trace.missingRangeHours.length === 0), "All five exact pre-range candles are required and 11:00 is excluded.", trace?.missingRangeHours.length ? `missing ${trace.missingRangeHours.map((hour) => `${String(hour).padStart(2, "0")}:00`).join(", ")}` : "5/5"),
    condition("EMA20 available", trace?.ema20 != null, "EMA20 must be available from completed H1 closes.", trace?.ema20?.toString() ?? "unavailable"),
    condition("EMA50 available", trace?.ema50 != null, "EMA50 must be available from completed H1 closes.", trace?.ema50?.toString() ?? "unavailable"),
    condition("Wilder ATR14", Boolean(trace?.atr14 != null && finite(trace.atr14) && trace.atr14 > 0), "ATR14 must be finite and positive.", trace?.atr14?.toString() ?? "unavailable"),
    condition("EMA direction", Boolean(trace && trace.direction !== "WAIT"), "EMA20 above EMA50 is LONG; below is SHORT; equality is neutral.", trace?.direction ?? "WAIT"),
    condition("Strict close breakout", Boolean(trace?.longBreakout || trace?.shortBreakout), "The 11:00 close must be strictly outside the pre-range; wick-only and equality do not qualify.", trace?.longBreakout ? "LONG" : trace?.shortBreakout ? "SHORT" : "failed"),
    condition("No duplicate signal", !options.duplicateSignal, "The deterministic UTC-day signal key may execute only once.", options.duplicateSignal ? "duplicate" : "clear"),
    condition("No active strategy position", !options.hasActivePosition, "Pyramiding is disabled for nzdusd_strategy.", options.hasActivePosition ? "active" : "clear"),
    condition("Numerical safety", direction ? numericalSafety : true, "Entry, frozen ATR, stop, and target must be finite and ordered.", direction ? "valid" : "not applicable"),
  ];
  const allConditions = [...conditions, ...executionGates.conditions];
  return {
    family: NZDUSD_STRATEGY_ID,
    version: NZDUSD_STRATEGY_VERSION,
    configVersion: NZDUSD_STRATEGY_CONFIG_VERSION,
    regime: emptyRegime(evaluatedAt, trace),
    qualifyReason: signalReason,
    status: direction ? "valid" : waitReason === "MALFORMED_CANDLES" ? "invalid" : "no_setup",
    instrument: input.instrument,
    pair: displayNameFor(input.instrument),
    direction,
    timeframe: "1h",
    entry: direction ? executionEntry : null,
    stop: direction ? stop : null,
    target: direction ? target : null,
    riskReward: direction ? NZDUSD_REWARD_R : null,
    positionSize: null,
    features: {
      trend15m: "mixed",
      trend1h: trace?.direction === "LONG" ? "bullish" : trace?.direction === "SHORT" ? "bearish" : "mixed",
      trend4h: null,
      ema21: null,
      ema50: trace?.ema50 ?? null,
      ema200: null,
      rsi14: null,
      atr14: trace?.atr14 ?? null,
      atrPips: trace?.atr14 == null ? null : trace.atr14 / pipSizeFor(NZDUSD_STRATEGY_SYMBOL),
      structureHighs: 0,
      structureLows: 0,
      evaluationMode: input.evaluationMode ?? "live",
      newsStatus: executionGates.newsStatus,
      nzdusdStrategy: features,
    },
    summary: direction ? signalReason : `${displayNameFor(input.instrument)} ${signalReason}`,
    passedConditions: allConditions.filter((item) => item.passed),
    failedConditions: allConditions.filter((item) => !item.passed),
    conditions: allConditions,
    evaluatedAt,
    dataSource: input.dataSource,
  };
}

export interface NzdusdExitQuote {
  closeTime: string;
  bidHigh: number;
  bidLow: number;
  bidClose: number;
  askHigh: number;
  askLow: number;
  askClose: number;
}

export interface NzdusdExitResult {
  outcome: "target_first" | "stop_first" | "time_exit";
  exitReason: "TP" | "SL" | "TIME_EXIT";
  exit: number;
  resultR: number;
  resolvedAt: string;
  horizonEndsAt: string;
  barsHeld: number;
  maxFavorableR: number | null;
  maxAdverseR: number | null;
}

/** Exactly three contiguous future H1 bars; same-bar ambiguity resolves to SL. */
export function resolveNzdusdExit(input: {
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  decisionTime: string;
  quotes: readonly NzdusdExitQuote[];
  now: Date;
}): NzdusdExitResult | null {
  const decisionMs = Date.parse(input.decisionTime);
  const horizonMs = decisionMs + NZDUSD_MAX_HOLD_BARS * 60 * 60_000;
  const horizonEndsAt = new Date(horizonMs).toISOString();
  const risk = Math.abs(input.entry - input.stop);
  const geometryValid = input.direction === "long"
    ? input.stop < input.entry && input.entry < input.target
    : input.target < input.entry && input.entry < input.stop;
  if (!Number.isFinite(decisionMs) || !(risk > 0) || !geometryValid) return null;
  const quoteByClose = new Map(input.quotes.map((quote) => [Date.parse(quote.closeTime), quote]));
  let maxFavorableR: number | null = null;
  let maxAdverseR: number | null = null;

  for (let bar = 1; bar <= NZDUSD_MAX_HOLD_BARS; bar += 1) {
    const quoteMs = decisionMs + bar * 60 * 60_000;
    const quote = quoteByClose.get(quoteMs);
    if (!quote) return null;
    const favorable = input.direction === "long" ? (quote.bidHigh - input.entry) / risk : (input.entry - quote.askLow) / risk;
    const adverse = input.direction === "long" ? (input.entry - quote.bidLow) / risk : (quote.askHigh - input.entry) / risk;
    maxFavorableR = Math.max(maxFavorableR ?? favorable, favorable);
    maxAdverseR = Math.max(maxAdverseR ?? adverse, adverse);
    const targetHit = input.direction === "long" ? quote.bidHigh >= input.target : quote.askLow <= input.target;
    const stopHit = input.direction === "long" ? quote.bidLow <= input.stop : quote.askHigh >= input.stop;
    if (stopHit) {
      return { outcome: "stop_first", exitReason: "SL", exit: input.stop, resultR: -1, resolvedAt: quote.closeTime, horizonEndsAt, barsHeld: bar, maxFavorableR, maxAdverseR };
    }
    if (targetHit) {
      return { outcome: "target_first", exitReason: "TP", exit: input.target, resultR: NZDUSD_REWARD_R, resolvedAt: quote.closeTime, horizonEndsAt, barsHeld: bar, maxFavorableR, maxAdverseR };
    }
    if (bar === NZDUSD_MAX_HOLD_BARS) {
      if (input.now.getTime() < horizonMs) return null;
      const exit = input.direction === "long" ? quote.bidClose : quote.askClose;
      const resultR = input.direction === "long" ? (exit - input.entry) / risk : (input.entry - exit) / risk;
      return { outcome: "time_exit", exitReason: "TIME_EXIT", exit, resultR, resolvedAt: quote.closeTime, horizonEndsAt, barsHeld: bar, maxFavorableR, maxAdverseR };
    }
  }
  return null;
}

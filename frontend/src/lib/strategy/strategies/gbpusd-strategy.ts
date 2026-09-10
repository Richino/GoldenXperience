import { displayNameFor } from "@/lib/instruments/catalog";
import { calculateAtrValues } from "@/lib/strategy/indicators";
import { completedCandles, evaluateHardGates } from "@/lib/strategy/strategy-common";
import type { StrategyCandidate } from "@/lib/strategy/strategy";
import type {
  GbpusdStrategyFeatures, MarketRegime, PairStrategyId, StrategyCondition, StrategyEvaluationInput,
} from "@/lib/strategy/types";
import type { Candle } from "@/types/forex";

/**
 * GBPUSD Dual-Origin V2 — literal port of the frozen independent-leg Pine strategy.
 *
 * The constants below are frozen. A rule change requires a new version.
 */
export const GBPUSD_STRATEGY_ID = "gbpusd_strategy" as const;
export const GBPUSD_STRATEGY_NAME = "GBPUSD 30M Dual-Origin V2 Independent Legs" as const;
export const GBPUSD_STRATEGY_VERSION = "v2" as const;
export const GBPUSD_STRATEGY_CONFIG_VERSION = "gbpusd-dual-origin-v2" as const;
export const GBPUSD_STRATEGY_SYMBOL = "GBP_USD" as const;
export const GBPUSD_STRATEGY_TIMEFRAME = "M30" as const;

export const GBPUSD_EMA_FAST = 20;
export const GBPUSD_EMA_SLOW = 50;
export const GBPUSD_ATR_LENGTH = 14;
export const GBPUSD_STOP_ATR = 1.0;
export const GBPUSD_REWARD_R = 2.0;
export const GBPUSD_MAX_HOLD_BARS = 6;
export const GBPUSD_PENETRATION_ATR = 0.25;
export const GBPUSD_EXTREME_CLOSE_PCT = 0.25;

export const GBPUSD_ORIGINS = {
  "1030": { label: "10:30", hour: 10, minute: 30, expectedRangeBars: 9, directions: ["LONG", "SHORT"] },
  "1100": { label: "11:00", hour: 11, minute: 0, expectedRangeBars: 10, directions: ["LONG", "SHORT"] },
} as const;

export type GbpusdOriginCode = keyof typeof GBPUSD_ORIGINS;
export type GbpusdOrigin = (typeof GBPUSD_ORIGINS)[GbpusdOriginCode]["label"];
export type GbpusdSignalLabel =
  | "GBPUSD_1030_LONG" | "GBPUSD_1030_SHORT"
  | "GBPUSD_1100_LONG" | "GBPUSD_1100_SHORT";

export const GBPUSD_STRATEGY_CONFIG = Object.freeze({
  emaFastPeriod: GBPUSD_EMA_FAST,
  emaSlowPeriod: GBPUSD_EMA_SLOW,
  atrPeriod: GBPUSD_ATR_LENGTH,
  rangeStartUtc: "06:00",
  origins: GBPUSD_ORIGINS,
  stopAtr: GBPUSD_STOP_ATR,
  rewardR: GBPUSD_REWARD_R,
  maxHoldBars: GBPUSD_MAX_HOLD_BARS,
  penetrationAtr: GBPUSD_PENETRATION_ATR,
  extremeClosePct: GBPUSD_EXTREME_CLOSE_PCT,
});

export type GbpusdStrategyWaitReason =
  | "WRONG_SYMBOL"
  | "WRONG_TIMEFRAME"
  | "CANDLE_NOT_CLOSED"
  | "MALFORMED_CANDLES"
  | "WRONG_ORIGIN"
  | "MISSING_RANGE_BAR"
  | "INDICATORS_NOT_READY"
  | "EMA_NEUTRAL"
  | "DISABLED_LEG"
  | "NO_BREAKOUT"
  | "NUMERICAL_SAFETY";

export interface GbpusdStrategyTraceRow {
  timestamp: string;
  signalCloseTime: string;
  origin: GbpusdOrigin | null;
  originCode: GbpusdOriginCode | null;
  rangeBars: number;
  expectedRangeBars: number;
  rangeReady: boolean;
  preRangeHigh: number | null;
  preRangeLow: number | null;
  ema20: number | null;
  ema50: number | null;
  atr14: number | null;
  trend: "LONG" | "SHORT" | "WAIT";
  breakout: boolean;
  rawLongSignal: boolean;
  rawShortSignal: boolean;
  disabledShortSignal: boolean;
  penetration: number | null;
  extremeClose: boolean;
  confidenceTag: "BASE" | "PEN_EXTREME";
  signalLabel: GbpusdSignalLabel | null;
  signalKey: string | null;
  stop: number | null;
  target: number | null;
}
export interface GbpusdStrategyEvaluationOptions {
  timeframe?: string;
  onDebug?: (features: GbpusdStrategyFeatures) => void;
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

function exactM30Start(date: Date) {
  return (date.getUTCMinutes() === 0 || date.getUTCMinutes() === 30)
    && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
}

/** Completed M30 bars only, sorted ascending; ambiguous duplicates fail closed. */
export function normalizeGbpusdM30Candles(candles: readonly Candle[]): NormalizedCandles {
  const completed = candles.filter((candle) => candle.complete);
  if (!completed.length) return { candles: [], error: null };
  if (completed.some((candle) => !validCandle(candle) || !exactM30Start(new Date(candle.time)))) {
    return { candles: [], error: "Completed M30 history contains a malformed or misaligned candle." };
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
      return { candles: [], error: `Conflicting M30 candles share timestamp ${candle.time}.` };
    }
  }
  return { candles: unique, error: null };
}

/** Pine ta.ema-compatible recursion: the first source value seeds the EMA. */
export function calculateGbpusdPineEmaValues(closes: readonly number[], period: number) {
  const alpha = 2 / (period + 1);
  let previous: number | null = null;
  return closes.map((close) => {
    previous = previous === null ? close : alpha * close + (1 - alpha) * previous;
    return previous;
  });
}

function originFor(date: Date): GbpusdOriginCode | null {
  if (!exactM30Start(date)) return null;
  if (date.getUTCHours() === 10 && date.getUTCMinutes() === 30) return "1030";
  if (date.getUTCHours() === 11 && date.getUTCMinutes() === 0) return "1100";
  return null;
}

function utcDay(timestamp: string) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function expectedRangeStarts(day: string, origin: GbpusdOriginCode) {
  const count = GBPUSD_ORIGINS[origin].expectedRangeBars;
  const first = Date.parse(`${day}T06:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => first + index * 30 * 60_000);
}

/** Causal trace: each origin reconstructs its exact UTC slots from prior bars only. */
export function evaluateGbpusdStrategyTrace(candles: readonly Candle[]): { rows: GbpusdStrategyTraceRow[]; error: string | null } {
  const normalized = normalizeGbpusdM30Candles(candles);
  if (normalized.error) return { rows: [], error: normalized.error };
  const values = normalized.candles;
  const ema20Values = calculateGbpusdPineEmaValues(values.map((candle) => candle.close), GBPUSD_EMA_FAST);
  const ema50Values = calculateGbpusdPineEmaValues(values.map((candle) => candle.close), GBPUSD_EMA_SLOW);
  const atr14Values = calculateAtrValues(values, GBPUSD_ATR_LENGTH);
  const seen = new Map<number, Candle>();
  const rows: GbpusdStrategyTraceRow[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const candle = values[index]!;
    const date = new Date(candle.time);
    const originCode = originFor(date);
    const origin = originCode ? GBPUSD_ORIGINS[originCode].label : null;
    const expected = originCode ? expectedRangeStarts(utcDay(candle.time), originCode) : [];
    const range = expected.map((time) => seen.get(time)).filter((item): item is Candle => Boolean(item));
    const expectedRangeBars = originCode ? GBPUSD_ORIGINS[originCode].expectedRangeBars : 0;
    const rangeReady = originCode !== null && range.length === expectedRangeBars;
    const preRangeHigh = rangeReady ? Math.max(...range.map((item) => item.high)) : null;
    const preRangeLow = rangeReady ? Math.min(...range.map((item) => item.low)) : null;
    const ema20 = ema20Values[index] ?? null;
    const ema50 = ema50Values[index] ?? null;
    const atr14 = atr14Values[index] ?? null;
    const trend = ema20 === null || ema50 === null || ema20 === ema50
      ? "WAIT" as const : ema20 > ema50 ? "LONG" as const : "SHORT" as const;
    const validOrigin = originCode !== null && rangeReady && atr14 !== null && finite(atr14) && atr14 > 0
      && ema20 !== null && ema50 !== null && trend !== "WAIT";
    const rawLongSignal = Boolean(validOrigin && trend === "LONG" && candle.close > preRangeHigh!);
    const shortBreakout = Boolean(validOrigin && trend === "SHORT" && candle.close < preRangeLow!);
    const disabledShortSignal = false;
    const rawShortSignal = shortBreakout;
    const breakout = rawLongSignal || rawShortSignal;
    const penetration = rawLongSignal ? candle.close - preRangeHigh!
      : rawShortSignal ? preRangeLow! - candle.close : null;
    const candleRange = candle.high - candle.low;
    const extremeClose = rawLongSignal
      ? candle.close >= candle.high - candleRange * GBPUSD_EXTREME_CLOSE_PCT
      : rawShortSignal
        ? candle.close <= candle.low + candleRange * GBPUSD_EXTREME_CLOSE_PCT
        : false;
    const confidenceTag = penetration !== null && atr14 !== null
      && penetration >= atr14 * GBPUSD_PENETRATION_ATR && extremeClose
      ? "PEN_EXTREME" as const : "BASE" as const;
    const direction = rawLongSignal ? "LONG" as const : rawShortSignal ? "SHORT" as const : null;
    const signalLabel = direction && originCode ? `GBPUSD_${originCode}_${direction}` as GbpusdSignalLabel : null;
    const signalKey = direction && originCode ? `GBPUSD-${utcDay(candle.time)}-${originCode}` : null;
    const entry = direction ? candle.close : null;
    const stop = entry === null || atr14 === null ? null
      : direction === "LONG" ? entry - atr14 * GBPUSD_STOP_ATR : entry + atr14 * GBPUSD_STOP_ATR;
    const target = entry === null || atr14 === null ? null
      : direction === "LONG" ? entry + atr14 * GBPUSD_REWARD_R : entry - atr14 * GBPUSD_REWARD_R;

    rows.push({
      timestamp: candle.time,
      signalCloseTime: new Date(Date.parse(candle.time) + 30 * 60_000).toISOString(),
      origin, originCode, rangeBars: range.length, expectedRangeBars, rangeReady,
      preRangeHigh, preRangeLow, ema20, ema50, atr14, trend, breakout,
      rawLongSignal, rawShortSignal, disabledShortSignal, penetration, extremeClose, confidenceTag,
      signalLabel, signalKey, stop, target,
    });
    seen.set(Date.parse(candle.time), candle);
  }
  return { rows, error: null };
}

function condition(name: string, passed: boolean, reason: string, currentValue: string): StrategyCondition {
  return { name, passed, required: true, reason, currentValue };
}

function waitReasonFor(trace: GbpusdStrategyTraceRow): GbpusdStrategyWaitReason | null {
  if (!trace.originCode) return "WRONG_ORIGIN";
  if (!trace.rangeReady) return "MISSING_RANGE_BAR";
  if (trace.atr14 === null || trace.ema20 === null || trace.ema50 === null || !(trace.atr14 > 0)) return "INDICATORS_NOT_READY";
  if (trace.trend === "WAIT") return "EMA_NEUTRAL";
  if (trace.disabledShortSignal) return "DISABLED_LEG";
  if (!trace.breakout) return "NO_BREAKOUT";
  return null;
}

function emptyRegime(evaluatedAt: string, trace: GbpusdStrategyTraceRow | undefined): MarketRegime {
  return {
    regime: "mixed",
    trendDirection: trace?.trend === "LONG" ? "up" : trace?.trend === "SHORT" ? "down" : "none",
    trendStrength: 0,
    volatility: "normal",
    atr: trace?.atr14 ?? null,
    atrPips: trace?.atr14 == null ? null : trace.atr14 / 0.0001,
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
    lookbackBars: GBPUSD_EMA_SLOW,
    evaluatedAt,
  };
}

/** Evaluate only the latest completed M30 candle. */
export function evaluateGbpusdStrategy(
  input: StrategyEvaluationInput,
  options: GbpusdStrategyEvaluationOptions = {},
): StrategyCandidate<PairStrategyId> {
  const timeframe = options.timeframe ?? GBPUSD_STRATEGY_TIMEFRAME;
  const normalized = normalizeGbpusdM30Candles(input.candles30m ?? []);
  const traced = normalized.error ? { rows: [] as GbpusdStrategyTraceRow[], error: normalized.error }
    : evaluateGbpusdStrategyTrace(normalized.candles);
  const candle = normalized.candles.at(-1);
  const trace = traced.rows.at(-1);
  const signalCloseTime = trace?.signalCloseTime ?? input.evaluatedAt ?? new Date(0).toISOString();
  const executionGates = evaluateHardGates(
    input, signalCloseTime, completedCandles(input.candles15m),
    completedCandles(input.candles1h), completedCandles(input.candles4h),
  );
  let waitReason: GbpusdStrategyWaitReason | null = null;
  if (input.instrument !== GBPUSD_STRATEGY_SYMBOL) waitReason = "WRONG_SYMBOL";
  else if (timeframe !== GBPUSD_STRATEGY_TIMEFRAME) waitReason = "WRONG_TIMEFRAME";
  else if (normalized.error || traced.error) waitReason = "MALFORMED_CANDLES";
  else if (!candle || !trace) waitReason = "CANDLE_NOT_CLOSED";
  else waitReason = waitReasonFor(trace);

  const direction = waitReason === null && trace
    ? trace.rawLongSignal ? "long" as const : trace.rawShortSignal ? "short" as const : null
    : null;
  const entry = direction ? candle!.close : null;
  const stop = direction ? trace!.stop : null;
  const target = direction ? trace!.target : null;
  const numericalSafety = direction !== null && entry !== null && stop !== null && target !== null
    && trace?.atr14 !== null && [entry, stop, target, trace?.atr14].every((value) => typeof value === "number" && finite(value))
    && trace!.atr14! > 0
    && (direction === "long" ? stop < entry && entry < target : target < entry && entry < stop);
  if (direction && !numericalSafety) waitReason = "NUMERICAL_SAFETY";
  const finalDirection = waitReason === null && numericalSafety ? direction : null;
  const finalEntry = finalDirection ? entry : null;
  const finalStop = finalDirection ? stop : null;
  const finalTarget = finalDirection ? target : null;
  const plannedExpirationUtc = finalDirection
    ? new Date(Date.parse(signalCloseTime) + GBPUSD_MAX_HOLD_BARS * 30 * 60_000).toISOString() : null;
  const reason = finalDirection
    ? `${trace!.signalLabel}: ${finalDirection.toUpperCase()} close breakout in EMA20/EMA50 direction.`
    : `WAIT: ${waitReason ?? "NO_BREAKOUT"}.`;

  const features: GbpusdStrategyFeatures = {
    strategyId: GBPUSD_STRATEGY_ID,
    strategyName: GBPUSD_STRATEGY_NAME,
    strategyVersion: GBPUSD_STRATEGY_VERSION,
    symbol: GBPUSD_STRATEGY_SYMBOL,
    timeframe: GBPUSD_STRATEGY_TIMEFRAME,
    origin: trace?.origin ?? null,
    originCode: trace?.originCode ?? null,
    signalLabel: finalDirection ? trace?.signalLabel ?? null : null,
    signalTimeUtc: trace?.signalCloseTime ?? null,
    entryTimeUtc: finalDirection ? signalCloseTime : null,
    signalCandleTimestamp: trace?.timestamp ?? null,
    signalClose: finalDirection ? candle?.close ?? null : null,
    intendedEntry: finalEntry,
    actualEntry: null,
    bid: input.bid,
    ask: input.ask,
    spreadPips: input.spreadPips,
    slippage: null,
    ema20: trace?.ema20 ?? null,
    ema50: trace?.ema50 ?? null,
    atr14: trace?.atr14 ?? null,
    entryATR: finalDirection ? trace?.atr14 ?? null : null,
    preRangeHigh: trace?.preRangeHigh ?? null,
    preRangeLow: trace?.preRangeLow ?? null,
    rangeBars: trace?.rangeBars ?? 0,
    expectedRangeBars: trace?.expectedRangeBars ?? 0,
    rangeReady: trace?.rangeReady ?? false,
    breakoutDistance: finalDirection ? trace?.penetration ?? null : null,
    penetration: finalDirection ? trace?.penetration ?? null : null,
    extremeClose: trace?.extremeClose ?? false,
    confidenceTag: trace?.confidenceTag ?? "BASE",
    trend: trace?.trend ?? "WAIT",
    breakout: trace?.breakout ?? false,
    rawSignal: finalDirection !== null,
    signalCandle: candle ? { open: candle.open, high: candle.high, low: candle.low, close: candle.close } : null,
    stopLoss: finalStop,
    takeProfit: finalTarget,
    maxHoldBars: GBPUSD_MAX_HOLD_BARS,
    plannedExpirationUtc,
    actualExit: null,
    exitTimeUtc: null,
    exitReason: null,
    realizedPnL: null,
    realizedR: null,
    brokerOrderId: null,
    brokerTradeId: null,
    waitReason,
    signalKey: finalDirection ? trace?.signalKey ?? null : null,
  };
  options.onDebug?.(features);

  const conditions: StrategyCondition[] = [
    condition("Symbol", input.instrument === GBPUSD_STRATEGY_SYMBOL, "gbpusd_strategy is restricted to GBP_USD.", input.instrument),
    condition("Timeframe", timeframe === GBPUSD_STRATEGY_TIMEFRAME, "Only completed M30 candles are eligible.", timeframe),
    condition("Origin", Boolean(trace?.originCode), "Only completed 10:30 and 11:00 UTC origin candles may signal.", trace?.origin ?? "none"),
    condition("Enabled leg", true, "Both independent origins allow long and short legs.", "enabled"),
    condition("Causal pre-range", trace?.rangeReady ?? false, "Every exact 06:00-to-origin M30 slot is required and the origin candle is excluded.", trace ? `${trace.rangeBars}/${trace.expectedRangeBars}` : "0/0"),
    condition("EMA20 vs EMA50", Boolean(trace && trace.trend !== "WAIT"), "EMA20 must differ from EMA50.", trace?.trend ?? "WAIT"),
    condition("Wilder ATR14", Boolean(trace?.atr14 != null && trace.atr14 > 0), "ATR14 must be finite and positive at the origin close.", trace?.atr14?.toString() ?? "unavailable"),
    condition("Close breakout", trace?.breakout ?? false, "The origin close—not merely its wick—must clear the causal range in the EMA direction.", trace?.breakout ? trace.trend : "none"),
    condition("Numerical safety", finalDirection ? numericalSafety : true, "Entry, frozen ATR, stop, and target must be finite and ordered.", finalDirection ? (numericalSafety ? "valid" : "invalid") : "not applicable"),
  ];
  const allConditions = [...conditions, ...executionGates.conditions];
  const regime = emptyRegime(signalCloseTime, trace);
  return {
    family: GBPUSD_STRATEGY_ID,
    version: GBPUSD_STRATEGY_VERSION,
    configVersion: GBPUSD_STRATEGY_CONFIG_VERSION,
    regime,
    qualifyReason: reason,
    status: finalDirection ? "valid" : waitReason === "MALFORMED_CANDLES" ? "invalid" : "no_setup",
    instrument: input.instrument,
    pair: displayNameFor(input.instrument),
    direction: finalDirection,
    timeframe: "30m",
    entry: finalEntry,
    stop: finalStop,
    target: finalTarget,
    riskReward: finalDirection ? GBPUSD_REWARD_R : null,
    positionSize: null,
    features: {
      trend15m: "mixed",
      trend1h: null,
      trend4h: null,
      ema21: null,
      ema50: trace?.ema50 ?? null,
      ema200: null,
      rsi14: null,
      atr14: trace?.atr14 ?? null,
      atrPips: trace?.atr14 == null ? null : trace.atr14 / 0.0001,
      structureHighs: 0,
      structureLows: 0,
      evaluationMode: input.evaluationMode ?? "live",
      newsStatus: executionGates.newsStatus,
      gbpusdStrategy: features,
    },
    summary: finalDirection ? reason : `${displayNameFor(input.instrument)} ${reason}`,
    passedConditions: allConditions.filter((item) => item.passed),
    failedConditions: allConditions.filter((item) => !item.passed),
    conditions: allConditions,
    evaluatedAt: signalCloseTime,
    dataSource: input.dataSource,
  };
}

export interface GbpusdOpenLeg {
  strategyId: string | null;
  originCode: string | null;
  direction: "long" | "short";
}

export type GbpusdExecutionBlockReason =
  | "DUPLICATE_SIGNAL" | "BLOCKED_OPPOSITE_POSITION" | "GLOBAL_RISK_BLOCK";

/** Pure overlap verdict used by the durable collector and deterministic tests. */
export function gbpusdOverlapDecision(input: {
  originCode: GbpusdOriginCode;
  direction: "long" | "short";
  openLegs: readonly GbpusdOpenLeg[];
  hedgingEnabled: boolean;
}): { allowed: boolean; blockReason: GbpusdExecutionBlockReason | null } {
  if (input.openLegs.some((leg) => leg.strategyId !== GBPUSD_STRATEGY_ID)) {
    return { allowed: false, blockReason: "GLOBAL_RISK_BLOCK" };
  }
  if (input.openLegs.some((leg) => leg.originCode === input.originCode)) {
    return { allowed: false, blockReason: "DUPLICATE_SIGNAL" };
  }
  const opposite = input.openLegs.some((leg) => leg.direction !== input.direction);
  if (opposite && !input.hedgingEnabled) {
    return { allowed: false, blockReason: "BLOCKED_OPPOSITE_POSITION" };
  }
  return { allowed: true, blockReason: null };
}

export interface GbpusdExitQuote {
  closeTime: string;
  bidHigh: number;
  bidLow: number;
  bidClose: number;
  askHigh: number;
  askLow: number;
  askClose: number;
}

export interface GbpusdExitResult {
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

/** Six future completed M30 bars; same-bar TP/SL ambiguity resolves to SL. */
export function resolveGbpusdExit(input: {
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  decisionTime: string;
  quotes: readonly GbpusdExitQuote[];
  now: Date;
}): GbpusdExitResult | null {
  const decisionMs = Date.parse(input.decisionTime);
  const barMs = 30 * 60_000;
  const horizonMs = decisionMs + GBPUSD_MAX_HOLD_BARS * barMs;
  const horizonEndsAt = new Date(horizonMs).toISOString();
  const risk = Math.abs(input.entry - input.stop);
  if (!Number.isFinite(decisionMs) || !(risk > 0)) return null;
  let maxFavorableR: number | null = null;
  let maxAdverseR: number | null = null;
  let horizonQuote: GbpusdExitQuote | null = null;
  const quotesBySlot = new Map<number, GbpusdExitQuote>();
  for (const quote of input.quotes) {
    const quoteMs = Date.parse(quote.closeTime);
    if (!(quoteMs > decisionMs) || quoteMs > horizonMs || (quoteMs - decisionMs) % barMs !== 0) continue;
    const values = [quote.bidHigh, quote.bidLow, quote.bidClose, quote.askHigh, quote.askLow, quote.askClose];
    if (!values.every(Number.isFinite)) continue;
    quotesBySlot.set((quoteMs - decisionMs) / barMs, quote);
  }
  let contiguousBars = 0;
  for (let slot = 1; slot <= GBPUSD_MAX_HOLD_BARS; slot += 1) {
    const quote = quotesBySlot.get(slot);
    if (!quote) break;
    contiguousBars = slot;
    if (slot === GBPUSD_MAX_HOLD_BARS) horizonQuote = quote;
    const favorable = input.direction === "long" ? (quote.bidHigh - input.entry) / risk : (input.entry - quote.askLow) / risk;
    const adverse = input.direction === "long" ? (input.entry - quote.bidLow) / risk : (quote.askHigh - input.entry) / risk;
    maxFavorableR = Math.max(maxFavorableR ?? favorable, favorable);
    maxAdverseR = Math.max(maxAdverseR ?? adverse, adverse);
    const targetHit = input.direction === "long" ? quote.bidHigh >= input.target : quote.askLow <= input.target;
    const stopHit = input.direction === "long" ? quote.bidLow <= input.stop : quote.askHigh >= input.stop;
    if (stopHit) {
      return { outcome: "stop_first", exitReason: "SL", exit: input.stop, resultR: -1, resolvedAt: quote.closeTime, horizonEndsAt, barsHeld: slot, maxFavorableR, maxAdverseR };
    }
    if (targetHit) {
      return { outcome: "target_first", exitReason: "TP", exit: input.target, resultR: Math.abs(input.target - input.entry) / risk, resolvedAt: quote.closeTime, horizonEndsAt, barsHeld: slot, maxFavorableR, maxAdverseR };
    }
  }
  if (input.now.getTime() < horizonMs || contiguousBars !== GBPUSD_MAX_HOLD_BARS || !horizonQuote) return null;
  const exit = input.direction === "long" ? horizonQuote.bidClose : horizonQuote.askClose;
  const resultR = input.direction === "long" ? (exit - input.entry) / risk : (input.entry - exit) / risk;
  return {
    outcome: "time_exit", exitReason: "TIME_EXIT", exit, resultR,
    resolvedAt: horizonQuote.closeTime, horizonEndsAt, barsHeld: GBPUSD_MAX_HOLD_BARS,
    maxFavorableR, maxAdverseR,
  };
}

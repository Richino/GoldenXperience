import { displayNameFor, pipSizeFor } from "@/lib/instruments/catalog";
import { calculateAtrValues, calculateEmaValues } from "@/lib/strategy/indicators";
import { resolveFrozenH1Exit, type FrozenH1ExitInput } from "@/lib/strategy/strategies/frozen-h1-pair";
import type { StrategyCandidate } from "@/lib/strategy/strategy";
import type { MarketRegime, NzdjpyStrategyFeatures, StrategyCondition, StrategyEvaluationInput } from "@/lib/strategy/types";
import type { Candle } from "@/types/forex";
export const NZDJPY_STRATEGY_ID = "nzdjpy_strategy" as const;
export const NZDJPY_STRATEGY_NAME = "NZDJPY 23UTC Bull Break V1" as const;
export const NZDJPY_STRATEGY_VERSION = "V1" as const;
export const NZDJPY_STRATEGY_CONFIG_VERSION = "nzdjpy-v1-frozen" as const;
export const NZDJPY_STRATEGY_SYMBOL = "NZD_JPY" as const;
export const NZDJPY_STRATEGY_TIMEFRAME = "H1" as const;
export const NZDJPY_STRATEGY_CONFIG = Object.freeze({ symbol: NZDJPY_STRATEGY_SYMBOL, timeframe: NZDJPY_STRATEGY_TIMEFRAME, originHourUtc: 23, direction: "LONG_ONLY", emaFastPeriod: 20, emaSlowPeriod: 50, atrPeriod: 14, consensus: ">= +3", previousHighBreak: true, previousHighBreakClearanceAtr: .1, bodyAtrMinimum: .5, upperClosePct: .25, stopAtr: 1, rewardR: 2, maxHoldBars: 3, executionEnabled: true, adaptiveParametersMutable: false });

export interface NzdjpyPineEvaluation {
  originTime: string | null;
  signalMidClose: number | null;
  ema20: number | null;
  ema50: number | null;
  atr14: number | null;
  voteTrend: -1 | 0 | 1 | null;
  votePrice: -1 | 0 | 1 | null;
  voteSlope: -1 | 0 | 1 | null;
  voteMomentum: -1 | 0 | 1 | null;
  consensus: number | null;
  bullBody: boolean;
  bodyR: number | null;
  closeLocation: number | null;
  previousHigh: number | null;
  breakDistanceR: number | null;
  pineReferenceStop: number | null;
  pineReferenceTarget: number | null;
  strategySignalQualified: boolean;
}

export interface NzdjpyStrategyEvaluationOptions {
  timeframe?: string;
  hasActivePosition?: boolean;
  duplicateSignal?: boolean;
}

const vote = (left: number, right: number): -1 | 0 | 1 => left > right ? 1 : left < right ? -1 : 0;
const exactH1 = (value: Date) => value.getUTCMinutes() === 0 && value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0;
const finite = (value: number | null) => value !== null && Number.isFinite(value);
const strategyCondition = (name: string, passed: boolean, reason: string, currentValue: string, required = true): StrategyCondition => ({ name, passed, reason, currentValue, required });

function completedUniqueH1(candles: readonly Candle[]): Candle[] {
  const byTime = new Map<string, Candle>();
  for (const candle of candles) {
    if (!candle.complete || !Number.isFinite(Date.parse(candle.time))) continue;
    // A conflicting duplicate is malformed input, so retaining neither would be
    // preferable; the runtime data path already prevents this upstream. Keeping
    // the first makes this pure evaluator deterministic for diagnostics.
    if (!byTime.has(candle.time)) byTime.set(candle.time, candle);
  }
  return [...byTime.values()].sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
}

/**
 * Exact Pine signal evaluator. It has no session, news, spread, portfolio,
 * duplicate, or broker-price policy: those are execution concerns.
 */
export function evaluateNzdjpy23UtcBullBreakV1(candlesInput: readonly Candle[]): NzdjpyPineEvaluation {
  const candles = completedUniqueH1(candlesInput);
  const current = candles.at(-1);
  const index = candles.length - 1;
  const previous = candles.at(-2);
  const threeBack = candles.at(-4);
  const ema20 = index >= 0 ? calculateEmaValues(candles.map((candle) => candle.close), 20)[index] ?? null : null;
  const ema50 = index >= 0 ? calculateEmaValues(candles.map((candle) => candle.close), 50)[index] ?? null : null;
  const ema20Back = index >= 3 ? calculateEmaValues(candles.map((candle) => candle.close), 20)[index - 3] ?? null : null;
  const atr14 = index >= 0 ? calculateAtrValues(candles, 14)[index] ?? null : null;
  const origin = Boolean(current && exactH1(new Date(current.time)) && new Date(current.time).getUTCHours() === 23);
  const ready = Boolean(current && previous && threeBack && finite(ema20) && finite(ema50) && finite(ema20Back) && finite(atr14) && atr14! > 0);

  const voteTrend = ready ? vote(ema20!, ema50!) : null;
  const votePrice = ready ? vote(current!.close, ema20!) : null;
  const voteSlope = ready ? vote(ema20!, ema20Back!) : null;
  const voteMomentum = ready ? vote(current!.close, threeBack!.close) : null;
  const consensus = voteTrend === null || votePrice === null || voteSlope === null || voteMomentum === null
    ? null : voteTrend + votePrice + voteSlope + voteMomentum;
  const body = current ? Math.abs(current.close - current.open) : null;
  const candleRange = current ? current.high - current.low : null;
  const bullBody = Boolean(current && current.close > current.open);
  const bodyR = body !== null && finite(atr14) && atr14! > 0 ? body / atr14! : null;
  const closeLocation = current && candleRange !== null && candleRange > 0 ? (current.close - current.low) / candleRange : null;
  const breakDistanceR = current && previous && finite(atr14) && atr14! > 0 ? (current.close - previous.high) / atr14! : null;
  const bodyExtreme = Boolean(bullBody && bodyR !== null && bodyR >= 0.5 && candleRange !== null && candleRange > 0 && closeLocation !== null && closeLocation >= 0.75);
  const breakout = Boolean(breakDistanceR !== null && breakDistanceR >= 0.1);
  const strategySignalQualified = Boolean(ready && origin && consensus !== null && consensus >= 3 && bodyExtreme && breakout);
  const signalMidClose = strategySignalQualified && current ? current.close : null;

  return {
    originTime: current?.time ?? null,
    signalMidClose,
    ema20,
    ema50,
    atr14,
    voteTrend,
    votePrice,
    voteSlope,
    voteMomentum,
    consensus,
    bullBody,
    bodyR,
    closeLocation,
    previousHigh: previous?.high ?? null,
    breakDistanceR,
    pineReferenceStop: signalMidClose !== null && finite(atr14) ? signalMidClose - atr14! : null,
    pineReferenceTarget: signalMidClose !== null && finite(atr14) ? signalMidClose + 2 * atr14! : null,
    strategySignalQualified,
  };
}

function executionBlockReason(input: StrategyEvaluationInput, pine: NzdjpyPineEvaluation, options: NzdjpyStrategyEvaluationOptions): string | null {
  if (!pine.strategySignalQualified) return "NO_STRATEGY_SIGNAL";
  if (input.instrument !== NZDJPY_STRATEGY_SYMBOL) return "WRONG_INSTRUMENT";
  if ((options.timeframe ?? NZDJPY_STRATEGY_TIMEFRAME) !== NZDJPY_STRATEGY_TIMEFRAME) return "WRONG_TIMEFRAME";
  if (options.duplicateSignal) return "DUPLICATE_SIGNAL";
  if (options.hasActivePosition) return "NZDJPY_V1_POSITION_ACTIVE";
  if (input.dataSource !== "oanda") return "OANDA_CONNECTION_UNAVAILABLE";
  if (!finite(input.ask)) return "OANDA_PRICE_UNAVAILABLE";
  return null;
}

function regime(pine: NzdjpyPineEvaluation, evaluatedAt: string): MarketRegime {
  const atrPips = pine.atr14 === null ? null : pine.atr14 / pipSizeFor(NZDJPY_STRATEGY_SYMBOL);
  return { regime: "mixed", trendDirection: pine.ema20 === null || pine.ema50 === null ? "none" : pine.ema20 > pine.ema50 ? "up" : pine.ema20 < pine.ema50 ? "down" : "none", trendStrength: 0, volatility: "normal", atr: pine.atr14, atrPips, momentumState: "steady", emaFast: pine.ema20, emaMid: pine.ema50, emaSlow: null, slopeAtrPerBar: null, rangeHigh: null, rangeLow: null, rangeWidthAtr: null, rangeAgeBars: null, lookbackBars: 50, evaluatedAt };
}

export function evaluateNzdjpyStrategy(input: StrategyEvaluationInput, options: NzdjpyStrategyEvaluationOptions = {}): StrategyCandidate<typeof NZDJPY_STRATEGY_ID> {
  const pine = evaluateNzdjpy23UtcBullBreakV1(input.candles1h);
  const evaluatedAt = pine.originTime ? new Date(Date.parse(pine.originTime) + 60 * 60_000).toISOString() : input.evaluatedAt ?? new Date(0).toISOString();
  const blockReason = executionBlockReason(input, pine, options);
  const executionAllowed = pine.strategySignalQualified && blockReason === null;
  const actualExecutableEntry = executionAllowed ? input.ask : null;
  const executableStop = actualExecutableEntry !== null && finite(pine.atr14) ? actualExecutableEntry - pine.atr14! : null;
  const executableTarget = actualExecutableEntry !== null && finite(pine.atr14) ? actualExecutableEntry + 2 * pine.atr14! : null;
  const signalKey = pine.strategySignalQualified && pine.originTime ? "NZDJPY_2300_LONG:" + pine.originTime : null;
  const features: NzdjpyStrategyFeatures = {
    strategyId: NZDJPY_STRATEGY_ID,
    strategyName: NZDJPY_STRATEGY_NAME,
    strategyVersion: NZDJPY_STRATEGY_VERSION,
    symbol: NZDJPY_STRATEGY_SYMBOL,
    timeframe: NZDJPY_STRATEGY_TIMEFRAME,
    signalKey,
    originTime: pine.originTime,
    signalMidClose: pine.signalMidClose,
    actualExecutableEntry,
    frozenAtr14: pine.atr14,
    pineReferenceStop: pine.pineReferenceStop,
    pineReferenceTarget: pine.pineReferenceTarget,
    executableStop,
    executableTarget,
    ema20: pine.ema20,
    ema50: pine.ema50,
    voteTrend: pine.voteTrend,
    votePrice: pine.votePrice,
    voteSlope: pine.voteSlope,
    voteMomentum: pine.voteMomentum,
    consensus: pine.consensus,
    bullBody: pine.bullBody,
    bodyR: pine.bodyR,
    closeLocation: pine.closeLocation,
    previousHigh: pine.previousHigh,
    breakDistanceR: pine.breakDistanceR,
    strategySignalQualified: pine.strategySignalQualified,
    executionAllowed,
    executionBlockReason: blockReason,
    maxHoldBars: 3,
  };
  const conditions = [
    strategyCondition("Pine completed 23:00 UTC origin", Boolean(pine.originTime && exactH1(new Date(pine.originTime)) && new Date(pine.originTime).getUTCHours() === 23), "The completed candle labelled 23:00 UTC is the only Pine origin.", pine.originTime ?? "unavailable"),
    strategyCondition("Pine history", pine.ema20 !== null && pine.ema50 !== null && pine.atr14 !== null && pine.atr14 > 0 && pine.voteSlope !== null && pine.voteMomentum !== null, "EMA20, EMA50, EMA20[3], close[3], high[1], and positive Wilder ATR14 are required.", pine.atr14?.toString() ?? "unavailable"),
    strategyCondition("Pine consensus", pine.consensus !== null && pine.consensus >= 3, "The four Pine votes must total +3 or +4.", pine.consensus?.toString() ?? "unavailable"),
    strategyCondition("Pine bullish body", pine.bullBody, "close must be greater than open.", pine.bullBody ? "bullish" : "not bullish"),
    strategyCondition("Pine body strength", pine.bodyR !== null && pine.bodyR >= 0.5, "Absolute body must be at least 0.50 ATR14.", pine.bodyR?.toFixed(6) ?? "unavailable"),
    strategyCondition("Pine upper 25% close", pine.closeLocation !== null && pine.closeLocation >= 0.75, "Close must be in the upper 25% of its range.", pine.closeLocation?.toFixed(6) ?? "unavailable"),
    strategyCondition("Pine previous-high break", pine.breakDistanceR !== null && pine.breakDistanceR >= 0.1, "Close must be at least 0.10 ATR14 above high[1].", pine.breakDistanceR?.toFixed(6) ?? "unavailable"),
    strategyCondition("Strategy signal qualified", pine.strategySignalQualified, "Exact Pine result, without execution policy.", pine.strategySignalQualified ? "qualified" : "not qualified"),
    strategyCondition("Execution instrument", input.instrument === NZDJPY_STRATEGY_SYMBOL, "Runtime may execute this evaluator only for NZD_JPY.", input.instrument, false),
    strategyCondition("Execution timeframe", (options.timeframe ?? NZDJPY_STRATEGY_TIMEFRAME) === NZDJPY_STRATEGY_TIMEFRAME, "Runtime requires H1 data.", options.timeframe ?? NZDJPY_STRATEGY_TIMEFRAME, false),
    strategyCondition("Execution duplicate protection", !options.duplicateSignal, "The same completed 23:00 candle can be submitted once.", options.duplicateSignal ? "duplicate" : "clear", false),
    strategyCondition("Execution NZDJPY position", !options.hasActivePosition, "Pyramiding is disabled only for NZDJPY V1.", options.hasActivePosition ? "active" : "clear", false),
    strategyCondition("Execution OANDA connection", input.dataSource === "oanda", "A connected OANDA candle/quote source is required to submit a practice order.", input.dataSource, false),
    strategyCondition("Execution OANDA ASK", finite(input.ask), "A valid executable ASK is required to submit a long practice order.", input.ask?.toString() ?? "unavailable", false),
  ];

  return {
    family: NZDJPY_STRATEGY_ID,
    version: NZDJPY_STRATEGY_VERSION,
    configVersion: NZDJPY_STRATEGY_CONFIG_VERSION,
    regime: regime(pine, evaluatedAt),
    qualifyReason: pine.strategySignalQualified ? executionAllowed ? "NZDJPY Pine signal qualified and execution is allowed." : "NZDJPY Pine signal qualified; execution blocked: " + blockReason + "." : "NZDJPY Pine signal did not qualify.",
    status: executionAllowed ? "valid" : "no_setup",
    instrument: input.instrument,
    pair: displayNameFor(input.instrument),
    direction: pine.strategySignalQualified ? "long" : null,
    timeframe: "1h",
    entry: actualExecutableEntry,
    stop: executableStop,
    target: executableTarget,
    riskReward: executionAllowed ? 2 : null,
    positionSize: null,
    features: { trend15m: "mixed", trend1h: pine.ema20 !== null && pine.ema50 !== null ? pine.ema20 > pine.ema50 ? "bullish" : pine.ema20 < pine.ema50 ? "bearish" : "mixed" : "mixed", trend4h: null, ema21: null, ema50: pine.ema50, ema200: null, rsi14: null, atr14: pine.atr14, atrPips: pine.atr14 === null ? null : pine.atr14 / pipSizeFor(NZDJPY_STRATEGY_SYMBOL), structureHighs: 0, structureLows: 0, evaluationMode: input.evaluationMode ?? "live", nzdjpyStrategy: features },
    summary: pine.strategySignalQualified ? executionAllowed ? "NZDJPY 23UTC Bull Break V1 LONG signal." : "NZDJPY 23UTC Bull Break V1 signal blocked from execution: " + blockReason + "." : "NZDJPY 23UTC Bull Break V1 WAIT.",
    passedConditions: conditions.filter((item) => item.passed),
    failedConditions: conditions.filter((item) => !item.passed),
    conditions,
    evaluatedAt,
    dataSource: input.dataSource,
  };
}
export const resolveNzdjpyExit = (input: FrozenH1ExitInput) => resolveFrozenH1Exit(input);

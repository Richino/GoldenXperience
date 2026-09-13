import { displayNameFor, pipSizeFor } from "@/lib/instruments/catalog";
import { calculateAtrValues, calculateEmaValues } from "@/lib/strategy/indicators";
import { resolveFrozenH1Exit, type FrozenH1ExitInput } from "@/lib/strategy/strategies/frozen-h1-pair";
import type { StrategyCandidate } from "@/lib/strategy/strategy";
import type { AudjpyStrategyFeatures, MarketRegime, StrategyCondition, StrategyEvaluationInput } from "@/lib/strategy/types";
import type { Candle } from "@/types/forex";

export const AUDJPY_STRATEGY_ID = "audjpy_strategy" as const;
export const AUDJPY_STRATEGY_NAME = "AUDJPY Bull Consensus V1" as const;
export const AUDJPY_STRATEGY_VERSION = "V1" as const;
export const AUDJPY_STRATEGY_CONFIG_VERSION = "audjpy-v1-frozen" as const;
export const AUDJPY_STRATEGY_SYMBOL = "AUD_JPY" as const;
export const AUDJPY_STRATEGY_TIMEFRAME = "H1" as const;
/**
 * Frozen contract for "GX AUDJPY Bull Consensus V1 - 1 to 2 RR".
 * CONSENSUS ONLY — the frozen research explicitly rejected every additional
 * filter, so there is no structure/breakout/EMA-reclaim/body/extreme gate.
 */
export const AUDJPY_STRATEGY_CONFIG = Object.freeze({ symbol: AUDJPY_STRATEGY_SYMBOL, timeframe: AUDJPY_STRATEGY_TIMEFRAME, originHourUtc: 12, startTimeUtc: "2023-01-01T00:00:00.000Z", direction: "LONG_ONLY", emaFastPeriod: 20, emaSlowPeriod: 50, atrPeriod: 14, consensus: ">= +3", extraFilters: "NONE", stopAtr: 1, rewardR: 2, maxHoldBars: 3, executionEnabled: true, adaptiveParametersMutable: false });

export interface AudjpyPineEvaluation {
  originTime: string | null; signalMidClose: number | null;
  ema20: number | null; ema50: number | null; ema20Back: number | null; closeThreeBarsAgo: number | null; atr14: number | null;
  voteTrend: -1 | 0 | 1 | null; votePrice: -1 | 0 | 1 | null; voteSlope: -1 | 0 | 1 | null; voteMomentum: -1 | 0 | 1 | null; consensus: number | null;
  pineReferenceStop: number | null; pineReferenceTarget: number | null; strategySignalQualified: boolean;
}
export interface AudjpyStrategyEvaluationOptions { timeframe?: string; hasActivePosition?: boolean; duplicateSignal?: boolean; }

const finite = (v: number | null) => v !== null && Number.isFinite(v);
const vote = (a: number, b: number): -1 | 0 | 1 => a > b ? 1 : a < b ? -1 : 0;
const exactH1 = (d: Date) => d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
const START = Date.parse(AUDJPY_STRATEGY_CONFIG.startTimeUtc);
const condition = (name: string, passed: boolean, reason: string, currentValue: string, required = true): StrategyCondition => ({ name, passed, reason, currentValue, required });

function clean(input: readonly Candle[]) {
  const m = new Map<string, Candle>();
  for (const c of input) if (c.complete && Number.isFinite(Date.parse(c.time)) && !m.has(c.time)) m.set(c.time, c);
  return [...m.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

/**
 * Literal Pine implementation over completed H1 midpoint candles: completed
 * 12:00 UTC origin on/after the frozen start, indicators/history ready, ATR>0,
 * and four-vote consensus >= +3. No other filter exists.
 */
export function evaluateAudjpyBullConsensusV1(input: readonly Candle[]): AudjpyPineEvaluation {
  const cs = clean(input), i = cs.length - 1, x = cs.at(-1), b3 = cs.at(-4);
  const closes = cs.map((c) => c.close), e20s = calculateEmaValues(closes, 20), e50s = calculateEmaValues(closes, 50), atrs = calculateAtrValues(cs, 14);
  const ema20 = e20s[i] ?? null, ema50 = e50s[i] ?? null, ema20Back = e20s[i - 3] ?? null, atr14 = atrs[i] ?? null;
  const origin = Boolean(x && Date.parse(x.time) >= START && exactH1(new Date(x.time)) && new Date(x.time).getUTCHours() === 12);
  const ready = Boolean(x && b3 && finite(ema20) && finite(ema50) && finite(ema20Back) && finite(atr14) && atr14! > 0);
  const voteTrend = ready ? vote(ema20!, ema50!) : null;
  const votePrice = ready ? vote(x!.close, ema20!) : null;
  const voteSlope = ready ? vote(ema20!, ema20Back!) : null;
  const voteMomentum = ready ? vote(x!.close, b3!.close) : null;
  const consensus = voteTrend === null || votePrice === null || voteSlope === null || voteMomentum === null ? null : voteTrend + votePrice + voteSlope + voteMomentum;
  const strategySignalQualified = Boolean(origin && ready && consensus !== null && consensus >= 3);
  const signalMidClose = strategySignalQualified && x ? x.close : null;
  return {
    originTime: x?.time ?? null, signalMidClose, ema20, ema50, ema20Back, closeThreeBarsAgo: b3?.close ?? null, atr14,
    voteTrend, votePrice, voteSlope, voteMomentum, consensus,
    pineReferenceStop: signalMidClose !== null && finite(atr14) ? signalMidClose - atr14! : null,
    pineReferenceTarget: signalMidClose !== null && finite(atr14) ? signalMidClose + 2 * atr14! : null,
    strategySignalQualified,
  };
}

function block(input: StrategyEvaluationInput, q: boolean, o: AudjpyStrategyEvaluationOptions) {
  if (!q) return "NO_STRATEGY_SIGNAL";
  if (input.instrument !== AUDJPY_STRATEGY_SYMBOL) return "WRONG_INSTRUMENT";
  if ((o.timeframe ?? "H1") !== "H1") return "WRONG_TIMEFRAME";
  if (o.duplicateSignal) return "DUPLICATE_SIGNAL";
  if (o.hasActivePosition) return "AUDJPY_V1_POSITION_ACTIVE";
  if (input.dataSource !== "oanda") return "OANDA_CONNECTION_UNAVAILABLE";
  if (!finite(input.ask)) return "OANDA_PRICE_UNAVAILABLE";
  return null;
}

function regime(p: AudjpyPineEvaluation, t: string): MarketRegime {
  return { regime: "mixed", trendDirection: p.ema20 === null || p.ema50 === null ? "none" : p.ema20 > p.ema50 ? "up" : p.ema20 < p.ema50 ? "down" : "none", trendStrength: 0, volatility: "normal", atr: p.atr14, atrPips: p.atr14 === null ? null : p.atr14 / pipSizeFor(AUDJPY_STRATEGY_SYMBOL), momentumState: "steady", emaFast: p.ema20, emaMid: p.ema50, emaSlow: null, slopeAtrPerBar: null, rangeHigh: null, rangeLow: null, rangeWidthAtr: null, rangeAgeBars: null, lookbackBars: 50, evaluatedAt: t };
}

export function evaluateAudjpyStrategy(input: StrategyEvaluationInput, options: AudjpyStrategyEvaluationOptions = {}): StrategyCandidate<typeof AUDJPY_STRATEGY_ID> {
  const p = evaluateAudjpyBullConsensusV1(input.candles1h);
  const q = p.strategySignalQualified && input.instrument === AUDJPY_STRATEGY_SYMBOL && (options.timeframe ?? "H1") === "H1";
  const evaluatedAt = p.originTime ? new Date(Date.parse(p.originTime) + 3_600_000).toISOString() : input.evaluatedAt ?? new Date(0).toISOString();
  const executionBlockReason = block(input, q, options);
  const executionAllowed = q && executionBlockReason === null;
  const entry = executionAllowed ? input.ask : null;
  const stop = entry !== null && finite(p.atr14) ? entry - p.atr14! : null;
  const target = entry !== null && finite(p.atr14) ? entry + 2 * p.atr14! : null;
  const features: AudjpyStrategyFeatures = {
    strategyId: AUDJPY_STRATEGY_ID, strategyName: AUDJPY_STRATEGY_NAME, strategyVersion: AUDJPY_STRATEGY_VERSION, symbol: AUDJPY_STRATEGY_SYMBOL, timeframe: "H1",
    signalKey: q && p.originTime ? `AUDJPY_1200_LONG:${p.originTime}` : null, originTime: p.originTime,
    signalMidClose: p.signalMidClose, actualExecutableEntry: entry, frozenAtr14: p.atr14,
    pineReferenceStop: p.pineReferenceStop, pineReferenceTarget: p.pineReferenceTarget, executableStop: stop, executableTarget: target,
    ema20: p.ema20, ema50: p.ema50, ema20Back: p.ema20Back, closeThreeBarsAgo: p.closeThreeBarsAgo,
    voteTrend: p.voteTrend, votePrice: p.votePrice, voteSlope: p.voteSlope, voteMomentum: p.voteMomentum, consensus: p.consensus,
    strategySignalQualified: q, executionAllowed, executionBlockReason, maxHoldBars: 3,
  };
  const conditions = [
    condition("Pine AUDJPY instrument", input.instrument === AUDJPY_STRATEGY_SYMBOL, "AUD_JPY only.", input.instrument),
    condition("Pine H1", (options.timeframe ?? "H1") === "H1", "H1 only.", options.timeframe ?? "H1"),
    condition("Pine completed 12:00 UTC origin", Boolean(p.originTime && Date.parse(p.originTime) >= START && exactH1(new Date(p.originTime)) && new Date(p.originTime).getUTCHours() === 12), "Completed 12:00 UTC candle on/after the frozen start date.", p.originTime ?? "unavailable"),
    condition("Pine history", p.ema20 !== null && p.ema50 !== null && p.ema20Back !== null && p.atr14 !== null && p.atr14 > 0, "EMA20/EMA50/EMA20[3]/close[3]/ATR14 required and ATR positive.", p.atr14?.toString() ?? "unavailable"),
    condition("Pine consensus", p.consensus !== null && p.consensus >= 3, "Four votes total +3 or +4.", p.consensus?.toString() ?? "unavailable"),
    condition("Strategy signal qualified", q, "Exact Pine result without broker policy.", q ? "qualified" : "not qualified"),
    condition("Execution duplicate protection", !options.duplicateSignal, "Same origin submits once.", options.duplicateSignal ? "duplicate" : "clear", false),
    condition("Execution AUDJPY position", !options.hasActivePosition, "Pyramiding scoped to AUDJPY V1.", options.hasActivePosition ? "active" : "clear", false),
    condition("Execution OANDA connection", input.dataSource === "oanda", "Connected OANDA data required.", input.dataSource, false),
    condition("Execution OANDA ASK", finite(input.ask), "Valid ASK required.", input.ask?.toString() ?? "unavailable", false),
  ];
  return {
    family: AUDJPY_STRATEGY_ID, version: AUDJPY_STRATEGY_VERSION, configVersion: AUDJPY_STRATEGY_CONFIG_VERSION, regime: regime(p, evaluatedAt),
    qualifyReason: q ? executionAllowed ? "AUDJPY Pine signal qualified and execution is allowed." : `AUDJPY Pine signal qualified; execution blocked: ${executionBlockReason}.` : "AUDJPY Pine signal did not qualify.",
    status: executionAllowed ? "valid" : "no_setup", instrument: input.instrument, pair: displayNameFor(input.instrument),
    direction: q ? "long" : null, timeframe: "1h", entry, stop, target, riskReward: executionAllowed ? 2 : null, positionSize: null,
    features: { trend15m: "mixed", trend1h: p.ema20 === null || p.ema50 === null ? "mixed" : p.ema20 > p.ema50 ? "bullish" : p.ema20 < p.ema50 ? "bearish" : "mixed", trend4h: null, ema21: null, ema50: p.ema50, ema200: null, rsi14: null, atr14: p.atr14, atrPips: p.atr14 === null ? null : p.atr14 / pipSizeFor(AUDJPY_STRATEGY_SYMBOL), structureHighs: 0, structureLows: 0, evaluationMode: input.evaluationMode ?? "live", audjpyStrategy: features },
    summary: q ? executionAllowed ? "AUDJPY Bull Consensus V1 LONG signal." : `AUDJPY Bull Consensus V1 execution blocked: ${executionBlockReason}.` : "AUDJPY Bull Consensus V1 WAIT.",
    passedConditions: conditions.filter((c) => c.passed), failedConditions: conditions.filter((c) => !c.passed), conditions, evaluatedAt, dataSource: input.dataSource,
  };
}

export const resolveAudjpyExit = (input: FrozenH1ExitInput) => resolveFrozenH1Exit(input);

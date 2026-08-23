import { displayNameFor } from "@/lib/instruments/catalog";
import {
  buildTradePlan, completedCandles, condition, evaluateHardGates, finalizeCandidate,
} from "@/lib/strategy/strategy-common";
import type { Strategy, StrategyCandidate } from "@/lib/strategy/strategy";
import type { BreakoutFeatures, MarketRegime, StrategyCondition, StrategyEvaluationInput } from "@/lib/strategy/types";

/**
 * Strategy B — Breakout V1.
 *
 * Trades a completed close beyond a recent consolidation range by more than a
 * threshold of ATR, while avoiding a break that has already run too far. The
 * range is measured from the bars preceding the breakout candle, so the level
 * is never drawn using the candle that breaks it. Symmetric long and short.
 *
 * Research note: an H1 “compressed range ≤2.2 ATR” variant looked positive on
 * EUR/GBP/JPY alone (~+0.18R holdout, n=38) but collapsed to negative/flat when
 * the universe was expanded with freshly backfilled majors. That candidate is
 * not shipped. Live entries stay gated via LIVE_EXECUTABLE_FAMILIES.
 */
export interface BreakoutConfig {
  /** Bars used to measure the range, ending just before the breakout candle. */
  lookbackBars: number;
  /** Close must clear the level by at least this many ATR. */
  breakoutAtrThreshold: number;
  requireCandleClose: boolean;
  requireRetest: boolean;
  minimumVolatilityAtrPips: number;
  /** The prior range must be a real consolidation, not already trending wide. */
  minRangeWidthAtr: number;
  maxRangeWidthAtr: number;
  /** Reject when the close is already this far beyond the level (chasing). */
  maxExtensionAtr: number;
  stopBufferAtr: number;
  targetR: number;
  minStopAtr: number;
}

export const BREAKOUT_VERSION = "breakout-v1";
export const BREAKOUT_CONFIG_VERSION = "breakout-cfg-v1";

export const DEFAULT_BREAKOUT_CONFIG: BreakoutConfig = {
  lookbackBars: 20,
  breakoutAtrThreshold: 0.5,
  requireCandleClose: true,
  requireRetest: false,
  minimumVolatilityAtrPips: 2,
  minRangeWidthAtr: 1.0,
  maxRangeWidthAtr: 8.0,
  maxExtensionAtr: 3.0,
  stopBufferAtr: 0.5,
  targetR: 2.0,
  minStopAtr: 1.0,
};

export function evaluateBreakout(input: StrategyEvaluationInput, regime: MarketRegime, config: BreakoutConfig): StrategyCandidate {
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
  const candles15m = completedCandles(input.candles15m);
  const candles1h = completedCandles(input.candles1h);
  const candles4h = completedCandles(input.candles4h);

  const gate = evaluateHardGates(input, evaluatedAt, candles15m, candles1h, candles4h);
  const conditions: StrategyCondition[] = [...gate.conditions];
  const finalize = (status: StrategyCandidate["status"], summary: string, reason: string, direction: StrategyCandidate["direction"], plan: ReturnType<typeof buildTradePlan> | null, features?: BreakoutFeatures) =>
    finalizeCandidate({
      family: "breakout", version: BREAKOUT_VERSION, configVersion: BREAKOUT_CONFIG_VERSION, input, evaluatedAt, regime,
      direction, plan, conditions, status, summary, qualifyReason: reason,
      features: { trend15m: "mixed", trend1h: null, trend4h: null, ema21: regime.emaFast, ema50: regime.emaMid, ema200: regime.emaSlow, rsi14: null, atr14: regime.atr, atrPips: regime.atrPips, structureHighs: 0, structureLows: 0, regime, breakout: features ?? null },
    });

  const gateFail = conditions.find((item) => item.required && !item.passed);
  if (gateFail) return finalize("no_setup", `${displayNameFor(input.instrument)} breakout blocked by ${gateFail.name.toLowerCase()}.`, gateFail.reason, null, null);

  const atr = regime.atr ?? 0;
  if (atr <= 0 || candles15m.length < config.lookbackBars + 1) {
    return finalize("invalid", `${displayNameFor(input.instrument)} breakout inputs unavailable.`, "ATR or candle history is insufficient.", null, null);
  }

  const last = candles15m.at(-1)!;
  const window = candles15m.slice(-(config.lookbackBars + 1), -1);
  const rangeHigh = Math.max(...window.map((candle) => candle.high));
  const rangeLow = Math.min(...window.map((candle) => candle.low));
  const rangeWidthAtr = (rangeHigh - rangeLow) / atr;

  const rangeOk = rangeWidthAtr >= config.minRangeWidthAtr && rangeWidthAtr <= config.maxRangeWidthAtr;
  conditions.push(condition("Meaningful range", rangeOk,
    rangeOk ? "A real consolidation preceded the break." : "No meaningful prior range (too tight or already trending).",
    `${rangeWidthAtr.toFixed(2)} ATR`, true));

  const volOk = (regime.atrPips ?? 0) >= config.minimumVolatilityAtrPips;
  conditions.push(condition("Volatility", volOk,
    volOk ? "ATR is sufficient for a breakout." : "ATR is too compressed for a breakout.",
    `${(regime.atrPips ?? 0).toFixed(1)} pips`, true));

  const brokeUp = last.close > rangeHigh + atr * config.breakoutAtrThreshold;
  const brokeDown = last.close < rangeLow - atr * config.breakoutAtrThreshold;
  const direction = brokeUp ? "long" as const : brokeDown ? "short" as const : null;
  const level = direction === "long" ? rangeHigh : direction === "short" ? rangeLow : null;
  const breakoutDistance = direction === "long" ? last.close - rangeHigh : direction === "short" ? rangeLow - last.close : null;
  const breakoutDistanceAtr = breakoutDistance === null ? null : breakoutDistance / atr;
  conditions.push(condition("Breakout", direction !== null,
    direction === "long" ? "Closed above the range by the ATR threshold." : direction === "short" ? "Closed below the range by the ATR threshold." : "No completed close beyond the range.",
    direction === null ? `range ${rangeLow.toFixed(5)}–${rangeHigh.toFixed(5)}` : `${breakoutDistanceAtr!.toFixed(2)} ATR`, true));
  if (!direction || level === null) return finalize("no_setup", `${displayNameFor(input.instrument)} has no breakout.`, "No completed close beyond the range.", null, null);

  const notExtended = breakoutDistanceAtr !== null && breakoutDistanceAtr <= config.maxExtensionAtr;
  conditions.push(condition("Not extended", notExtended,
    notExtended ? "The break has not already run too far." : "Price already ran too far beyond the level (chasing).",
    `${(breakoutDistanceAtr ?? 0).toFixed(2)} ATR`, true));

  const retest = window.some((candle) => direction === "long" ? candle.low <= rangeHigh + atr * 0.1 && candle.high >= rangeHigh - atr * 0.35 : candle.high >= rangeLow - atr * 0.1 && candle.low <= rangeLow + atr * 0.35);
  if (config.requireRetest) {
    conditions.push(condition("Retest", retest, retest ? "Level was retested before the break." : "No retest of the level.", retest ? "retested" : "none", true));
  }

  const rawStop = direction === "long" ? rangeHigh - atr * config.stopBufferAtr : rangeLow + atr * config.stopBufferAtr;
  const plan = buildTradePlan(input, direction, rawStop, atr, { targetR: config.targetR, minStopAtr: config.minStopAtr });

  const features: BreakoutFeatures = {
    level, side: direction === "long" ? "high" : "low", lookbackBars: config.lookbackBars,
    breakoutDistance, breakoutDistanceAtr, candleClose: config.requireCandleClose,
    rangeHigh, rangeLow, rangeWidthAtr, retest, extensionAtr: breakoutDistanceAtr,
  };

  const hardFailed = conditions.some((item) => item.required && !item.passed);
  const planValid = plan.entry !== null && plan.stop !== null && plan.target !== null;
  const status = !planValid ? "invalid" : hardFailed ? "no_setup" : "valid";
  const summary = status === "valid"
    ? `${displayNameFor(input.instrument)} ${direction} breakout of a ${rangeWidthAtr.toFixed(1)} ATR range.`
    : `${displayNameFor(input.instrument)} ${direction} breakout incomplete.`;
  const reason = status === "valid" ? "Clean close beyond a real range, not overextended." : conditions.find((item) => item.required && !item.passed)?.reason ?? "Setup incomplete.";
  return finalize(status, summary, reason, direction, plan, features);
}

export const breakoutStrategy: Strategy<BreakoutConfig> = {
  family: "breakout",
  version: BREAKOUT_VERSION,
  defaultConfigVersion: BREAKOUT_CONFIG_VERSION,
  defaultConfig: DEFAULT_BREAKOUT_CONFIG,
  evaluate: evaluateBreakout,
};

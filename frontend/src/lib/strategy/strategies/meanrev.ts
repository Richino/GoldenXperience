import { displayNameFor } from "@/lib/instruments/catalog";
import { calculateEmaValues } from "@/lib/strategy/indicators";
import {
  buildTradePlan, completedCandles, condition, evaluateHardGates, finalizeCandidate,
} from "@/lib/strategy/strategy-common";
import type { Strategy, StrategyCandidate } from "@/lib/strategy/strategy";
import type { MarketRegime, MeanReversionFeatures, StrategyCondition, StrategyEvaluationInput } from "@/lib/strategy/types";

/**
 * Strategy D — Mean Reversion V1.
 *
 * Fades price that is stretched far from a moving-average value area, but only
 * when the regime is non-trending and the trend is weak — it explicitly refuses
 * to fade a strong trend. Requires a completed exhaustion/reversal candle
 * against the stretch, and targets the mean. Symmetric long and short.
 * Independent of the other strategies.
 */
export interface MeanReversionConfig {
  meanPeriod: number;
  /** Minimum distance from the mean, in ATR, to consider price stretched. */
  stretchThresholdAtr: number;
  /** Refuse to fade when the regime trend strength (R²) is above this. */
  maxTrendStrength: number;
  rangeLookbackBars: number;
  minRangeAgeBars: number;
  requireReversalConfirmation: boolean;
  stopBeyondExtremeAtr: number;
  minStopAtr: number;
  minRiskReward: number;
}

export const MEANREV_VERSION = "meanrev-v1";
export const MEANREV_CONFIG_VERSION = "meanrev-cfg-v1";

export const DEFAULT_MEANREV_CONFIG: MeanReversionConfig = {
  meanPeriod: 20,
  stretchThresholdAtr: 2.0,
  maxTrendStrength: 0.4,
  rangeLookbackBars: 20,
  minRangeAgeBars: 10,
  requireReversalConfirmation: true,
  stopBeyondExtremeAtr: 0.5,
  minStopAtr: 1.0,
  minRiskReward: 1.0,
};

/** An exhaustion candle against the stretch: a rejection wick or a reversal body. */
function reversalConfirmed(candle: { open: number; high: number; low: number; close: number }, revertDirection: "long" | "short"): boolean {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  if (revertDirection === "short") {
    // Price stretched up; want an upper-wick rejection or a bearish close.
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    return upperWick / range >= 0.45 || candle.close < candle.open;
  }
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  return lowerWick / range >= 0.45 || candle.close > candle.open;
}

export function evaluateMeanReversion(input: StrategyEvaluationInput, regime: MarketRegime, config: MeanReversionConfig): StrategyCandidate {
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
  const candles15m = completedCandles(input.candles15m);
  const candles1h = completedCandles(input.candles1h);
  const candles4h = completedCandles(input.candles4h);

  const gate = evaluateHardGates(input, evaluatedAt, candles15m, candles1h, candles4h);
  const conditions: StrategyCondition[] = [...gate.conditions];
  const finalize = (status: StrategyCandidate["status"], summary: string, reason: string, direction: StrategyCandidate["direction"], plan: ReturnType<typeof buildTradePlan> | null, features?: MeanReversionFeatures) =>
    finalizeCandidate({
      family: "meanrev", version: MEANREV_VERSION, configVersion: MEANREV_CONFIG_VERSION, input, evaluatedAt, regime,
      direction, plan, conditions, status, summary, qualifyReason: reason,
      features: { trend15m: "mixed", trend1h: null, trend4h: null, ema21: regime.emaFast, ema50: regime.emaMid, ema200: regime.emaSlow, rsi14: null, atr14: regime.atr, atrPips: regime.atrPips, structureHighs: 0, structureLows: 0, regime, meanReversion: features ?? null },
    });

  const gateFail = conditions.find((item) => item.required && !item.passed);
  if (gateFail) return finalize("no_setup", `${displayNameFor(input.instrument)} mean reversion blocked by ${gateFail.name.toLowerCase()}.`, gateFail.reason, null, null);

  const atr = regime.atr ?? 0;
  if (atr <= 0 || candles15m.length < config.rangeLookbackBars + 1) {
    return finalize("invalid", `${displayNameFor(input.instrument)} mean-reversion inputs unavailable.`, "ATR or candle history is insufficient.", null, null);
  }

  // Non-trending gate: this strategy must never fade a strong trend.
  const rangingOk = regime.regime !== "trending" && regime.trendStrength <= config.maxTrendStrength;
  conditions.push(condition("Non-trending", rangingOk,
    rangingOk ? `Regime is ${regime.regime} (R² ${regime.trendStrength.toFixed(2)}); safe to fade.` : `Regime is ${regime.regime} (R² ${regime.trendStrength.toFixed(2)}); too trending to fade.`,
    `${regime.regime} · ${regime.trendStrength.toFixed(2)}`, true));

  const mean = calculateEmaValues(candles15m.map((candle) => candle.close), config.meanPeriod).at(-1) ?? null;
  const last = candles15m.at(-1)!;
  if (mean === null) return finalize("invalid", `${displayNameFor(input.instrument)} mean unavailable.`, "Mean reference is unavailable.", null, null);

  const distanceFromMean = last.close - mean;
  const stretchAtr = Math.abs(distanceFromMean) / atr;
  const direction = distanceFromMean > 0 ? "short" as const : distanceFromMean < 0 ? "long" as const : null;
  const stretched = direction !== null && stretchAtr >= config.stretchThresholdAtr;
  conditions.push(condition("Stretched from mean", stretched,
    stretched ? `Price is ${stretchAtr.toFixed(2)} ATR from the mean.` : "Price is not stretched far enough from the mean.",
    `${stretchAtr.toFixed(2)} ATR`, true));
  if (!direction || !stretched) return finalize("no_setup", `${displayNameFor(input.instrument)} is not stretched.`, "Price is not stretched from the mean.", direction, null);

  const rangeAgeBars = regime.rangeAgeBars ?? 0;
  const rangeAgeOk = rangeAgeBars >= config.minRangeAgeBars;
  conditions.push(condition("Established range", rangeAgeOk,
    rangeAgeOk ? `Price held its range for ${rangeAgeBars} bars.` : "The range is too young to fade.",
    `${rangeAgeBars} bars`, true));

  const reversal = !config.requireReversalConfirmation || reversalConfirmed(last, direction);
  conditions.push(condition("Reversal confirmation", reversal,
    reversal ? "A completed exhaustion candle turned against the stretch." : "No exhaustion/reversal candle yet.",
    reversal ? "confirmed" : "none", config.requireReversalConfirmation));

  const window = candles15m.slice(-config.rangeLookbackBars);
  const rangeHigh = Math.max(...window.map((candle) => candle.high));
  const rangeLow = Math.min(...window.map((candle) => candle.low));
  const rangeWidthAtr = (rangeHigh - rangeLow) / atr;
  const rawStop = direction === "short" ? rangeHigh + atr * config.stopBeyondExtremeAtr : rangeLow - atr * config.stopBeyondExtremeAtr;
  const plan = buildTradePlan(input, direction, rawStop, atr, { targetR: 0, minStopAtr: config.minStopAtr, targetPrice: mean });

  const rrOk = plan.riskReward !== null && plan.riskReward >= config.minRiskReward;
  conditions.push(condition("Reward to risk", rrOk,
    rrOk ? "The move back to the mean clears the minimum reward-to-risk." : "The mean is too close to justify the stop.",
    plan.riskReward === null ? "unavailable" : `${plan.riskReward.toFixed(2)}R`, true));

  const features: MeanReversionFeatures = {
    mean, distanceFromMean, stretchAtr, rangeHigh, rangeLow, rangeWidthAtr, rangeAgeBars,
    trendStrength: regime.trendStrength, reversalConfirmation: reversal,
  };

  const hardFailed = conditions.some((item) => item.required && !item.passed);
  const planValid = plan.entry !== null && plan.stop !== null && plan.target !== null;
  const status = !planValid ? "invalid" : hardFailed ? "no_setup" : "valid";
  const summary = status === "valid"
    ? `${displayNameFor(input.instrument)} ${direction} mean reversion, ${stretchAtr.toFixed(1)} ATR stretched.`
    : `${displayNameFor(input.instrument)} ${direction} mean reversion incomplete.`;
  const reason = status === "valid" ? "Stretched in a non-trending range with reversal confirmation." : conditions.find((item) => item.required && !item.passed)?.reason ?? "Setup incomplete.";
  return finalize(status, summary, reason, direction, plan, features);
}

export const meanReversionStrategy: Strategy<MeanReversionConfig> = {
  family: "meanrev",
  version: MEANREV_VERSION,
  defaultConfigVersion: MEANREV_CONFIG_VERSION,
  defaultConfig: DEFAULT_MEANREV_CONFIG,
  evaluate: evaluateMeanReversion,
};

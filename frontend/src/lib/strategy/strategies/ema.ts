import { displayNameFor } from "@/lib/instruments/catalog";
import { calculateEmaValues } from "@/lib/strategy/indicators";
import {
  buildTradePlan, completedCandles, condition, confirmationCandle, evaluateHardGates, finalizeCandidate,
} from "@/lib/strategy/strategy-common";
import type { Strategy, StrategyCandidate } from "@/lib/strategy/strategy";
import type { EmaFeatures, MarketRegime, StrategyCondition, StrategyEvaluationInput } from "@/lib/strategy/types";

/**
 * Strategy A — EMA Trend/Pullback V1.
 *
 * Continuation in an established trend: EMA stack aligned and sloping, price
 * pulls back into the fast/mid EMA value area without losing the slow EMA, then
 * shows a completed confirmation candle resuming the trend. Symmetric long and
 * short. A near-mirror of the retired `day-exploration-v1` idea, rebuilt on the
 * shared contract and driven entirely by config. Deliberately simple: this is a
 * clean baseline to measure, not an optimised system.
 */
export interface EmaConfig {
  emaFast: number;
  emaMid: number;
  emaSlow: number;
  /** Regime trend-strength (R²) floor; a ranging regime is rejected outright. */
  minTrendStrength: number;
  /** Bars over which the mid EMA slope is measured, normalized by ATR. */
  slopeLookbackBars: number;
  minSlopeAtrPerBar: number;
  /** Zone padding around the fast/mid EMAs, in ATR. */
  pullbackPadAtr: number;
  /** Reject when price sits further than this from the fast EMA (chasing). */
  maxExtensionAtr: number;
  requireConfirmation: boolean;
  /** Bars scanned for the structural stop. */
  stopLookbackBars: number;
  targetR: number;
  minStopAtr: number;
}

export const EMA_VERSION = "ema-v1";
export const EMA_CONFIG_VERSION = "ema-cfg-v1";

export const DEFAULT_EMA_CONFIG: EmaConfig = {
  emaFast: 21,
  emaMid: 50,
  emaSlow: 200,
  minTrendStrength: 0.3,
  slopeLookbackBars: 10,
  minSlopeAtrPerBar: 0.05,
  pullbackPadAtr: 0.35,
  maxExtensionAtr: 2.0,
  requireConfirmation: true,
  stopLookbackBars: 10,
  targetR: 2.0,
  minStopAtr: 1.0,
};

export function evaluateEma(input: StrategyEvaluationInput, regime: MarketRegime, config: EmaConfig): StrategyCandidate {
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
  const candles15m = completedCandles(input.candles15m);
  const candles1h = completedCandles(input.candles1h);
  const candles4h = completedCandles(input.candles4h);

  const gate = evaluateHardGates(input, evaluatedAt, candles15m, candles1h, candles4h);
  const conditions: StrategyCondition[] = [...gate.conditions];
  const finalize = (status: StrategyCandidate["status"], summary: string, reason: string, direction: StrategyCandidate["direction"], plan: ReturnType<typeof buildTradePlan> | null, features?: EmaFeatures) =>
    finalizeCandidate({
      family: "ema", version: EMA_VERSION, configVersion: EMA_CONFIG_VERSION, input, evaluatedAt, regime,
      direction, plan, conditions, status, summary, qualifyReason: reason,
      features: { trend15m: "mixed", trend1h: null, trend4h: null, ema21: regime.emaFast, ema50: regime.emaMid, ema200: regime.emaSlow, rsi14: null, atr14: regime.atr, atrPips: regime.atrPips, structureHighs: 0, structureLows: 0, regime, ema: features ?? null },
    });

  const gateFail = conditions.find((item) => item.required && !item.passed);
  if (gateFail) return finalize("no_setup", `${displayNameFor(input.instrument)} EMA setup blocked by ${gateFail.name.toLowerCase()}.`, gateFail.reason, null, null);

  const atr = regime.atr ?? 0;
  const closes = candles15m.map((candle) => candle.close);
  const fast = calculateEmaValues(closes, config.emaFast);
  const mid = calculateEmaValues(closes, config.emaMid);
  const slow = calculateEmaValues(closes, config.emaSlow);
  const emaFast = fast.at(-1) ?? null;
  const emaMid = mid.at(-1) ?? null;
  const emaSlow = slow.at(-1) ?? null;
  const last = candles15m.at(-1)!;

  if (emaFast === null || emaMid === null || emaSlow === null || atr <= 0) {
    return finalize("invalid", `${displayNameFor(input.instrument)} EMA inputs unavailable.`, "EMA or ATR values are unavailable.", null, null);
  }

  const bullish = emaFast > emaMid && emaMid > emaSlow;
  const bearish = emaFast < emaMid && emaMid < emaSlow;
  const direction = bullish ? "long" as const : bearish ? "short" as const : null;
  conditions.push(condition("EMA alignment", direction !== null,
    direction === "long" ? "Fast > mid > slow EMA." : direction === "short" ? "Fast < mid < slow EMA." : "The EMA stack is mixed.",
    `${emaFast.toFixed(5)}/${emaMid.toFixed(5)}/${emaSlow.toFixed(5)}`, true));
  if (!direction) return finalize("no_setup", `${displayNameFor(input.instrument)} has no aligned EMA trend.`, "EMA stack is mixed.", null, null);

  const trendOk = regime.regime !== "ranging" && regime.trendStrength >= config.minTrendStrength;
  conditions.push(condition("Trend strength", trendOk,
    trendOk ? `Regime is ${regime.regime} at R² ${regime.trendStrength.toFixed(2)}.` : `Regime is ${regime.regime} (R² ${regime.trendStrength.toFixed(2)}); not a trend.`,
    `${regime.regime} · ${regime.trendStrength.toFixed(2)}`, true));

  const priorMid = mid.at(-1 - config.slopeLookbackBars) ?? null;
  const slopeAtrPerBar = priorMid === null ? null : (emaMid - priorMid) / config.slopeLookbackBars / atr;
  const slopeOk = slopeAtrPerBar !== null && (direction === "long" ? slopeAtrPerBar >= config.minSlopeAtrPerBar : slopeAtrPerBar <= -config.minSlopeAtrPerBar);
  conditions.push(condition("EMA slope", slopeOk,
    slopeOk ? "The trend EMA is sloping with the direction." : "The trend EMA is too flat.",
    slopeAtrPerBar === null ? "unavailable" : `${slopeAtrPerBar.toFixed(3)} ATR/bar`, true));

  const zoneLow = Math.min(emaFast, emaMid) - atr * config.pullbackPadAtr;
  const zoneHigh = Math.max(emaFast, emaMid) + atr * config.pullbackPadAtr;
  const touchedZone = last.low <= zoneHigh && last.high >= zoneLow;
  const preservedStructure = direction === "long" ? last.low > emaSlow : last.high < emaSlow;
  const pullbackOk = touchedZone && preservedStructure;
  const pullbackDepthAtr = direction === "long" ? (emaFast - last.low) / atr : (last.high - emaFast) / atr;
  conditions.push(condition("Pullback", pullbackOk,
    pullbackOk ? "Price pulled into the EMA value area with the slow EMA intact." : "Price is not in a valid pullback zone or lost the slow EMA.",
    `close ${last.close.toFixed(5)}`, true));

  const distanceFromFastAtr = Math.abs(last.close - emaFast) / atr;
  const notExtended = distanceFromFastAtr <= config.maxExtensionAtr;
  conditions.push(condition("Not extended", notExtended,
    notExtended ? "Price is close enough to the fast EMA to enter." : "Price is too far from the fast EMA (chasing).",
    `${distanceFromFastAtr.toFixed(2)} ATR`, true));

  const confirmed = !config.requireConfirmation || confirmationCandle(candles15m, direction, atr);
  conditions.push(condition("Confirmation", confirmed,
    confirmed ? "Completed candle resumes the trend direction." : "No completed confirmation candle in the trend direction.",
    confirmed ? "confirmed" : "none", config.requireConfirmation));

  const window = candles15m.slice(-config.stopLookbackBars);
  const rawStop = direction === "long" ? Math.min(...window.map((candle) => candle.low)) : Math.max(...window.map((candle) => candle.high));
  const plan = buildTradePlan(input, direction, rawStop, atr, { targetR: config.targetR, minStopAtr: config.minStopAtr });

  const features: EmaFeatures = {
    emaFast, emaMid, emaSlow, aligned: true, slopeAtrPerBar,
    pullbackDepthAtr: Number.isFinite(pullbackDepthAtr) ? pullbackDepthAtr : null,
    distanceFromFastAtr, extensionAtr: distanceFromFastAtr, confirmation: confirmed,
  };

  const hardFailed = conditions.some((item) => item.required && !item.passed);
  const planValid = plan.entry !== null && plan.stop !== null && plan.target !== null;
  const status = !planValid ? "invalid" : hardFailed ? "no_setup" : "valid";
  const summary = status === "valid"
    ? `${displayNameFor(input.instrument)} ${direction} EMA pullback with confirmation.`
    : `${displayNameFor(input.instrument)} ${direction} EMA setup incomplete.`;
  const reason = status === "valid" ? "Aligned trend, valid pullback, resumed in-direction." : conditions.find((item) => item.required && !item.passed)?.reason ?? "Setup incomplete.";
  return finalize(status, summary, reason, direction, plan, features);
}

export const emaStrategy: Strategy<EmaConfig> = {
  family: "ema",
  version: EMA_VERSION,
  defaultConfigVersion: EMA_CONFIG_VERSION,
  defaultConfig: DEFAULT_EMA_CONFIG,
  evaluate: evaluateEma,
};

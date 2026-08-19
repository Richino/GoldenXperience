import { displayNameFor } from "@/lib/instruments/catalog";
import { calculateRsiValues } from "@/lib/strategy/indicators";
import {
  buildTradePlan, completedCandles, condition, evaluateHardGates, finalizeCandidate,
} from "@/lib/strategy/strategy-common";
import type { Strategy, StrategyCandidate } from "@/lib/strategy/strategy";
import type { MarketRegime, MomentumFeatures, StrategyCondition, StrategyEvaluationInput } from "@/lib/strategy/types";

/**
 * Strategy C — Momentum V1.
 *
 * Trades genuine directional acceleration: an ATR-normalized run over a short
 * window, backed by a strong directional candle body and consecutive in-
 * direction closes, while the move is still accelerating and not yet
 * exhausted. RSI is only an over-extension guard, never the signal itself.
 * Symmetric long and short. Independent of the other strategies.
 */
export interface MomentumConfig {
  returnLookbackBars: number;
  /** Minimum close-to-close run over the window, in ATR. */
  minReturnAtr: number;
  /** Minimum body/range of the latest candle. */
  minBodyRatio: number;
  minConsecutive: number;
  accelerationBars: number;
  extensionLookbackBars: number;
  /** Reject when the longer-window move is already this large (exhausted). */
  maxExtensionAtr: number;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  stopLookbackBars: number;
  stopBufferAtr: number;
  targetR: number;
  minStopAtr: number;
}

export const MOMENTUM_VERSION = "momentum-v1";
export const MOMENTUM_CONFIG_VERSION = "momentum-cfg-v1";

export const DEFAULT_MOMENTUM_CONFIG: MomentumConfig = {
  returnLookbackBars: 5,
  minReturnAtr: 1.5,
  minBodyRatio: 0.5,
  minConsecutive: 2,
  accelerationBars: 3,
  extensionLookbackBars: 15,
  maxExtensionAtr: 4.0,
  rsiPeriod: 14,
  rsiOverbought: 80,
  rsiOversold: 20,
  stopLookbackBars: 6,
  stopBufferAtr: 0.5,
  targetR: 2.0,
  minStopAtr: 1.0,
};

function consecutiveInDirection(candles: { open: number; close: number }[], direction: "long" | "short"): number {
  let count = 0;
  for (let index = candles.length - 1; index >= 0; index -= 1) {
    const candle = candles[index]!;
    const up = candle.close > candle.open;
    const down = candle.close < candle.open;
    if ((direction === "long" && up) || (direction === "short" && down)) count += 1; else break;
  }
  return count;
}

export function evaluateMomentum(input: StrategyEvaluationInput, regime: MarketRegime, config: MomentumConfig): StrategyCandidate {
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
  const candles15m = completedCandles(input.candles15m);
  const candles1h = completedCandles(input.candles1h);
  const candles4h = completedCandles(input.candles4h);

  const gate = evaluateHardGates(input, evaluatedAt, candles15m, candles1h, candles4h);
  const conditions: StrategyCondition[] = [...gate.conditions];
  const finalize = (status: StrategyCandidate["status"], summary: string, reason: string, direction: StrategyCandidate["direction"], plan: ReturnType<typeof buildTradePlan> | null, features?: MomentumFeatures) =>
    finalizeCandidate({
      family: "momentum", version: MOMENTUM_VERSION, configVersion: MOMENTUM_CONFIG_VERSION, input, evaluatedAt, regime,
      direction, plan, conditions, status, summary, qualifyReason: reason,
      features: { trend15m: "mixed", trend1h: null, trend4h: null, ema21: regime.emaFast, ema50: regime.emaMid, ema200: regime.emaSlow, rsi14: features?.rsi14 ?? null, atr14: regime.atr, atrPips: regime.atrPips, structureHighs: 0, structureLows: 0, regime, momentum: features ?? null },
    });

  const gateFail = conditions.find((item) => item.required && !item.passed);
  if (gateFail) return finalize("no_setup", `${displayNameFor(input.instrument)} momentum blocked by ${gateFail.name.toLowerCase()}.`, gateFail.reason, null, null);

  const atr = regime.atr ?? 0;
  if (atr <= 0 || candles15m.length < config.extensionLookbackBars + 1) {
    return finalize("invalid", `${displayNameFor(input.instrument)} momentum inputs unavailable.`, "ATR or candle history is insufficient.", null, null);
  }

  const closes = candles15m.map((candle) => candle.close);
  const last = candles15m.at(-1)!;
  const priorClose = closes.at(-1 - config.returnLookbackBars)!;
  const momentumAbs = last.close - priorClose;
  const momentumAtr = momentumAbs / atr;
  const direction = momentumAtr > 0 ? "long" as const : momentumAtr < 0 ? "short" as const : null;
  const returnPct = priorClose === 0 ? null : momentumAbs / priorClose;

  const strongEnough = direction !== null && Math.abs(momentumAtr) >= config.minReturnAtr;
  conditions.push(condition("Directional run", strongEnough,
    strongEnough ? `Price ran ${Math.abs(momentumAtr).toFixed(2)} ATR over ${config.returnLookbackBars} bars.` : "No strong directional run.",
    `${momentumAtr.toFixed(2)} ATR`, true));
  if (!direction || !strongEnough) return finalize("no_setup", `${displayNameFor(input.instrument)} has no momentum run.`, "No strong directional run.", direction, null);

  const range = last.high - last.low;
  const bodyRatio = range > 0 ? Math.abs(last.close - last.open) / range : 0;
  const directionalBody = direction === "long" ? last.close > last.open : last.close < last.open;
  const bodyOk = directionalBody && bodyRatio >= config.minBodyRatio;
  conditions.push(condition("Candle strength", bodyOk,
    bodyOk ? "The latest candle body is strong and in-direction." : "The latest candle is weak or against the move.",
    `${bodyRatio.toFixed(2)} body ratio`, true));

  const consecutive = consecutiveInDirection(candles15m.slice(-10), direction);
  const consecutiveOk = consecutive >= config.minConsecutive;
  conditions.push(condition("Consecutive bars", consecutiveOk,
    consecutiveOk ? `${consecutive} consecutive in-direction candles.` : "Not enough consecutive directional candles.",
    `${consecutive}`, true));

  const recent = (last.close - closes.at(-1 - config.accelerationBars)!) / atr;
  const before = (closes.at(-1 - config.accelerationBars)! - closes.at(-1 - config.accelerationBars * 2)!) / atr;
  const accelerationAtr = recent - before;
  const accelerating = direction === "long" ? recent >= before && recent > 0 : recent <= before && recent < 0;
  conditions.push(condition("Accelerating", accelerating,
    accelerating ? "The move is accelerating, not stalling." : "The move is stalling.",
    `${accelerationAtr.toFixed(2)} ATR`, true));

  const extensionAtr = Math.abs(last.close - closes.at(-1 - config.extensionLookbackBars)!) / atr;
  const rsi = calculateRsiValues(closes, config.rsiPeriod).at(-1) ?? null;
  const rsiExtreme = rsi !== null && (direction === "long" ? rsi >= config.rsiOverbought : rsi <= config.rsiOversold);
  const notExhausted = extensionAtr <= config.maxExtensionAtr && !rsiExtreme;
  conditions.push(condition("Not exhausted", notExhausted,
    notExhausted ? "The move is not already exhausted." : "Price is already over-extended or RSI is at an extreme.",
    `${extensionAtr.toFixed(2)} ATR · RSI ${rsi === null ? "n/a" : rsi.toFixed(0)}`, true));

  const window = candles15m.slice(-config.stopLookbackBars);
  const rawStop = direction === "long" ? Math.min(...window.map((candle) => candle.low)) - atr * config.stopBufferAtr : Math.max(...window.map((candle) => candle.high)) + atr * config.stopBufferAtr;
  const plan = buildTradePlan(input, direction, rawStop, atr, { targetR: config.targetR, minStopAtr: config.minStopAtr });

  const features: MomentumFeatures = {
    momentumAtr, returnPct, accelerationAtr, bodyRatio, consecutiveBars: consecutive, extensionAtr, rsi14: rsi,
  };

  const hardFailed = conditions.some((item) => item.required && !item.passed);
  const planValid = plan.entry !== null && plan.stop !== null && plan.target !== null;
  const status = !planValid ? "invalid" : hardFailed ? "no_setup" : "valid";
  const summary = status === "valid"
    ? `${displayNameFor(input.instrument)} ${direction} momentum, ${Math.abs(momentumAtr).toFixed(1)} ATR run.`
    : `${displayNameFor(input.instrument)} ${direction} momentum incomplete.`;
  const reason = status === "valid" ? "Accelerating in-direction run, not exhausted." : conditions.find((item) => item.required && !item.passed)?.reason ?? "Setup incomplete.";
  return finalize(status, summary, reason, direction, plan, features);
}

export const momentumStrategy: Strategy<MomentumConfig> = {
  family: "momentum",
  version: MOMENTUM_VERSION,
  defaultConfigVersion: MOMENTUM_CONFIG_VERSION,
  defaultConfig: DEFAULT_MOMENTUM_CONFIG,
  evaluate: evaluateMomentum,
};

/**
 * Early Momentum ignition detector — research only.
 *
 * M15 candles define a completed compression range. A completed M5 candle may
 * then trigger only when it breaks both that frozen M15 range and the preceding
 * M5 micro-range with a strong, directional close. Entry is the next M5 open,
 * provided price has not already extended too far from the broken level.
 *
 * The detector never imports the production strategy or execution pipeline.
 */

export type MomentumIgnitionDirection = "long" | "short";
export type MomentumHourlyContext = MomentumIgnitionDirection | "mixed";

export interface MomentumIgnitionBar {
  closeTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** OANDA broker tick activity when available; never treated as centralized volume. */
  volume?: number;
}

export interface MomentumEarlyIgnitionConfig {
  searchLeadMinutes: number;
  compressionBars: number;
  maxCompressionRangeAtr: number;
  microBreakBars: number;
  atrPeriod: number;
  breakoutBufferM15Atr: number;
  minBodyRatio: number;
  minBodyM5Atr: number;
  maxCloseFromExtremeFraction: number;
  maxEntryExtensionM15Atr: number;
}

/** Frozen before running the recorded-47 replay. */
export const MOMENTUM_EARLY_IGNITION_CONFIG: Readonly<MomentumEarlyIgnitionConfig> = Object.freeze({
  searchLeadMinutes: 90,
  compressionBars: 4,
  maxCompressionRangeAtr: 2.0,
  microBreakBars: 6,
  atrPeriod: 14,
  breakoutBufferM15Atr: 0.03,
  minBodyRatio: 0.60,
  minBodyM5Atr: 0.50,
  maxCloseFromExtremeFraction: 0.25,
  maxEntryExtensionM15Atr: 0.50,
});

export interface MomentumEarlyIgnitionDecision {
  version: "momentum-early-ignition-v1";
  action: "ignite" | "wait";
  direction: MomentumIgnitionDirection | null;
  ruleStrength: number;
  triggerIndex: number | null;
  entryIndex: number | null;
  triggerAt: string | null;
  entryAt: string | null;
  leadMinutes: number | null;
  breakoutLevel: number | null;
  compressionHigh: number | null;
  compressionLow: number | null;
  compressionRangeAtr: number | null;
  m15Atr: number | null;
  m5Atr: number | null;
  bodyRatio: number | null;
  bodyM5Atr: number | null;
  entryExtensionM15Atr: number | null;
  hourlyContext: MomentumHourlyContext | null;
  reason: string;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function average(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function validConfig(config: MomentumEarlyIgnitionConfig): boolean {
  return Number.isInteger(config.searchLeadMinutes) && config.searchLeadMinutes >= 5
    && Number.isInteger(config.compressionBars) && config.compressionBars >= 2
    && config.maxCompressionRangeAtr > 0
    && Number.isInteger(config.microBreakBars) && config.microBreakBars >= 2
    && Number.isInteger(config.atrPeriod) && config.atrPeriod >= 2
    && config.breakoutBufferM15Atr >= 0
    && config.minBodyRatio > 0 && config.minBodyRatio <= 1
    && config.minBodyM5Atr > 0
    && config.maxCloseFromExtremeFraction >= 0 && config.maxCloseFromExtremeFraction < 0.5
    && config.maxEntryExtensionM15Atr > 0;
}

function atrAtEnd(bars: readonly MomentumIgnitionBar[], period: number): number | null {
  if (bars.length < period + 1) return null;
  const trueRanges: number[] = [];
  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index]!;
    const previous = bars[index - 1]!;
    trueRanges.push(Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previous.close),
      Math.abs(bar.low - previous.close),
    ));
  }
  const recent = trueRanges.slice(-period);
  if (recent.length !== period) return null;
  const value = average(recent);
  return value > 0 && Number.isFinite(value) ? value : null;
}

function hourlyContext(bars: readonly MomentumIgnitionBar[], atr: number): MomentumHourlyContext {
  if (bars.length < 8) return "mixed";
  const prior = average(bars.slice(-8, -4).map((bar) => bar.close));
  const recent = average(bars.slice(-4).map((bar) => bar.close));
  const changeAtr = (recent - prior) / atr;
  return changeAtr >= 0.05 ? "long" : changeAtr <= -0.05 ? "short" : "mixed";
}

function wait(reason: string): MomentumEarlyIgnitionDecision {
  return {
    version: "momentum-early-ignition-v1",
    action: "wait",
    direction: null,
    ruleStrength: 0,
    triggerIndex: null,
    entryIndex: null,
    triggerAt: null,
    entryAt: null,
    leadMinutes: null,
    breakoutLevel: null,
    compressionHigh: null,
    compressionLow: null,
    compressionRangeAtr: null,
    m15Atr: null,
    m5Atr: null,
    bodyRatio: null,
    bodyM5Atr: null,
    entryExtensionM15Atr: null,
    hourlyContext: null,
    reason,
  };
}

export function detectMomentumEarlyIgnition(input: {
  m15Bars: readonly MomentumIgnitionBar[];
  m5Bars: readonly MomentumIgnitionBar[];
  originalDecisionTime: string;
  config?: MomentumEarlyIgnitionConfig;
}): MomentumEarlyIgnitionDecision {
  const config = input.config ?? MOMENTUM_EARLY_IGNITION_CONFIG;
  if (!validConfig(config)) throw new Error("Invalid Momentum early ignition configuration.");
  const decisionMs = Date.parse(input.originalDecisionTime);
  if (!Number.isFinite(decisionMs)) throw new Error("Momentum early ignition requires a valid original decision time.");

  const searchStartMs = decisionMs - config.searchLeadMinutes * 60_000;
  const minimumHistory = Math.max(config.atrPeriod + 1, config.compressionBars, 8);

  for (let triggerIndex = config.atrPeriod + config.microBreakBars; triggerIndex < input.m5Bars.length - 1; triggerIndex += 1) {
    const trigger = input.m5Bars[triggerIndex]!;
    const triggerMs = Date.parse(trigger.closeTime);
    if (triggerMs < searchStartMs || triggerMs >= decisionMs) continue;

    // The range must have been fully completed before this M5 candle opened.
    const triggerOpenMs = triggerMs - 5 * 60_000;
    const knownM15 = input.m15Bars.filter((bar) => Date.parse(bar.closeTime) <= triggerOpenMs);
    if (knownM15.length < minimumHistory) continue;

    const m15Atr = atrAtEnd(knownM15, config.atrPeriod);
    const priorM5 = input.m5Bars.slice(0, triggerIndex);
    const m5Atr = atrAtEnd(priorM5, config.atrPeriod);
    if (m15Atr === null || m5Atr === null) continue;

    const compression = knownM15.slice(-config.compressionBars);
    const compressionHigh = Math.max(...compression.map((bar) => bar.high));
    const compressionLow = Math.min(...compression.map((bar) => bar.low));
    const compressionRangeAtr = (compressionHigh - compressionLow) / m15Atr;
    if (compressionRangeAtr > config.maxCompressionRangeAtr) continue;

    const micro = priorM5.slice(-config.microBreakBars);
    if (micro.length !== config.microBreakBars) continue;
    const microHigh = Math.max(...micro.map((bar) => bar.high));
    const microLow = Math.min(...micro.map((bar) => bar.low));
    const buffer = m15Atr * config.breakoutBufferM15Atr;
    const longLevel = Math.max(compressionHigh, microHigh);
    const shortLevel = Math.min(compressionLow, microLow);
    const longBreak = trigger.close >= longLevel + buffer;
    const shortBreak = trigger.close <= shortLevel - buffer;
    if (longBreak === shortBreak) continue;

    const direction: MomentumIgnitionDirection = longBreak ? "long" : "short";
    const breakoutLevel = direction === "long" ? longLevel : shortLevel;
    const range = trigger.high - trigger.low;
    const body = Math.abs(trigger.close - trigger.open);
    const bodyRatio = range > 0 ? body / range : 0;
    const bodyM5Atr = body / m5Atr;
    const directionalBody = direction === "long" ? trigger.close > trigger.open : trigger.close < trigger.open;
    const closeFromExtremeFraction = range > 0
      ? direction === "long" ? (trigger.high - trigger.close) / range : (trigger.close - trigger.low) / range
      : 1;
    if (!directionalBody
      || bodyRatio < config.minBodyRatio
      || bodyM5Atr < config.minBodyM5Atr
      || closeFromExtremeFraction > config.maxCloseFromExtremeFraction) continue;

    const entryIndex = triggerIndex + 1;
    const entryBar = input.m5Bars[entryIndex]!;
    const entryOpenMs = Date.parse(entryBar.closeTime) - 5 * 60_000;
    if (entryOpenMs !== triggerMs) continue;
    const entryExtensionM15Atr = direction === "long"
      ? (entryBar.open - breakoutLevel) / m15Atr
      : (breakoutLevel - entryBar.open) / m15Atr;
    if (entryExtensionM15Atr > config.maxEntryExtensionM15Atr) continue;

    const context = hourlyContext(knownM15, m15Atr);
    const compressionScore = 10 + 10 * clamp(1 - compressionRangeAtr / config.maxCompressionRangeAtr, 0, 1);
    const bodyScore = 10 + 10 * clamp((bodyRatio - config.minBodyRatio) / (1 - config.minBodyRatio), 0, 1);
    const displacementScore = 10 + 5 * clamp((bodyM5Atr - config.minBodyM5Atr) / 1.5, 0, 1);
    const closeScore = 10 * clamp(1 - closeFromExtremeFraction / config.maxCloseFromExtremeFraction, 0, 1);
    const contextScore = context === direction ? 10 : context === "mixed" ? 5 : 0;
    const extensionScore = 5 * clamp(1 - Math.max(0, entryExtensionM15Atr) / config.maxEntryExtensionM15Atr, 0, 1);
    const ruleStrength = clamp(30 + compressionScore + bodyScore + displacementScore + closeScore + contextScore + extensionScore, 0, 100);

    return {
      version: "momentum-early-ignition-v1",
      action: "ignite",
      direction,
      ruleStrength,
      triggerIndex,
      entryIndex,
      triggerAt: trigger.closeTime,
      entryAt: trigger.closeTime,
      leadMinutes: (decisionMs - triggerMs) / 60_000,
      breakoutLevel,
      compressionHigh,
      compressionLow,
      compressionRangeAtr,
      m15Atr,
      m5Atr,
      bodyRatio,
      bodyM5Atr,
      entryExtensionM15Atr,
      hourlyContext: context,
      reason: "A completed M5 candle broke the frozen M15 compression and M5 micro-range with a strong close; the next M5 open was not extended.",
    };
  }

  return wait("No non-extended M5 ignition broke a completed M15 compression before the original Momentum decision.");
}

export function invertMomentumIgnitionDirection(direction: MomentumIgnitionDirection): MomentumIgnitionDirection {
  return direction === "long" ? "short" : "long";
}

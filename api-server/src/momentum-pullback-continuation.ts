/**
 * Momentum impulse -> pullback -> continuation pattern — research only.
 *
 * An already-qualified M5 ignition supplies the impulse. This policy waits for
 * two or three smaller countertrend M5 candles, then requires the first
 * in-direction candle to close beyond the pullback. Entry is the next M5 open,
 * the stop sits beyond the pullback, and the target is a fixed 2R.
 */
import type { MomentumIgnitionBar, MomentumIgnitionDirection } from "./momentum-early-ignition.js";

export interface MomentumPullbackContinuationConfig {
  impulseLookbackBars: number;
  minImpulseM15Atr: number;
  maxPrePullbackBars: number;
  minPullbackBars: number;
  maxPullbackBars: number;
  minRetracementFraction: number;
  maxRetracementFraction: number;
  maxPullbackBarRangeImpulse: number;
  resumeBufferM15Atr: number;
  maxEntryExtensionM15Atr: number;
  stopBufferM15Atr: number;
  minStopM15Atr: number;
  maxStopM15Atr: number;
  targetR: number;
  structureLookbackBars: number;
}

/** Frozen before the recorded-47 replay. */
export const MOMENTUM_PULLBACK_CONTINUATION_CONFIG: Readonly<MomentumPullbackContinuationConfig> = Object.freeze({
  impulseLookbackBars: 3,
  minImpulseM15Atr: 0.35,
  maxPrePullbackBars: 1,
  minPullbackBars: 2,
  maxPullbackBars: 3,
  minRetracementFraction: 0.10,
  maxRetracementFraction: 0.50,
  maxPullbackBarRangeImpulse: 0.75,
  resumeBufferM15Atr: 0.02,
  maxEntryExtensionM15Atr: 0.25,
  stopBufferM15Atr: 0.05,
  minStopM15Atr: 0.10,
  maxStopM15Atr: 0.75,
  targetR: 2,
  structureLookbackBars: 24,
});

export interface MomentumPullbackContinuationDecision {
  version: "momentum-pullback-continuation-v1";
  action: "trade" | "wait";
  direction: MomentumIgnitionDirection | null;
  ruleStrength: number;
  pullbackBars: number | null;
  resumeIndex: number | null;
  entryIndex: number | null;
  knownAt: string | null;
  entryAt: string | null;
  impulseM15Atr: number | null;
  retracementFraction: number | null;
  pullbackBreakLevel: number | null;
  pullbackLow: number | null;
  pullbackHigh: number | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  stopDistance: number | null;
  targetDistance: number | null;
  entryExtensionM15Atr: number | null;
  structureRoomR: number | null;
  pullbackTickActivityRatio: number | null;
  liquidSession: boolean | null;
  reason: string;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function average(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function wait(reason: string, partial: Partial<MomentumPullbackContinuationDecision> = {}): MomentumPullbackContinuationDecision {
  return {
    version: "momentum-pullback-continuation-v1",
    action: "wait",
    direction: null,
    ruleStrength: 0,
    pullbackBars: null,
    resumeIndex: null,
    entryIndex: null,
    knownAt: null,
    entryAt: null,
    impulseM15Atr: null,
    retracementFraction: null,
    pullbackBreakLevel: null,
    pullbackLow: null,
    pullbackHigh: null,
    entry: null,
    stop: null,
    target: null,
    stopDistance: null,
    targetDistance: null,
    entryExtensionM15Atr: null,
    structureRoomR: null,
    pullbackTickActivityRatio: null,
    liquidSession: null,
    reason,
    ...partial,
  };
}

function validConfig(config: MomentumPullbackContinuationConfig): boolean {
  return Number.isInteger(config.impulseLookbackBars) && config.impulseLookbackBars >= 1
    && config.minImpulseM15Atr > 0
    && Number.isInteger(config.maxPrePullbackBars) && config.maxPrePullbackBars >= 0
    && Number.isInteger(config.minPullbackBars) && config.minPullbackBars >= 1
    && Number.isInteger(config.maxPullbackBars) && config.maxPullbackBars >= config.minPullbackBars
    && config.minRetracementFraction >= 0 && config.maxRetracementFraction > config.minRetracementFraction && config.maxRetracementFraction < 1
    && config.maxPullbackBarRangeImpulse > 0
    && config.resumeBufferM15Atr >= 0
    && config.maxEntryExtensionM15Atr > 0
    && config.stopBufferM15Atr >= 0
    && config.minStopM15Atr > 0 && config.maxStopM15Atr > config.minStopM15Atr
    && config.targetR > 0
    && Number.isInteger(config.structureLookbackBars) && config.structureLookbackBars >= 1;
}

export function detectMomentumPullbackContinuation(input: {
  bars: readonly MomentumIgnitionBar[];
  breakoutIndex: number;
  direction: MomentumIgnitionDirection;
  m15Atr: number;
  config?: MomentumPullbackContinuationConfig;
}): MomentumPullbackContinuationDecision {
  const config = input.config ?? MOMENTUM_PULLBACK_CONTINUATION_CONFIG;
  if (!validConfig(config)) throw new Error("Invalid Momentum pullback continuation configuration.");
  if (!Number.isInteger(input.breakoutIndex) || input.breakoutIndex < config.impulseLookbackBars - 1 || input.breakoutIndex >= input.bars.length) {
    throw new Error("Momentum pullback continuation requires a valid completed breakout impulse.");
  }
  if (!(input.m15Atr > 0) || !Number.isFinite(input.m15Atr)) throw new Error("Momentum pullback continuation requires positive M15 ATR.");

  const impulseStartIndex = input.breakoutIndex - config.impulseLookbackBars + 1;
  const impulseBars = input.bars.slice(impulseStartIndex, input.breakoutIndex + 1);
  const impulseStart = input.direction === "long"
    ? Math.min(...impulseBars.map((bar) => bar.low))
    : Math.max(...impulseBars.map((bar) => bar.high));
  const impulseExtreme = input.direction === "long"
    ? Math.max(...impulseBars.map((bar) => bar.high))
    : Math.min(...impulseBars.map((bar) => bar.low));
  const impulseRange = Math.abs(impulseExtreme - impulseStart);
  const impulseM15Atr = impulseRange / input.m15Atr;
  if (impulseM15Atr < config.minImpulseM15Atr) return wait("The initial M5 impulse was too small relative to M15 ATR.", { impulseM15Atr });

  const isCountertrend = (bar: MomentumIgnitionBar) => input.direction === "long" ? bar.close < bar.open : bar.close > bar.open;
  const isDirectional = (bar: MomentumIgnitionBar) => input.direction === "long" ? bar.close > bar.open : bar.close < bar.open;
  const pullback: MomentumIgnitionBar[] = [];
  let prePullbackBars = 0;
  let resumeIndex: number | null = null;

  for (let index = input.breakoutIndex + 1; index < input.bars.length - 1; index += 1) {
    const bar = input.bars[index]!;
    if (pullback.length === 0) {
      if (!isCountertrend(bar)) {
        prePullbackBars += 1;
        if (prePullbackBars > config.maxPrePullbackBars) return wait("No timely countertrend pullback formed after the impulse.", { impulseM15Atr });
        continue;
      }
      pullback.push(bar);
      continue;
    }

    if (isCountertrend(bar)) {
      pullback.push(bar);
      if (pullback.length > config.maxPullbackBars) return wait("The pullback lasted longer than three countertrend M5 candles.", { impulseM15Atr, pullbackBars: pullback.length });
      continue;
    }

    if (pullback.length < config.minPullbackBars) return wait("The pullback ended before two countertrend M5 candles completed.", { impulseM15Atr, pullbackBars: pullback.length });
    if (!isDirectional(bar)) return wait("The first candle after the pullback did not resume the impulse direction.", { impulseM15Atr, pullbackBars: pullback.length });

    const pullbackHigh = Math.max(...pullback.map((item) => item.high));
    const pullbackLow = Math.min(...pullback.map((item) => item.low));
    const pullbackBreakLevel = input.direction === "long" ? pullbackHigh : pullbackLow;
    const resumed = input.direction === "long"
      ? bar.close >= pullbackBreakLevel + input.m15Atr * config.resumeBufferM15Atr
      : bar.close <= pullbackBreakLevel - input.m15Atr * config.resumeBufferM15Atr;
    if (!resumed) return wait("The first directional candle did not close beyond the pullback.", {
      impulseM15Atr, pullbackBars: pullback.length, pullbackBreakLevel, pullbackLow, pullbackHigh,
    });
    resumeIndex = index;
    break;
  }

  if (resumeIndex === null) return wait("No completed resumption candle formed before replay data ended.", { impulseM15Atr, pullbackBars: pullback.length || null });

  const pullbackHigh = Math.max(...pullback.map((bar) => bar.high));
  const pullbackLow = Math.min(...pullback.map((bar) => bar.low));
  const pullbackBreakLevel = input.direction === "long" ? pullbackHigh : pullbackLow;
  const oversized = pullback.some((bar) => (bar.high - bar.low) / impulseRange > config.maxPullbackBarRangeImpulse);
  if (oversized) return wait("At least one pullback candle was too large relative to the impulse.", {
    impulseM15Atr, pullbackBars: pullback.length, pullbackBreakLevel, pullbackLow, pullbackHigh,
  });

  const retracementFraction = input.direction === "long"
    ? (impulseExtreme - pullbackLow) / impulseRange
    : (pullbackHigh - impulseExtreme) / impulseRange;
  if (retracementFraction < config.minRetracementFraction || retracementFraction > config.maxRetracementFraction) {
    return wait("The pullback retracement was outside the frozen 10% to 50% impulse range.", {
      impulseM15Atr, pullbackBars: pullback.length, retracementFraction, pullbackBreakLevel, pullbackLow, pullbackHigh,
    });
  }

  const entryIndex = resumeIndex + 1;
  const resume = input.bars[resumeIndex]!;
  const entryBar = input.bars[entryIndex]!;
  const entryOpenAt = Date.parse(entryBar.closeTime) - 5 * 60_000;
  if (entryOpenAt !== Date.parse(resume.closeTime)) return wait("The next M5 entry candle was unavailable or discontinuous.", { impulseM15Atr });
  const entry = entryBar.open;
  const entryExtensionM15Atr = input.direction === "long"
    ? (entry - pullbackBreakLevel) / input.m15Atr
    : (pullbackBreakLevel - entry) / input.m15Atr;
  if (entryExtensionM15Atr < 0 || entryExtensionM15Atr > config.maxEntryExtensionM15Atr) {
    return wait("The next M5 open was no longer a valid non-extended pullback break.", {
      impulseM15Atr, pullbackBars: pullback.length, retracementFraction, pullbackBreakLevel, pullbackLow, pullbackHigh, entryExtensionM15Atr,
    });
  }

  const stop = input.direction === "long"
    ? pullbackLow - input.m15Atr * config.stopBufferM15Atr
    : pullbackHigh + input.m15Atr * config.stopBufferM15Atr;
  const stopDistance = Math.abs(entry - stop);
  const stopM15Atr = stopDistance / input.m15Atr;
  if (stopM15Atr < config.minStopM15Atr || stopM15Atr > config.maxStopM15Atr) {
    return wait("The structural pullback stop was not tight enough for the frozen Momentum risk rule.", {
      impulseM15Atr, pullbackBars: pullback.length, retracementFraction, pullbackBreakLevel, pullbackLow, pullbackHigh, entry, stop, stopDistance, entryExtensionM15Atr,
    });
  }
  const targetDistance = stopDistance * config.targetR;
  const target = input.direction === "long" ? entry + targetDistance : entry - targetDistance;

  const priorStructure = input.bars.slice(Math.max(0, impulseStartIndex - config.structureLookbackBars), impulseStartIndex);
  const opposingLevel = priorStructure.length === 0 ? null : input.direction === "long"
    ? Math.max(...priorStructure.map((bar) => bar.high))
    : Math.min(...priorStructure.map((bar) => bar.low));
  const structureRoom = opposingLevel === null ? Number.POSITIVE_INFINITY : input.direction === "long"
    ? opposingLevel <= entry ? Number.POSITIVE_INFINITY : opposingLevel - entry
    : opposingLevel >= entry ? Number.POSITIVE_INFINITY : entry - opposingLevel;
  const structureRoomR = structureRoom / stopDistance;
  if (structureRoomR < config.targetR) {
    return wait("Nearby prior M5 structure did not leave two reward units of room.", {
      impulseM15Atr, pullbackBars: pullback.length, retracementFraction, pullbackBreakLevel, pullbackLow, pullbackHigh,
      entry, stop, target, stopDistance, targetDistance, entryExtensionM15Atr, structureRoomR,
    });
  }

  const impulseVolumes = impulseBars.flatMap((bar) => bar.volume === undefined ? [] : [bar.volume]);
  const pullbackVolumes = pullback.flatMap((bar) => bar.volume === undefined ? [] : [bar.volume]);
  const pullbackTickActivityRatio = impulseVolumes.length === impulseBars.length && pullbackVolumes.length === pullback.length
    ? average(pullbackVolumes) / average(impulseVolumes)
    : null;
  const hour = new Date(resume.closeTime).getUTCHours();
  const liquidSession = hour >= 7 && hour < 16;
  const compactness = average(pullback.map((bar) => (bar.high - bar.low) / impulseRange));
  const retracementScore = 10 * clamp(1 - Math.abs(retracementFraction - 0.30) / 0.20, 0, 1);
  const impulseScore = 10 * clamp((impulseM15Atr - config.minImpulseM15Atr) / 0.65, 0, 1);
  const compactnessScore = 10 * clamp(1 - compactness / config.maxPullbackBarRangeImpulse, 0, 1);
  const activityScore = pullbackTickActivityRatio === null ? 0 : 5 * clamp(1 - pullbackTickActivityRatio, 0, 1);
  const sessionScore = liquidSession ? 5 : 0;
  const entryScore = 5 * clamp(1 - entryExtensionM15Atr / config.maxEntryExtensionM15Atr, 0, 1);
  const ruleStrength = clamp(55 + retracementScore + impulseScore + compactnessScore + activityScore + sessionScore + entryScore, 0, 100);

  return {
    version: "momentum-pullback-continuation-v1",
    action: "trade",
    direction: input.direction,
    ruleStrength,
    pullbackBars: pullback.length,
    resumeIndex,
    entryIndex,
    knownAt: resume.closeTime,
    entryAt: resume.closeTime,
    impulseM15Atr,
    retracementFraction,
    pullbackBreakLevel,
    pullbackLow,
    pullbackHigh,
    entry,
    stop,
    target,
    stopDistance,
    targetDistance,
    entryExtensionM15Atr,
    structureRoomR,
    pullbackTickActivityRatio,
    liquidSession,
    reason: "A strong M5 impulse formed two or three compact countertrend candles, then closed through the pullback with a structural stop and at least 2R room.",
  };
}

export function invertMomentumPullbackDirection(direction: MomentumIgnitionDirection): MomentumIgnitionDirection {
  return direction === "long" ? "short" : "long";
}

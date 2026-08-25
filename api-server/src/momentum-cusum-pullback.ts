/**
 * Fresh Momentum change detector and pullback continuation policy.
 *
 * Research only. Completed M1 returns feed a two-sided, volatility-normalized
 * CUSUM. A trigger is only a fresh impulse candidate; it becomes tradable after
 * a compact 2/3-candle countertrend pullback closes back through its micro swing.
 * A completed M5 ATR, known at the M1 decision time, normalizes geometry.
 */

export type MomentumCusumDirection = "long" | "short";

export interface MomentumCusumBar {
  closeTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface MomentumCusumConfig {
  volatilityLookbackBars: number;
  cusumThreshold: number;
  cusumDrift: number;
  maxReturnZ: number;
  refractoryBars: number;
  impulseLookbackBars: number;
  minImpulseM5Atr: number;
  maxImpulseM5Atr: number;
  maxPrePullbackBars: number;
  minPullbackBars: number;
  maxPullbackBars: number;
  minRetracementFraction: number;
  maxRetracementFraction: number;
  maxPullbackBarRangeImpulse: number;
  resumeBufferM5Atr: number;
  maxEntryExtensionM5Atr: number;
  stopBufferM5Atr: number;
  minStopM5Atr: number;
  maxStopM5Atr: number;
  targetR: number;
  structureLookbackBars: number;
  calibrationMinimumSamples: number;
}

/** Frozen before the all-M1-candle replay. No parameter sweep is permitted. */
export const MOMENTUM_CUSUM_CONFIG: Readonly<MomentumCusumConfig> = Object.freeze({
  volatilityLookbackBars: 60,
  cusumThreshold: 2.5,
  cusumDrift: 0.05,
  maxReturnZ: 6,
  refractoryBars: 15,
  impulseLookbackBars: 5,
  minImpulseM5Atr: 0.15,
  maxImpulseM5Atr: 0.90,
  maxPrePullbackBars: 1,
  minPullbackBars: 2,
  maxPullbackBars: 3,
  minRetracementFraction: 0.10,
  maxRetracementFraction: 0.55,
  maxPullbackBarRangeImpulse: 0.75,
  resumeBufferM5Atr: 0.01,
  maxEntryExtensionM5Atr: 0.15,
  stopBufferM5Atr: 0.02,
  minStopM5Atr: 0.05,
  maxStopM5Atr: 0.60,
  targetR: 2,
  structureLookbackBars: 30,
  calibrationMinimumSamples: 100,
});

export interface MomentumCusumState {
  positive: number;
  negative: number;
}

export interface MomentumCusumStep {
  state: MomentumCusumState;
  direction: MomentumCusumDirection | null;
  magnitude: number;
}

export interface MomentumCusumIgnition {
  index: number;
  direction: MomentumCusumDirection;
  knownAt: string;
  returnZ: number;
  cusumMagnitude: number;
  sigma: number;
  referenceM5Atr: number;
  impulseM5Atr: number;
  impulseStart: number;
  impulseExtreme: number;
  impulseRange: number;
}

export interface MomentumCusumPullbackDecision {
  version: "momentum-cusum-pullback-v1";
  action: "trade" | "wait";
  direction: MomentumCusumDirection | null;
  knownAt: string | null;
  entryIndex: number | null;
  pullbackBars: number | null;
  retracementFraction: number | null;
  pullbackHigh: number | null;
  pullbackLow: number | null;
  pullbackBreakLevel: number | null;
  stop: number | null;
  stopDistanceFromMidOpen: number | null;
  structureRoomR: number | null;
  pullbackActivityRatio: number | null;
  liquidSession: boolean | null;
  rawScore: number;
  reason: string;
}

export interface SigmoidCalibration {
  version: "sigmoid-calibration-v1";
  sampleCount: number;
  positives: number;
  intercept: number;
  slope: number;
  scoreCenter: number;
  scoreScale: number;
  l2: number;
}

export interface CalibrationSample {
  rawScore: number;
  won: boolean;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function average(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function standardDeviation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const center = average(values);
  const variance = values.reduce((total, value) => total + (value - center) ** 2, 0) / (values.length - 1);
  const result = Math.sqrt(variance);
  return result > 0 && Number.isFinite(result) ? result : null;
}

function validConfig(config: MomentumCusumConfig): boolean {
  return Number.isInteger(config.volatilityLookbackBars) && config.volatilityLookbackBars >= 20
    && config.cusumThreshold > 0 && config.cusumDrift >= 0 && config.maxReturnZ > 0
    && Number.isInteger(config.refractoryBars) && config.refractoryBars >= 0
    && Number.isInteger(config.impulseLookbackBars) && config.impulseLookbackBars >= 2
    && config.minImpulseM5Atr > 0 && config.maxImpulseM5Atr > config.minImpulseM5Atr
    && Number.isInteger(config.maxPrePullbackBars) && config.maxPrePullbackBars >= 0
    && Number.isInteger(config.minPullbackBars) && config.minPullbackBars >= 1
    && Number.isInteger(config.maxPullbackBars) && config.maxPullbackBars >= config.minPullbackBars
    && config.minRetracementFraction >= 0 && config.maxRetracementFraction > config.minRetracementFraction && config.maxRetracementFraction < 1
    && config.maxPullbackBarRangeImpulse > 0 && config.resumeBufferM5Atr >= 0
    && config.maxEntryExtensionM5Atr > 0 && config.stopBufferM5Atr >= 0
    && config.minStopM5Atr > 0 && config.maxStopM5Atr > config.minStopM5Atr
    && config.targetR > 0 && Number.isInteger(config.structureLookbackBars) && config.structureLookbackBars >= 1
    && Number.isInteger(config.calibrationMinimumSamples) && config.calibrationMinimumSamples >= 20;
}

export function updateTwoSidedCusum(
  state: MomentumCusumState,
  returnZ: number,
  config: MomentumCusumConfig = MOMENTUM_CUSUM_CONFIG,
): MomentumCusumStep {
  if (!validConfig(config)) throw new Error("Invalid Momentum CUSUM configuration.");
  if (!Number.isFinite(returnZ)) throw new Error("CUSUM requires a finite standardized return.");
  const bounded = clamp(returnZ, -config.maxReturnZ, config.maxReturnZ);
  const positive = Math.max(0, state.positive + bounded - config.cusumDrift);
  const negative = Math.min(0, state.negative + bounded + config.cusumDrift);
  if (positive >= config.cusumThreshold && positive >= Math.abs(negative)) {
    return { state: { positive: 0, negative: 0 }, direction: "long", magnitude: positive };
  }
  if (Math.abs(negative) >= config.cusumThreshold) {
    return { state: { positive: 0, negative: 0 }, direction: "short", magnitude: Math.abs(negative) };
  }
  return { state: { positive, negative }, direction: null, magnitude: Math.max(positive, Math.abs(negative)) };
}

export function scanMomentumCusumIgnitions(input: {
  bars: readonly MomentumCusumBar[];
  referenceM5AtrByIndex: readonly (number | null)[];
  config?: MomentumCusumConfig;
}): MomentumCusumIgnition[] {
  const config = input.config ?? MOMENTUM_CUSUM_CONFIG;
  if (!validConfig(config)) throw new Error("Invalid Momentum CUSUM configuration.");
  if (input.referenceM5AtrByIndex.length !== input.bars.length) throw new Error("Each M1 bar requires a point-in-time M5 ATR value.");

  const ignitions: MomentumCusumIgnition[] = [];
  const returns: number[] = [];
  let state: MomentumCusumState = { positive: 0, negative: 0 };
  let priorTrigger = Number.NEGATIVE_INFINITY;

  for (let index = 1; index < input.bars.length; index += 1) {
    const previous = input.bars[index - 1]!;
    const current = input.bars[index]!;
    const gap = Date.parse(current.closeTime) - Date.parse(previous.closeTime);
    if (gap !== 60_000) {
      returns.length = 0;
      state = { positive: 0, negative: 0 };
      continue;
    }

    const value = Math.log(current.close / previous.close);
    if (!Number.isFinite(value)) continue;
    if (returns.length < config.volatilityLookbackBars) {
      returns.push(value);
      continue;
    }

    const sigma = standardDeviation(returns.slice(-config.volatilityLookbackBars));
    returns.push(value);
    if (returns.length > config.volatilityLookbackBars) returns.shift();
    if (sigma === null) continue;
    const referenceM5Atr = input.referenceM5AtrByIndex[index];
    if (referenceM5Atr === null || !(referenceM5Atr > 0)) continue;

    const returnZ = value / sigma;
    const step = updateTwoSidedCusum(state, returnZ, config);
    state = step.state;
    if (!step.direction || index - priorTrigger <= config.refractoryBars) continue;

    const startIndex = index - config.impulseLookbackBars + 1;
    if (startIndex < 0) continue;
    const impulseBars = input.bars.slice(startIndex, index + 1);
    const impulseStart = step.direction === "long"
      ? Math.min(...impulseBars.map((bar) => bar.low))
      : Math.max(...impulseBars.map((bar) => bar.high));
    const impulseExtreme = step.direction === "long"
      ? Math.max(...impulseBars.map((bar) => bar.high))
      : Math.min(...impulseBars.map((bar) => bar.low));
    const displacement = current.close - input.bars[startIndex]!.open;
    if ((step.direction === "long" && displacement <= 0) || (step.direction === "short" && displacement >= 0)) continue;
    const impulseRange = Math.abs(impulseExtreme - impulseStart);
    const impulseM5Atr = impulseRange / referenceM5Atr;
    if (impulseM5Atr < config.minImpulseM5Atr || impulseM5Atr > config.maxImpulseM5Atr) continue;

    priorTrigger = index;
    ignitions.push({
      index,
      direction: step.direction,
      knownAt: current.closeTime,
      returnZ,
      cusumMagnitude: step.magnitude,
      sigma,
      referenceM5Atr,
      impulseM5Atr,
      impulseStart,
      impulseExtreme,
      impulseRange,
    });
  }
  return ignitions;
}

function wait(reason: string, partial: Partial<MomentumCusumPullbackDecision> = {}): MomentumCusumPullbackDecision {
  return {
    version: "momentum-cusum-pullback-v1",
    action: "wait",
    direction: null,
    knownAt: null,
    entryIndex: null,
    pullbackBars: null,
    retracementFraction: null,
    pullbackHigh: null,
    pullbackLow: null,
    pullbackBreakLevel: null,
    stop: null,
    stopDistanceFromMidOpen: null,
    structureRoomR: null,
    pullbackActivityRatio: null,
    liquidSession: null,
    rawScore: 0,
    reason,
    ...partial,
  };
}

export function detectMomentumCusumPullback(input: {
  bars: readonly MomentumCusumBar[];
  ignition: MomentumCusumIgnition;
  config?: MomentumCusumConfig;
}): MomentumCusumPullbackDecision {
  const config = input.config ?? MOMENTUM_CUSUM_CONFIG;
  if (!validConfig(config)) throw new Error("Invalid Momentum CUSUM configuration.");
  const { ignition } = input;
  if (ignition.index < config.impulseLookbackBars - 1 || ignition.index >= input.bars.length - 1) {
    throw new Error("CUSUM pullback requires a valid completed ignition and a following entry bar.");
  }

  const isCountertrend = (bar: MomentumCusumBar) => ignition.direction === "long" ? bar.close < bar.open : bar.close > bar.open;
  const isDirectional = (bar: MomentumCusumBar) => ignition.direction === "long" ? bar.close > bar.open : bar.close < bar.open;
  const pullback: MomentumCusumBar[] = [];
  let prePullbackBars = 0;
  let resumeIndex: number | null = null;

  for (let index = ignition.index + 1; index < input.bars.length - 1; index += 1) {
    const previous = input.bars[index - 1]!;
    const bar = input.bars[index]!;
    if (Date.parse(bar.closeTime) - Date.parse(previous.closeTime) !== 60_000) return wait("The M1 pattern crossed a market-data gap.");
    if (pullback.length === 0) {
      if (!isCountertrend(bar)) {
        prePullbackBars += 1;
        if (prePullbackBars > config.maxPrePullbackBars) return wait("No timely countertrend M1 pullback formed after the CUSUM impulse.");
        continue;
      }
      pullback.push(bar);
      continue;
    }
    if (isCountertrend(bar)) {
      pullback.push(bar);
      if (pullback.length > config.maxPullbackBars) return wait("The M1 pullback lasted longer than three countertrend candles.", { pullbackBars: pullback.length });
      continue;
    }
    if (pullback.length < config.minPullbackBars) return wait("The M1 pullback ended before two countertrend candles completed.", { pullbackBars: pullback.length });
    if (!isDirectional(bar)) return wait("The first candle after the M1 pullback did not resume the impulse direction.", { pullbackBars: pullback.length });
    const high = Math.max(...pullback.map((item) => item.high));
    const low = Math.min(...pullback.map((item) => item.low));
    const level = ignition.direction === "long" ? high : low;
    const resumed = ignition.direction === "long"
      ? bar.close >= level + ignition.referenceM5Atr * config.resumeBufferM5Atr
      : bar.close <= level - ignition.referenceM5Atr * config.resumeBufferM5Atr;
    if (!resumed) return wait("The first directional M1 candle did not close beyond the pullback.", { pullbackBars: pullback.length, pullbackHigh: high, pullbackLow: low, pullbackBreakLevel: level });
    resumeIndex = index;
    break;
  }

  if (resumeIndex === null) return wait("No completed M1 resumption formed before the available data ended.", { pullbackBars: pullback.length || null });
  const pullbackHigh = Math.max(...pullback.map((bar) => bar.high));
  const pullbackLow = Math.min(...pullback.map((bar) => bar.low));
  const pullbackBreakLevel = ignition.direction === "long" ? pullbackHigh : pullbackLow;
  const oversized = pullback.some((bar) => (bar.high - bar.low) / ignition.impulseRange > config.maxPullbackBarRangeImpulse);
  if (oversized) return wait("At least one M1 pullback candle was too large relative to the impulse.", { pullbackBars: pullback.length, pullbackHigh, pullbackLow, pullbackBreakLevel });

  const retracementFraction = ignition.direction === "long"
    ? (ignition.impulseExtreme - pullbackLow) / ignition.impulseRange
    : (pullbackHigh - ignition.impulseExtreme) / ignition.impulseRange;
  if (retracementFraction < config.minRetracementFraction || retracementFraction > config.maxRetracementFraction) {
    return wait("The M1 retracement was outside the frozen 10% to 55% impulse range.", { pullbackBars: pullback.length, retracementFraction, pullbackHigh, pullbackLow, pullbackBreakLevel });
  }

  const entryIndex = resumeIndex + 1;
  const resume = input.bars[resumeIndex]!;
  const entryBar = input.bars[entryIndex]!;
  if (Date.parse(entryBar.closeTime) - Date.parse(resume.closeTime) !== 60_000) return wait("The next M1 entry candle was unavailable or discontinuous.");
  const midEntry = entryBar.open;
  const entryExtensionM5Atr = ignition.direction === "long"
    ? (midEntry - pullbackBreakLevel) / ignition.referenceM5Atr
    : (pullbackBreakLevel - midEntry) / ignition.referenceM5Atr;
  if (entryExtensionM5Atr < 0 || entryExtensionM5Atr > config.maxEntryExtensionM5Atr) {
    return wait("The next M1 open was already extended beyond the resumption level.", { pullbackBars: pullback.length, retracementFraction, pullbackHigh, pullbackLow, pullbackBreakLevel });
  }

  const stop = ignition.direction === "long"
    ? pullbackLow - ignition.referenceM5Atr * config.stopBufferM5Atr
    : pullbackHigh + ignition.referenceM5Atr * config.stopBufferM5Atr;
  const stopDistanceFromMidOpen = Math.abs(midEntry - stop);
  const stopM5Atr = stopDistanceFromMidOpen / ignition.referenceM5Atr;
  if (stopM5Atr < config.minStopM5Atr || stopM5Atr > config.maxStopM5Atr) {
    return wait("The structural M1 stop was outside the frozen M5-ATR risk range.", { pullbackBars: pullback.length, retracementFraction, pullbackHigh, pullbackLow, pullbackBreakLevel, stop, stopDistanceFromMidOpen });
  }

  const impulseStartIndex = ignition.index - config.impulseLookbackBars + 1;
  const priorStructure = input.bars.slice(Math.max(0, impulseStartIndex - config.structureLookbackBars), impulseStartIndex);
  const opposingLevel = priorStructure.length === 0 ? null : ignition.direction === "long"
    ? Math.max(...priorStructure.map((bar) => bar.high))
    : Math.min(...priorStructure.map((bar) => bar.low));
  const structureRoom = opposingLevel === null ? Number.POSITIVE_INFINITY : ignition.direction === "long"
    ? opposingLevel <= midEntry ? Number.POSITIVE_INFINITY : opposingLevel - midEntry
    : opposingLevel >= midEntry ? Number.POSITIVE_INFINITY : midEntry - opposingLevel;
  const structureRoomR = structureRoom / stopDistanceFromMidOpen;

  const impulseBars = input.bars.slice(impulseStartIndex, ignition.index + 1);
  const impulseActivity = impulseBars.flatMap((bar) => bar.volume === undefined ? [] : [bar.volume]);
  const pullbackActivity = pullback.flatMap((bar) => bar.volume === undefined ? [] : [bar.volume]);
  const pullbackActivityRatio = impulseActivity.length === impulseBars.length && pullbackActivity.length === pullback.length
    ? average(pullbackActivity) / average(impulseActivity)
    : null;
  const hour = new Date(resume.closeTime).getUTCHours();
  const liquidSession = hour >= 7 && hour < 16;
  const compactness = average(pullback.map((bar) => (bar.high - bar.low) / ignition.impulseRange));
  const cusumComponent = 25 * clamp((ignition.cusumMagnitude - config.cusumThreshold) / config.cusumThreshold, 0, 1);
  const impulseComponent = 20 * clamp((ignition.impulseM5Atr - config.minImpulseM5Atr) / (config.maxImpulseM5Atr - config.minImpulseM5Atr), 0, 1);
  const retracementComponent = 20 * clamp(1 - Math.abs(retracementFraction - 0.30) / 0.25, 0, 1);
  const compactnessComponent = 15 * clamp(1 - compactness / config.maxPullbackBarRangeImpulse, 0, 1);
  const activityComponent = pullbackActivityRatio === null ? 0 : 10 * clamp(1 - pullbackActivityRatio, 0, 1);
  const entryComponent = 5 * clamp(1 - entryExtensionM5Atr / config.maxEntryExtensionM5Atr, 0, 1);
  const sessionComponent = liquidSession ? 5 : 0;
  const rawScore = clamp(cusumComponent + impulseComponent + retracementComponent + compactnessComponent + activityComponent + entryComponent + sessionComponent, 0, 100);

  return {
    version: "momentum-cusum-pullback-v1",
    action: "trade",
    direction: ignition.direction,
    knownAt: resume.closeTime,
    entryIndex,
    pullbackBars: pullback.length,
    retracementFraction,
    pullbackHigh,
    pullbackLow,
    pullbackBreakLevel,
    stop,
    stopDistanceFromMidOpen,
    structureRoomR,
    pullbackActivityRatio,
    liquidSession,
    rawScore,
    reason: "A fresh M1 CUSUM impulse formed a compact 2/3-candle pullback and closed through its micro swing; entry is the next M1 open.",
  };
}

function logistic(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

export function fitSigmoidCalibration(
  samples: readonly CalibrationSample[],
  minimumSamples = MOMENTUM_CUSUM_CONFIG.calibrationMinimumSamples,
): SigmoidCalibration | null {
  if (samples.length < minimumSamples) return null;
  const positives = samples.filter((sample) => sample.won).length;
  if (positives === 0 || positives === samples.length) return null;
  const scoreCenter = average(samples.map((sample) => sample.rawScore));
  const scoreScale = standardDeviation(samples.map((sample) => sample.rawScore)) ?? 1;
  const l2 = 1;
  let intercept = Math.log((positives + 0.5) / (samples.length - positives + 0.5));
  let slope = 0;

  for (let iteration = 0; iteration < 50; iteration += 1) {
    let g0 = 0;
    let g1 = l2 * slope;
    let h00 = 1e-9;
    let h01 = 0;
    let h11 = l2;
    for (const sample of samples) {
      const x = (sample.rawScore - scoreCenter) / scoreScale;
      const probability = logistic(intercept + slope * x);
      const error = probability - (sample.won ? 1 : 0);
      const weight = Math.max(1e-9, probability * (1 - probability));
      g0 += error;
      g1 += error * x;
      h00 += weight;
      h01 += weight * x;
      h11 += weight * x * x;
    }
    const determinant = h00 * h11 - h01 * h01;
    if (!(determinant > 0)) break;
    const delta0 = (h11 * g0 - h01 * g1) / determinant;
    const delta1 = (-h01 * g0 + h00 * g1) / determinant;
    intercept -= delta0;
    slope -= delta1;
    if (Math.max(Math.abs(delta0), Math.abs(delta1)) < 1e-8) break;
  }

  return { version: "sigmoid-calibration-v1", sampleCount: samples.length, positives, intercept, slope, scoreCenter, scoreScale, l2 };
}

export function calibratedWinProbability(calibration: SigmoidCalibration | null, rawScore: number): number | null {
  if (!calibration) return null;
  const x = (rawScore - calibration.scoreCenter) / calibration.scoreScale;
  return logistic(calibration.intercept + calibration.slope * x);
}

export function invertMomentumCusumDirection(direction: MomentumCusumDirection): MomentumCusumDirection {
  return direction === "long" ? "short" : "long";
}

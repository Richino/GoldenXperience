/**
 * Momentum burst direction confirmation — research only.
 *
 * Momentum V1 labels the direction of an already-completed five-bar run. This
 * module deliberately separates that observed burst direction from the next
 * trade direction. It waits for completed candles after the setup and returns:
 *
 * - FOLLOW: a pullback, then a buffered break of the frozen burst extreme, then
 *   one completed hold candle beyond that extreme;
 * - REVERSE: continuation fails and price closes through the frozen burst
 *   midpoint, optionally after rejecting an attempted extension;
 * - WAIT: neither event becomes known inside the fixed confirmation window.
 *
 * It is not imported by paper-cycle, the strategy registry, or execution.
 */

export type MomentumBurstDirection = "long" | "short";
export type MomentumBurstAction = "follow" | "reverse" | "wait";

export interface MomentumBurstBar {
  closeTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface MomentumBurstDirectionConfig {
  /** Six candles contain the five close-to-close intervals used by V1. */
  burstRangeBars: number;
  /** Maximum completed candles observed after the setup. */
  maxConfirmationBars: number;
  /** Minimum retracement from the burst extreme as a fraction of its range. */
  pullbackFraction: number;
  /** A continuation close must clear the burst extreme by this ATR fraction. */
  breakoutBufferAtr: number;
  /** A wick must clear the extreme by this ATR fraction to count as an attempt. */
  attemptBufferAtr: number;
  /** Fraction of the burst range whose loss confirms reversal. */
  reverseMidpointFraction: number;
}

/** Frozen before the recorded-47 replay. Do not tune against its result. */
export const MOMENTUM_BURST_DIRECTION_CONFIG: Readonly<MomentumBurstDirectionConfig> = Object.freeze({
  burstRangeBars: 6,
  maxConfirmationBars: 3,
  pullbackFraction: 0.20,
  breakoutBufferAtr: 0.05,
  attemptBufferAtr: 0.02,
  reverseMidpointFraction: 0.50,
});

export interface MomentumBurstDecision {
  version: "momentum-burst-direction-v1";
  action: MomentumBurstAction;
  direction: MomentumBurstDirection | null;
  originalDirection: MomentumBurstDirection;
  confidence: number;
  knownAtIndex: number | null;
  entryIndex: number | null;
  confirmationBars: number | null;
  burstHigh: number;
  burstLow: number;
  burstMidpoint: number;
  pulledBack: boolean;
  attemptedContinuation: boolean;
  reason: string;
}

function opposite(direction: MomentumBurstDirection): MomentumBurstDirection {
  return direction === "long" ? "short" : "long";
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function validConfig(config: MomentumBurstDirectionConfig): boolean {
  return Number.isInteger(config.burstRangeBars) && config.burstRangeBars >= 2
    && Number.isInteger(config.maxConfirmationBars) && config.maxConfirmationBars >= 1
    && config.pullbackFraction > 0 && config.pullbackFraction < 0.5
    && config.breakoutBufferAtr >= 0
    && config.attemptBufferAtr >= 0
    && config.reverseMidpointFraction > 0 && config.reverseMidpointFraction < 1;
}

export function decideMomentumBurstDirection(input: {
  bars: readonly MomentumBurstBar[];
  setupIndex: number;
  originalDirection: MomentumBurstDirection;
  atr: number;
  config?: MomentumBurstDirectionConfig;
}): MomentumBurstDecision {
  const config = input.config ?? MOMENTUM_BURST_DIRECTION_CONFIG;
  if (!validConfig(config)) throw new Error("Invalid Momentum burst direction configuration.");
  if (!(input.atr > 0) || !Number.isFinite(input.atr)) throw new Error("Momentum direction confirmation requires a positive ATR.");
  if (!Number.isInteger(input.setupIndex) || input.setupIndex < config.burstRangeBars - 1 || input.setupIndex >= input.bars.length) {
    throw new Error("Momentum direction confirmation does not have the frozen burst range.");
  }

  const frozen = input.bars.slice(input.setupIndex - config.burstRangeBars + 1, input.setupIndex + 1);
  const burstHigh = Math.max(...frozen.map((bar) => bar.high));
  const burstLow = Math.min(...frozen.map((bar) => bar.low));
  const burstRange = burstHigh - burstLow;
  if (!(burstRange > 0)) throw new Error("Momentum direction confirmation requires a positive burst range.");

  const burstMidpoint = input.originalDirection === "long"
    ? burstHigh - burstRange * config.reverseMidpointFraction
    : burstLow + burstRange * config.reverseMidpointFraction;
  const breakoutBuffer = input.atr * config.breakoutBufferAtr;
  const attemptBuffer = input.atr * config.attemptBufferAtr;
  const pullbackDistance = burstRange * config.pullbackFraction;
  const lastConfirmationIndex = Math.min(input.bars.length - 1, input.setupIndex + config.maxConfirmationBars);

  let pulledBack = false;
  let attemptedContinuation = false;
  let pendingFollowBreakIndex: number | null = null;

  const decision = (
    action: MomentumBurstAction,
    knownAtIndex: number | null,
    confidence: number,
    reason: string,
  ): MomentumBurstDecision => ({
    version: "momentum-burst-direction-v1",
    action,
    direction: action === "wait" ? null : action === "follow" ? input.originalDirection : opposite(input.originalDirection),
    originalDirection: input.originalDirection,
    confidence: clamp(confidence, 0, 100),
    knownAtIndex,
    entryIndex: knownAtIndex !== null && knownAtIndex + 1 < input.bars.length ? knownAtIndex + 1 : null,
    confirmationBars: knownAtIndex === null ? null : knownAtIndex - input.setupIndex,
    burstHigh,
    burstLow,
    burstMidpoint,
    pulledBack,
    attemptedContinuation,
    reason,
  });

  for (let index = input.setupIndex + 1; index <= lastConfirmationIndex; index += 1) {
    const bar = input.bars[index]!;

    // A breakout becomes FOLLOW only when the next completed candle holds it.
    if (pendingFollowBreakIndex !== null) {
      const held = input.originalDirection === "long" ? bar.close > burstHigh : bar.close < burstLow;
      if (held) {
        const holdMarginAtr = input.originalDirection === "long"
          ? (bar.close - burstHigh) / input.atr
          : (burstLow - bar.close) / input.atr;
        return decision(
          "follow",
          index,
          68 + holdMarginAtr * 20,
          "A pullback was followed by a buffered break and a completed hold beyond the frozen burst extreme.",
        );
      }
      pendingFollowBreakIndex = null;
    }

    const attemptedNow = input.originalDirection === "long"
      ? bar.high >= burstHigh + attemptBuffer
      : bar.low <= burstLow - attemptBuffer;
    attemptedContinuation ||= attemptedNow;

    const pulledBackNow = input.originalDirection === "long"
      ? bar.low <= burstHigh - pullbackDistance
      : bar.high >= burstLow + pullbackDistance;
    pulledBack ||= pulledBackNow;

    const brokeWithClose = input.originalDirection === "long"
      ? bar.close >= burstHigh + breakoutBuffer
      : bar.close <= burstLow - breakoutBuffer;
    if (pulledBack && brokeWithClose) {
      pendingFollowBreakIndex = index;
      continue;
    }

    const crossedMidpoint = input.originalDirection === "long"
      ? bar.close <= burstMidpoint
      : bar.close >= burstMidpoint;
    const rejectedAttempt = attemptedNow && (input.originalDirection === "long" ? bar.close < burstHigh : bar.close > burstLow);
    const twoBarsWithoutAcceptedBreak = index - input.setupIndex >= 2 && pendingFollowBreakIndex === null;
    if (crossedMidpoint && (rejectedAttempt || twoBarsWithoutAcceptedBreak)) {
      const failureDepthAtr = input.originalDirection === "long"
        ? (burstMidpoint - bar.close) / input.atr
        : (bar.close - burstMidpoint) / input.atr;
      return decision(
        "reverse",
        index,
        62 + failureDepthAtr * 20 + (rejectedAttempt ? 8 : 0),
        rejectedAttempt
          ? "Continuation attempted the burst extreme, failed, and closed through the frozen midpoint."
          : "Continuation failed to close beyond the burst extreme and price closed through the frozen midpoint.",
      );
    }
  }

  return decision(
    "wait",
    null,
    0,
    "Neither a pullback-break-hold continuation nor a midpoint failure was confirmed inside three completed candles.",
  );
}

export function invertMomentumBurstDirection(direction: MomentumBurstDirection): MomentumBurstDirection {
  return opposite(direction);
}

/**
 * M5 reaction to an early Momentum breakout — research only.
 *
 * The ignition candle merely arms the policy. Completed candles after the break
 * decide whether price accepted the level (FOLLOW), rejected back inside the
 * old range (REVERSE), or provided no tradable reaction (WAIT).
 */
import type { MomentumIgnitionBar, MomentumIgnitionDirection } from "./momentum-early-ignition.js";

export type MomentumBreakReactionAction = "follow" | "reverse" | "wait";

export interface MomentumBreakReactionConfig {
  maxReactionBars: number;
  retestToleranceM15Atr: number;
  holdBufferM15Atr: number;
  rejectionBufferM15Atr: number;
  maxEntryDistanceM15Atr: number;
}

/** Frozen before the recorded-47 replay. */
export const MOMENTUM_BREAK_REACTION_CONFIG: Readonly<MomentumBreakReactionConfig> = Object.freeze({
  maxReactionBars: 2,
  retestToleranceM15Atr: 0.15,
  holdBufferM15Atr: 0.02,
  rejectionBufferM15Atr: 0.03,
  maxEntryDistanceM15Atr: 0.50,
});

export interface MomentumBreakReactionDecision {
  version: "momentum-break-reaction-v1";
  action: MomentumBreakReactionAction;
  direction: MomentumIgnitionDirection | null;
  breakoutDirection: MomentumIgnitionDirection;
  ruleStrength: number;
  knownAtIndex: number | null;
  entryIndex: number | null;
  knownAt: string | null;
  entryAt: string | null;
  reactionBars: number | null;
  retested: boolean;
  holdMarginM15Atr: number | null;
  rejectionDepthM15Atr: number | null;
  entryDistanceM15Atr: number | null;
  reason: string;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function opposite(direction: MomentumIgnitionDirection): MomentumIgnitionDirection {
  return direction === "long" ? "short" : "long";
}

function validConfig(config: MomentumBreakReactionConfig): boolean {
  return Number.isInteger(config.maxReactionBars) && config.maxReactionBars >= 1
    && config.retestToleranceM15Atr >= 0
    && config.holdBufferM15Atr >= 0
    && config.rejectionBufferM15Atr > 0
    && config.maxEntryDistanceM15Atr > 0;
}

export function decideMomentumBreakReaction(input: {
  bars: readonly MomentumIgnitionBar[];
  breakoutIndex: number;
  breakoutDirection: MomentumIgnitionDirection;
  breakoutLevel: number;
  m15Atr: number;
  config?: MomentumBreakReactionConfig;
}): MomentumBreakReactionDecision {
  const config = input.config ?? MOMENTUM_BREAK_REACTION_CONFIG;
  if (!validConfig(config)) throw new Error("Invalid Momentum break reaction configuration.");
  if (!Number.isInteger(input.breakoutIndex) || input.breakoutIndex < 0 || input.breakoutIndex >= input.bars.length) {
    throw new Error("Momentum break reaction requires a valid completed breakout candle.");
  }
  if (!(input.m15Atr > 0) || !Number.isFinite(input.m15Atr) || !Number.isFinite(input.breakoutLevel)) {
    throw new Error("Momentum break reaction requires a valid breakout level and positive M15 ATR.");
  }

  let retested = false;
  const lastReactionIndex = Math.min(input.bars.length - 1, input.breakoutIndex + config.maxReactionBars);

  const result = (args: {
    action: Exclude<MomentumBreakReactionAction, "wait">;
    knownAtIndex: number;
    holdMarginM15Atr: number | null;
    rejectionDepthM15Atr: number | null;
  }): MomentumBreakReactionDecision | null => {
    const entryIndex = args.knownAtIndex + 1;
    if (entryIndex >= input.bars.length) return null;
    const knownAt = input.bars[args.knownAtIndex]!.closeTime;
    const entryBar = input.bars[entryIndex]!;
    const entryOpenAt = Date.parse(entryBar.closeTime) - 5 * 60_000;
    if (entryOpenAt !== Date.parse(knownAt)) return null;

    const direction = args.action === "follow" ? input.breakoutDirection : opposite(input.breakoutDirection);
    const entryDistanceM15Atr = direction === "long"
      ? (entryBar.open - input.breakoutLevel) / input.m15Atr
      : (input.breakoutLevel - entryBar.open) / input.m15Atr;
    if (entryDistanceM15Atr < 0 || entryDistanceM15Atr > config.maxEntryDistanceM15Atr) return null;

    const speedBonus = 8 * clamp(1 - (args.knownAtIndex - input.breakoutIndex - 1) / config.maxReactionBars, 0, 1);
    const evidence = args.action === "follow"
      ? clamp((args.holdMarginM15Atr ?? 0) / 0.20, 0, 1) * 24
      : clamp((args.rejectionDepthM15Atr ?? 0) / 0.20, 0, 1) * 24;
    const retestBonus = retested ? 8 : 0;

    return {
      version: "momentum-break-reaction-v1",
      action: args.action,
      direction,
      breakoutDirection: input.breakoutDirection,
      ruleStrength: clamp(60 + speedBonus + evidence + retestBonus, 0, 100),
      knownAtIndex: args.knownAtIndex,
      entryIndex,
      knownAt,
      entryAt: knownAt,
      reactionBars: args.knownAtIndex - input.breakoutIndex,
      retested,
      holdMarginM15Atr: args.holdMarginM15Atr,
      rejectionDepthM15Atr: args.rejectionDepthM15Atr,
      entryDistanceM15Atr,
      reason: args.action === "follow"
        ? "The breakout was retested and a completed M5 candle held beyond the broken level."
        : "A completed M5 candle rejected the breakout and closed materially back inside the old range.",
    };
  };

  for (let index = input.breakoutIndex + 1; index <= lastReactionIndex; index += 1) {
    const bar = input.bars[index]!;
    const retestedNow = input.breakoutDirection === "long"
      ? bar.low <= input.breakoutLevel + input.m15Atr * config.retestToleranceM15Atr
      : bar.high >= input.breakoutLevel - input.m15Atr * config.retestToleranceM15Atr;
    retested ||= retestedNow;

    const rejectionDepthM15Atr = input.breakoutDirection === "long"
      ? (input.breakoutLevel - bar.close) / input.m15Atr
      : (bar.close - input.breakoutLevel) / input.m15Atr;
    if (rejectionDepthM15Atr >= config.rejectionBufferM15Atr) {
      const rejected = result({ action: "reverse", knownAtIndex: index, holdMarginM15Atr: null, rejectionDepthM15Atr });
      if (rejected) return rejected;
      continue;
    }

    const holdMarginM15Atr = input.breakoutDirection === "long"
      ? (bar.close - input.breakoutLevel) / input.m15Atr
      : (input.breakoutLevel - bar.close) / input.m15Atr;
    if (retested && holdMarginM15Atr >= config.holdBufferM15Atr) {
      const held = result({ action: "follow", knownAtIndex: index, holdMarginM15Atr, rejectionDepthM15Atr: null });
      if (held) return held;
    }
  }

  return {
    version: "momentum-break-reaction-v1",
    action: "wait",
    direction: null,
    breakoutDirection: input.breakoutDirection,
    ruleStrength: 0,
    knownAtIndex: null,
    entryIndex: null,
    knownAt: null,
    entryAt: null,
    reactionBars: null,
    retested,
    holdMarginM15Atr: null,
    rejectionDepthM15Atr: null,
    entryDistanceM15Atr: null,
    reason: "The breakout neither produced an accepted retest-and-hold nor a tradable rejection inside two completed M5 candles.",
  };
}

export function invertMomentumBreakReactionDirection(direction: MomentumIgnitionDirection): MomentumIgnitionDirection {
  return opposite(direction);
}

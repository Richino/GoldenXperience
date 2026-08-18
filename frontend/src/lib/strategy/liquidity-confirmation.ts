import type { Candle } from "@/types/forex";
import type { LiquidityLevel } from "@/lib/strategy/liquidity-levels";
import { swingPoints } from "@/lib/strategy/liquidity-levels";

/**
 * The trigger rules, as numbers.
 *
 * Every threshold here is a decision, not a discovery. They are stated once, at
 * the top, so a batch of trades can be attributed to a known configuration and
 * the next batch can change one of them deliberately.
 *
 * Sizes are multiples of ATR rather than fixed pips: 3 pips is a real move on
 * EUR_USD and noise on GBP_JPY, and the same number has to work on both.
 */
export const RULES = {
  /** How far past a level counts as taking it, rather than touching it. */
  sweepBeyondAtr: 0.25,
  /** Bars allowed for price to reclaim the level after taking it. */
  sweepReclaimBars: 3,
  /** Wick as a share of the candle's range. */
  rejectionWickRatio: 0.45,
  /** Where the candle must close within its own range, from the far end. */
  rejectionClosePosition: 0.45,
  /** A single decisive body, in ATR. */
  displacementBodyAtr: 1.0,
  /** Or the same move accumulated over three bars. */
  displacementRunAtr: 1.5,
  displacementRunBars: 3,
  /** Candles either side of a pivot for it to count as a swing. */
  swingReach: 5,
  /** How close price must come back for a retest to count. */
  retestWithinAtr: 0.35,
  retestBars: 8,
  /** How close to a level a setup has to be to claim that location. */
  locationWithinAtr: 0.5,
  /** Reclaim may displace away from the swept level; keep it attributable. */
  sweptLocationWithinAtr: 2,
  /** Minimum counter-trend movement required before a sweep is a pullback. */
  pullbackMinimumAtr: 0.5,
  pullbackLookbackBars: 12,
} as const;

export interface SweepRead {
  level: LiquidityLevel;
  /** Long after a low is swept, short after a high is swept. */
  direction: "long" | "short";
  /** The extreme reached beyond the level — where the stop goes behind. */
  extreme: number;
  barsAgo: number;
}

/**
 * A level taken and given back.
 *
 * Price has to trade far enough beyond the level to have actually triggered the
 * orders resting there — anything less is inside the spread and did not happen
 * — and then close back inside within a few bars. Taken and held is a breakout,
 * a different trade; this only fires on taken and reclaimed.
 */
export function findSweep(candles: Candle[], levels: LiquidityLevel[], atr: number): SweepRead | null {
  if (atr <= 0 || candles.length < RULES.sweepReclaimBars + 1) return null;
  const beyond = atr * RULES.sweepBeyondAtr;
  const recent = candles.slice(-(RULES.sweepReclaimBars + 1));
  const last = recent.at(-1)!;

  let best: SweepRead | null = null;
  for (const level of levels) {
    for (let index = 0; index < recent.length; index += 1) {
      const candle = recent[index]!;
      const barsAgo = recent.length - 1 - index;

      if (level.side === "high" && candle.high >= level.price + beyond && last.close < level.price) {
        const extreme = Math.max(...recent.slice(index).map((item) => item.high));
        if (!best || barsAgo < best.barsAgo) best = { level, direction: "short", extreme, barsAgo };
      }
      if (level.side === "low" && candle.low <= level.price - beyond && last.close > level.price) {
        const extreme = Math.min(...recent.slice(index).map((item) => item.low));
        if (!best || barsAgo < best.barsAgo) best = { level, direction: "long", extreme, barsAgo };
      }
    }
  }
  return best;
}

/** A long tail: price went somewhere and was pushed straight back. */
export function hasRejection(candle: Candle, direction: "long" | "short") {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const wick = direction === "long" ? Math.min(candle.open, candle.close) - candle.low : candle.high - Math.max(candle.open, candle.close);
  if (wick / range < RULES.rejectionWickRatio) return false;
  const position = (candle.close - candle.low) / range;
  return direction === "long" ? position >= 1 - RULES.rejectionClosePosition : position <= RULES.rejectionClosePosition;
}

/** A decisive move, in one bar or over three. */
export function hasDisplacement(candles: Candle[], direction: "long" | "short", atr: number) {
  if (atr <= 0 || !candles.length) return false;
  const last = candles.at(-1)!;
  const body = last.close - last.open;
  const single = direction === "long" ? body : -body;
  if (single >= atr * RULES.displacementBodyAtr) return true;

  const run = candles.slice(-RULES.displacementRunBars);
  if (run.length < RULES.displacementRunBars) return false;
  const moved = run.at(-1)!.close - run[0]!.open;
  return (direction === "long" ? moved : -moved) >= atr * RULES.displacementRunAtr;
}

/** A close beyond the last swing point, which is what turns structure. */
export function hasStructureBreak(candles: Candle[], direction: "long" | "short") {
  const { highs, lows } = swingPoints(candles.slice(-80), RULES.swingReach);
  const close = candles.at(-1)?.close;
  if (close === undefined) return false;
  const reference = direction === "long" ? highs.at(-1) : lows.at(-1);
  if (reference === undefined) return false;
  return direction === "long" ? close > reference : close < reference;
}

/** Price returning to a broken level and leaving again in the same direction. */
export function hasRetest(candles: Candle[], level: number, direction: "long" | "short", atr: number) {
  if (atr <= 0) return false;
  const window = candles.slice(-RULES.retestBars);
  const touched = window.some((candle) => candle.low <= level + atr * RULES.retestWithinAtr && candle.high >= level - atr * RULES.retestWithinAtr);
  if (!touched) return false;
  const close = candles.at(-1)!.close;
  return direction === "long" ? close > level : close < level;
}

/** Whether price is sitting at one of the mapped levels at all. */
export function nearestLevel(price: number, levels: LiquidityLevel[], atr: number) {
  if (atr <= 0) return null;
  const within = atr * RULES.locationWithinAtr;
  let best: { level: LiquidityLevel; distance: number } | null = null;
  for (const level of levels) {
    const distance = Math.abs(price - level.price);
    if (distance <= within && (!best || distance < best.distance)) best = { level, distance };
  }
  return best;
}

export interface PullbackRead {
  detected: boolean;
  depthAtr: number | null;
  durationBars: number;
}

/** Measure the counter-trend leg ending at the sweep candle. */
export function analyzePullback(candles: Candle[], direction: "long" | "short", atr: number, sweepBarsAgo: number): PullbackRead {
  if (atr <= 0) return { detected: false, depthAtr: null, durationBars: 0 };
  const sweepIndex = candles.length - 1 - sweepBarsAgo;
  const start = Math.max(0, sweepIndex - RULES.pullbackLookbackBars + 1);
  const window = candles.slice(start, sweepIndex + 1);
  if (window.length < 2) return { detected: false, depthAtr: 0, durationBars: 0 };

  if (direction === "long") {
    let peakIndex = 0;
    for (let index = 1; index < window.length; index += 1) if (window[index]!.high > window[peakIndex]!.high) peakIndex = index;
    const depth = window[peakIndex]!.high - Math.min(...window.slice(peakIndex).map((candle) => candle.low));
    const durationBars = window.length - 1 - peakIndex;
    return { detected: durationBars > 0 && depth / atr >= RULES.pullbackMinimumAtr, depthAtr: depth / atr, durationBars };
  }

  let troughIndex = 0;
  for (let index = 1; index < window.length; index += 1) if (window[index]!.low < window[troughIndex]!.low) troughIndex = index;
  const depth = Math.max(...window.slice(troughIndex).map((candle) => candle.high)) - window[troughIndex]!.low;
  const durationBars = window.length - 1 - troughIndex;
  return { detected: durationBars > 0 && depth / atr >= RULES.pullbackMinimumAtr, depthAtr: depth / atr, durationBars };
}

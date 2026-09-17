import type { Candle } from "@/types/forex";
import type { MajorInstrument } from "@/types/forex";

/**
 * The pure support/resistance read that both the chart overlay and the Analyze
 * market-condition engine consume. It deliberately reproduces the exact numbers
 * the chart draws so a classification can be checked against the visible lines.
 *
 * This is intentionally UI-free: it returns prices, not chart primitives. The
 * chart's `supportResistanceLines` maps these into reference lines; the analyze
 * gate maps the same prices into a NEAR_SUPPORT / NEAR_RESISTANCE location.
 *
 * Stage 1 note: this does NOT redesign the S/R algorithm. It is the existing
 * logic lifted verbatim into a shared, reusable place.
 */
export interface SupportResistanceLevels {
  /** Latest close the levels were measured against. */
  current: number;
  /** Highest high of the recent range window (outer resistance). */
  rangeHigh: number;
  /** Lowest low of the recent range window (outer support). */
  rangeLow: number;
  /** Nearest confirmed swing high above price, or null when none is above. */
  swingHigh: number | null;
  /** Nearest confirmed swing low below price, or null when none is below. */
  swingLow: number | null;
}

/** How many candles either side define a swing pivot. Matches the chart. */
const PIVOT_REACH = 5;
/** Range levels come from the last N candles. Matches the chart. */
const RANGE_LOOKBACK = 60;
/** The chart reads S/R off the most recent slice; keep the same window. */
const VISIBLE_LOOKBACK = 160;

/**
 * Compute the range and nearest-swing levels for a candle series. Returns null
 * when there are too few candles for a meaningful read (same guard the chart
 * uses), so callers can treat "no levels" as a first-class state.
 */
export function computeSupportResistanceLevels(
  candles: Candle[],
  _instrument: MajorInstrument,
): SupportResistanceLevels | null {
  const visible = candles.slice(-VISIBLE_LOOKBACK);
  const current = visible.at(-1)?.close;
  if (current === undefined || visible.length < 20) return null;

  const range = visible.slice(-Math.min(RANGE_LOOKBACK, visible.length));
  const rangeHigh = Math.max(...range.map((candle) => candle.high));
  const rangeLow = Math.min(...range.map((candle) => candle.low));

  const swingHighs: number[] = [];
  const swingLows: number[] = [];
  for (let index = PIVOT_REACH; index < visible.length - PIVOT_REACH; index += 1) {
    const candle = visible[index]!;
    const window = visible.slice(index - PIVOT_REACH, index + PIVOT_REACH + 1);
    if (window.every((other) => other === candle || other.high <= candle.high)) {
      swingHighs.push(candle.high);
    }
    if (window.every((other) => other === candle || other.low >= candle.low)) {
      swingLows.push(candle.low);
    }
  }

  const nearest = (prices: number[]) =>
    prices.slice().sort((left, right) => Math.abs(left - current) - Math.abs(right - current))[0];
  const swingHigh = nearest(swingHighs.filter((price) => price > current));
  const swingLow = nearest(swingLows.filter((price) => price < current));

  return {
    current,
    rangeHigh,
    rangeLow,
    swingHigh: swingHigh ?? null,
    swingLow: swingLow ?? null,
  };
}

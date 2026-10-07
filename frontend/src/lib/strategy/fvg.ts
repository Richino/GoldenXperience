/**
 * Fair value gap (three-candle imbalance), used by the AMD overlays: after a
 * sweep or breakout, the first gap left by the move in the distribution's
 * direction — the ICT entry zone. Visual only.
 *
 *   Bullish  candle 3's low is above candle 1's high; the gap is between them.
 *   Bearish  candle 3's high is below candle 1's low.
 *
 * The zone runs from the middle (displacement) candle until price first trades
 * back into it — the retest an ICT entry waits for — or to the end of the
 * window if it never returns.
 */

export interface FvgZone {
  direction: "long" | "short";
  startTime: string;
  endTime: string;
  top: number;
  bottom: number;
  /** Price came back into the gap inside the window. */
  retested: boolean;
}

interface FvgBar { ms: number; high: number; low: number }

/** The candle that marks a move away from a range as under way. */
export interface DisplacementCandle {
  direction: "long" | "short";
  time: string;
  endTime: string;
  high: number;
  low: number;
}

/**
 * First candle from `from` that closes at least a quarter of the range beyond
 * it with a strong body (60%+ of the candle). This says a move has started;
 * on 2023–2026 M15 data what came next was close to even (see
 * api-server/research-v2/amd-distribution-start).
 */
export function firstDisplacement(
  bars: Array<FvgBar & { open: number; close: number }>,
  from: number,
  to: number,
  rangeHigh: number,
  rangeLow: number,
  barMs: number,
): DisplacementCandle | null {
  const range = rangeHigh - rangeLow;
  for (let i = Math.max(0, from); i < Math.min(to, bars.length); i += 1) {
    const bar = bars[i]!;
    const strong = Math.abs(bar.close - bar.open) >= 0.6 * (bar.high - bar.low);
    const up = bar.close >= rangeHigh + 0.25 * range;
    const down = bar.close <= rangeLow - 0.25 * range;
    if (!strong || (!up && !down)) continue;
    return {
      direction: up ? "long" : "short",
      time: new Date(bar.ms).toISOString(),
      endTime: new Date(bar.ms + barMs).toISOString(),
      high: bar.high,
      low: bar.low,
    };
  }
  return null;
}

/**
 * First gap whose middle candle is at or after `from`, searched up to (not
 * including) `to`. `barMs` is one candle's length.
 */
export function firstFvg(
  bars: FvgBar[],
  from: number,
  to: number,
  direction: "long" | "short",
  minGap: number,
  barMs: number,
): FvgZone | null {
  const end = Math.min(to, bars.length);
  for (let k = Math.max(from + 1, 2); k < end; k += 1) {
    const first = bars[k - 2]!;
    const third = bars[k]!;
    const top = direction === "long" ? third.low : first.low;
    const bottom = direction === "long" ? first.high : third.high;
    if (top - bottom < minGap) continue;
    let retestIndex = -1;
    for (let j = k + 1; j < end; j += 1) {
      if (direction === "long" ? bars[j]!.low <= top : bars[j]!.high >= bottom) { retestIndex = j; break; }
    }
    const last = retestIndex >= 0 ? retestIndex : end - 1;
    return {
      direction,
      startTime: new Date(bars[k - 1]!.ms).toISOString(),
      endTime: new Date(bars[last]!.ms + barMs).toISOString(),
      top,
      bottom,
      retested: retestIndex >= 0,
    };
  }
  return null;
}

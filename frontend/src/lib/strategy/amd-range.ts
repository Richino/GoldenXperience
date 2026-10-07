import type { Candle } from "@/types/forex";
import { pipSizeFor } from "@/lib/instruments/catalog";
import { firstDisplacement, firstFvg, type DisplacementCandle, type FvgZone } from "@/lib/strategy/fvg";

/**
 * AMD on any consolidation (the "AMD Guide" reading), on whatever timeframe
 * the candles are — visual only, never fed to an evaluator.
 *
 *   Accumulation   at least 16 candles whose whole range stays within 2.5x
 *                  the average candle range (ATR 14) at the start, with
 *                  wick-heavy candles (average body under 55% of the candle).
 *   Manipulation   the first candle that pushes the range past that cap on one
 *                  side, followed within 3 candles by a close back inside; or
 *                  any break that price later reverses all the way through the
 *                  other side (within one range-length), however far it ran.
 *                  A push that stays out is a breakout, not manipulation.
 *   Distribution   from the reclaim to the furthest point in the other
 *                  direction. If price instead runs back through the sweep
 *                  extreme before reaching the other side, or the break never
 *                  comes back inside, it is a breakout: the distribution is
 *                  the move away from the broken side.
 *
 *   FVG            the first fair value gap the move leaves in the direction
 *                  of the sweep's reversal (or of a breakout), within one
 *                  range-length of the break.
 *
 * Related-pair hint (the guide's "SuperYeti" step): while the main pair is
 * ranging, if a closely related pair has already made a lower low (or higher
 * high, for an inverse partner the mirror) in the last third of the range,
 * expect the main pair's highs to be taken and the move to go down — and the
 * reverse. Untested; drawn as a label only.
 */

const ATR_PERIOD = 14;
const MIN_BARS = 16;
const RANGE_ATR = 2.5;
const MAX_BODY_SHARE = 0.55;
const RECLAIM_BARS = 3;

export interface AmdRelatedPair { instrument: string; inverse: boolean }

/** Pairs that move together (or opposite) closely enough to compare. */
const RELATED: Record<string, AmdRelatedPair> = {
  EUR_USD: { instrument: "GBP_USD", inverse: false },
  GBP_USD: { instrument: "EUR_USD", inverse: false },
  AUD_USD: { instrument: "NZD_USD", inverse: false },
  NZD_USD: { instrument: "AUD_USD", inverse: false },
  USD_CHF: { instrument: "EUR_USD", inverse: true },
  USD_CAD: { instrument: "AUD_USD", inverse: true },
  USD_JPY: { instrument: "EUR_JPY", inverse: false },
  EUR_JPY: { instrument: "GBP_JPY", inverse: false },
  GBP_JPY: { instrument: "EUR_JPY", inverse: false },
  AUD_JPY: { instrument: "NZD_JPY", inverse: false },
  NZD_JPY: { instrument: "AUD_JPY", inverse: false },
  EUR_GBP: { instrument: "EUR_CHF", inverse: false },
  XAU_USD: { instrument: "XAG_USD", inverse: false },
  XAG_USD: { instrument: "XAU_USD", inverse: false },
};

export function amdRelatedPair(instrument: string): AmdRelatedPair | null {
  return RELATED[instrument] ?? null;
}

export type AmdHint = "expect-highs-down" | "expect-lows-up" | null;

export interface AmdRange {
  key: string;
  startTime: string;
  /** Exclusive: the open of the candle after the last range candle. */
  endTime: string;
  high: number;
  low: number;
  /** The range has not broken yet (still accumulating on a live chart). */
  forming: boolean;
  hint: AmdHint;
  manipulation: {
    side: "high" | "low";
    sweepTime: string;
    extreme: number;
    reclaimTime: string;
    /** High and low of every candle from the break to the reclaim. */
    high: number;
    low: number;
  } | null;
  distribution: { startTime: string; from: number; endTime: string; best: number; reached: boolean } | null;
  fvg: FvgZone | null;
  /** First strong close well outside the range after it ends. */
  displacement: DisplacementCandle | null;
}

type Bar = Candle & { ms: number };

function toBars(candles: Candle[]): Bar[] {
  return candles
    .map((candle) => ({ ...candle, ms: Date.parse(candle.time) }))
    .filter((candle) => Number.isFinite(candle.ms))
    .sort((a, b) => a.ms - b.ms);
}

function atrSeries(bars: Bar[]) {
  const out: number[] = [];
  let atr = 0;
  bars.forEach((bar, i) => {
    const prev = bars[i - 1];
    const tr = prev
      ? Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close))
      : bar.high - bar.low;
    atr = i === 0 ? tr : (atr * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
    out.push(atr);
  });
  return out;
}

/** Hint from the related pair over [fromMs, toMs): did it break first? */
function relatedHint(partner: Bar[], related: AmdRelatedPair, fromMs: number, toMs: number): AmdHint {
  const during = partner.filter((bar) => bar.ms >= fromMs && bar.ms < toMs);
  if (during.length < MIN_BARS) return null;
  const cut = Math.floor((during.length * 2) / 3);
  const early = during.slice(0, cut);
  const late = during.slice(cut);
  const lowerLow = Math.min(...late.map((b) => b.low)) < Math.min(...early.map((b) => b.low));
  const higherHigh = Math.max(...late.map((b) => b.high)) > Math.max(...early.map((b) => b.high));
  if (lowerLow === higherHigh) return null;
  // Partner weak (lower low) → main pair's highs get taken, then down.
  const partnerWeak = related.inverse ? higherHigh : lowerLow;
  return partnerWeak ? "expect-highs-down" : "expect-lows-up";
}

export function computeAmdRanges(
  candles: Candle[],
  instrument: string,
  partnerCandles: Candle[] = [],
): AmdRange[] {
  const bars = toBars(candles);
  if (bars.length < ATR_PERIOD + MIN_BARS) return [];
  const atr = atrSeries(bars);
  const pip = pipSizeFor(instrument);
  const related = amdRelatedPair(instrument);
  const partner = related ? toBars(partnerCandles) : [];
  const barMs = bars[bars.length - 1]!.ms - bars[bars.length - 2]!.ms;
  const iso = (ms: number) => new Date(ms).toISOString();

  const ranges: AmdRange[] = [];
  let i = ATR_PERIOD;
  while (i < bars.length - MIN_BARS) {
    const cap = Math.max(RANGE_ATR * atr[i]!, 4 * pip);
    let high = bars[i]!.high;
    let low = bars[i]!.low;
    let j = i + 1;
    while (j < bars.length) {
      const nextHigh = Math.max(high, bars[j]!.high);
      const nextLow = Math.min(low, bars[j]!.low);
      if (nextHigh - nextLow > cap) break;
      high = nextHigh;
      low = nextLow;
      j += 1;
    }
    const length = j - i;
    const slice = bars.slice(i, j);
    const bodyShare = slice.reduce((sum, bar) => sum + (bar.high > bar.low ? Math.abs(bar.close - bar.open) / (bar.high - bar.low) : 0), 0) / length;
    if (length < MIN_BARS || bodyShare > MAX_BODY_SHARE) { i += 1; continue; }

    const startMs = bars[i]!.ms;
    const endMs = j < bars.length ? bars[j]!.ms : bars[bars.length - 1]!.ms + barMs;
    const range: AmdRange = {
      key: `amd-range-${startMs}`,
      startTime: iso(startMs),
      endTime: iso(endMs),
      high,
      low,
      forming: j >= bars.length,
      hint: related && partner.length ? relatedHint(partner, related, startMs, endMs) : null,
      manipulation: null,
      distribution: null,
      fvg: null,
      displacement: null,
    };
    ranges.push(range);
    if (range.forming) break;
    range.displacement = firstDisplacement(bars, j, j + length, high, low, barMs);

    const breakBar = bars[j]!;
    const side: "high" | "low" | null = breakBar.high > high && breakBar.low < low
      ? null
      : breakBar.high > high ? "high" : "low";
    let next = j + 1;
    const minGap = Math.max(pip, 0.05 * (high - low));
    // Breakout read: the move away from the range from `index`, followed for
    // at most one range-length, with the first gap it leaves.
    const breakout = (index: number, up: boolean) => {
      const stop = Math.min(bars.length, index + length);
      let best = index;
      for (let k = index + 1; k < stop; k += 1) {
        if (up ? bars[k]!.high > bars[best]!.high : bars[k]!.low < bars[best]!.low) best = k;
      }
      range.manipulation = null;
      range.distribution = {
        startTime: iso(bars[index]!.ms),
        from: up ? high : low,
        endTime: iso(bars[best]!.ms + barMs),
        best: up ? bars[best]!.high : bars[best]!.low,
        reached: true,
      };
      range.fvg = firstFvg(bars, index, stop, up ? "long" : "short", minGap, barMs);
      next = Math.max(next, best + 1);
    };
    if (side) {
      const followEnd = Math.min(bars.length, j + length);
      const reversalUp = side === "low";
      const pastExtreme = (k: number, level: number) => (side === "high" ? bars[k]!.high > level : bars[k]!.low < level);
      const closedInside = (k: number) => (side === "high" ? bars[k]!.close < high : bars[k]!.close > low);
      const extremeOf = (from: number, to: number) => {
        let index = from;
        for (let k = from; k < to; k += 1) if (pastExtreme(k, side === "high" ? bars[index]!.high : bars[index]!.low)) index = k;
        return index;
      };
      const manipulate = (extremeIndex: number, reclaim: number, reached: boolean) => {
        const extreme = side === "high" ? bars[extremeIndex]!.high : bars[extremeIndex]!.low;
        const span = bars.slice(j, reclaim + 1);
        range.manipulation = {
          side,
          sweepTime: iso(breakBar.ms),
          extreme,
          reclaimTime: iso(bars[reclaim]!.ms + barMs),
          high: Math.max(...span.map((bar) => bar.high)),
          low: Math.min(...span.map((bar) => bar.low)),
        };
        let best = reclaim;
        let end = Math.min(bars.length, reclaim + 1 + length);
        // Follow the reversal for at most one range-length after the reclaim.
        for (let k = reclaim + 1; k < end; k += 1) {
          if (pastExtreme(k, extreme)) { end = k; break; }
          if (reversalUp ? bars[k]!.high > bars[best]!.high : bars[k]!.low < bars[best]!.low) best = k;
        }
        range.distribution = {
          startTime: range.manipulation.reclaimTime,
          from: extreme,
          endTime: iso(bars[best]!.ms + barMs),
          best: reversalUp ? bars[best]!.high : bars[best]!.low,
          reached,
        };
        range.fvg = firstFvg(bars, extremeIndex, end, reversalUp ? "long" : "short", minGap, barMs);
        // Tag the first strong candle of the reversal, not one on the fake.
        const tag = firstDisplacement(bars, extremeIndex + 1, end, high, low, barMs);
        range.displacement = tag && tag.direction === (reversalUp ? "long" : "short") ? tag : null;
        next = Math.max(next, best + 1);
      };

      // Price traded through the other side within the follow window: the
      // break was the manipulation, however far it ran first.
      let reach = -1;
      for (let k = j + 1; k < followEnd; k += 1) {
        if (reversalUp ? bars[k]!.high > high : bars[k]!.low < low) { reach = k; break; }
      }
      if (reach >= 0) {
        const extremeIndex = extremeOf(j, reach);
        let reclaim = reach;
        for (let k = extremeIndex; k <= reach; k += 1) if (closedInside(k)) { reclaim = k; break; }
        manipulate(extremeIndex, reclaim, true);
      } else {
        // Not reversed: a quick close back inside with the extreme intact is
        // a sweep in progress; anything else is a breakout.
        let quick = -1;
        for (let k = j; k < Math.min(followEnd, j + RECLAIM_BARS); k += 1) if (closedInside(k)) { quick = k; break; }
        const extremeIndex = quick >= 0 ? extremeOf(j, quick + 1) : -1;
        const extreme = extremeIndex >= 0 ? (side === "high" ? bars[extremeIndex]!.high : bars[extremeIndex]!.low) : 0;
        let intact = quick >= 0;
        for (let k = quick + 1; intact && k < followEnd; k += 1) if (pastExtreme(k, extreme)) intact = false;
        if (intact) manipulate(extremeIndex, quick, false);
        else breakout(j, side === "high");
      }
    }
    i = next;
  }
  return ranges;
}

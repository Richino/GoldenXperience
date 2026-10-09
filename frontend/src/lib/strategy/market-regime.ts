import { calculateAtrValues } from "@/lib/strategy/indicators";
import type { Candle } from "@/types/forex";

/**
 * Market-regime layer shared by Normal and Swing analysis. One framework, run
 * on whichever timeframe is primary for the mode.
 *
 * Regime comes first: every read is exactly one of UPTREND, DOWNTREND, RANGE
 * or TRANSITION, decided from confirmed swing structure only.
 *
 * Causal by construction: a swing pivot needs `reach` completed candles after
 * it, so it only exists once those candles have closed. The forming candle is
 * never used. Run on a slice ending at time t, the read is what would have
 * been known at t (replay/backtests slice the candles; nothing peeks ahead).
 */

export type Regime = "UPTREND" | "DOWNTREND" | "RANGE" | "TRANSITION";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export interface Swing {
  type: "high" | "low";
  price: number;
  /** Index into the completed candles the read was made on. */
  index: number;
  time: string;
  /**
   * Open time of the candle that confirmed the pivot (`reach` candles later).
   * The pivot was knowable only once that candle had closed.
   */
  confirmedAt: string;
}

/** A support/resistance area: repeated reactions grouped into a price band. */
export interface Zone {
  low: number;
  high: number;
  /** Swing reactions inside the zone; more is stronger. */
  touches: number;
  /** Most recent reaction, for recency. */
  lastTime: string;
}

export interface RegimeSettings {
  /** Candles either side a pivot needs; confirmation lags by this many candles. */
  pivotReach: number;
  atrPeriod: number;
  /** A leg smaller than this many ATRs is noise, not a meaningful swing. */
  minLegAtr: number;
  /** Equal-ish highs/lows within this many ATRs count as the same boundary... */
  boundaryToleranceAtr: number;
  /** ...or within this share of the box height, whichever is larger. */
  boundaryToleranceShare: number;
  /** A range must be at least this many ATRs tall. */
  minRangeAtr: number;
  /** A close this far past a level (in ATRs) counts as a break... */
  breakCloseAtr: number;
  /** ...or this far in one close, without a second close for follow-through. */
  decisiveBreakAtr: number;
  /** Impulse legs at least this many ATRs show real displacement. */
  displacementAtr: number;
  /** Candles considered for swings and zones. */
  lookback: number;
}

export const DEFAULT_REGIME_SETTINGS: RegimeSettings = {
  pivotReach: 3,
  atrPeriod: 14,
  minLegAtr: 1,
  boundaryToleranceAtr: 0.6,
  boundaryToleranceShare: 0.25,
  minRangeAtr: 2,
  breakCloseAtr: 0.15,
  decisiveBreakAtr: 0.75,
  displacementAtr: 2,
  lookback: 200,
};

/**
 * Why a read is TRANSITION: structure broke without a new direction, the
 * latest swings conflict, or there is not enough data to read at all.
 */
export type TransitionKind = "BREAK" | "CONFLICT" | "INSUFFICIENT";

export interface RegimeRead {
  regime: Regime;
  /** False when there were too few candles or swings to read structure. */
  sufficient: boolean;
  /** Set for TRANSITION reads; null otherwise. */
  transitionKind: TransitionKind | null;
  confidence: Confidence;
  /** Last completed close the read was made against. */
  close: number;
  atr: number;
  /** Meaningful swings, oldest first, alternating high/low. */
  swings: Swing[];
  latestSwingHigh: Swing | null;
  latestSwingLow: Swing | null;
  /** The latest impulse leg in the trend's direction (trend regimes). */
  impulse: { from: Swing; to: Swing } | null;
  range: { high: number; low: number; mid: number; highZone: Zone; lowZone: Zone } | null;
  transition: { previous: Regime; broken: string; potential: string } | null;
  zones: Zone[];
  /** Plain-English structure read. */
  interpretation: string;
}

/** Confirmed pivots (both kinds) from completed candles, oldest first. */
export function confirmedPivots(candles: Candle[], reach: number): Swing[] {
  const pivots: Swing[] = [];
  // The last `reach` candles cannot be confirmed yet: no future is used.
  for (let index = reach; index < candles.length - reach; index += 1) {
    const candle = candles[index]!;
    let high = true;
    let low = true;
    for (let offset = 1; offset <= reach; offset += 1) {
      const before = candles[index - offset]!;
      const after = candles[index + offset]!;
      high &&= candle.high > before.high && candle.high >= after.high;
      low &&= candle.low < before.low && candle.low <= after.low;
    }
    const confirmedAt = candles[index + reach]!.time;
    if (high) pivots.push({ type: "high", price: candle.high, index, time: candle.time, confirmedAt });
    if (low) pivots.push({ type: "low", price: candle.low, index, time: candle.time, confirmedAt });
  }
  return pivots;
}

/**
 * Alternating high/low swings with legs of at least `minLeg`: consecutive
 * pivots of the same kind keep the more extreme one, and a turn too small to
 * matter is ignored, so M15-sized wiggles do not count as structure.
 */
export function meaningfulSwings(pivots: Swing[], minLeg: number): Swing[] {
  const swings: Swing[] = [];
  for (const pivot of pivots) {
    const last = swings.at(-1);
    if (!last) {
      swings.push(pivot);
    } else if (last.type === pivot.type) {
      const moreExtreme = pivot.type === "high" ? pivot.price > last.price : pivot.price < last.price;
      if (moreExtreme) swings[swings.length - 1] = pivot;
    } else if (Math.abs(pivot.price - last.price) >= minLeg) {
      swings.push(pivot);
    }
  }
  return swings;
}

/** Group pivots within `tolerance` into zones; strength is the reaction count. */
export function buildZones(pivots: Swing[], tolerance: number, minWidth: number): Zone[] {
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const groups: Swing[][] = [];
  for (const pivot of sorted) {
    const group = groups.at(-1);
    if (group && pivot.price - group[0]!.price <= tolerance) group.push(pivot);
    else groups.push([pivot]);
  }
  return groups.map((group) => {
    const prices = group.map((pivot) => pivot.price);
    let low = Math.min(...prices);
    let high = Math.max(...prices);
    if (high - low < minWidth) {
      const mid = (high + low) / 2;
      low = mid - minWidth / 2;
      high = mid + minWidth / 2;
    }
    const lastTime = group.map((pivot) => pivot.time).sort().at(-1)!;
    return { low, high, touches: group.length, lastTime };
  });
}

function lastOf(swings: Swing[], type: Swing["type"], count: number) {
  return swings.filter((swing) => swing.type === type).slice(-count);
}

/**
 * Has price broken beyond `level` since `sinceIndex`? Needs closes, not wicks:
 * either two consecutive closes past it (follow-through) or one decisive close.
 */
function brokeBeyond(candles: Candle[], sinceIndex: number, level: number, above: boolean, atr: number, settings: RegimeSettings) {
  const past = (close: number, distance: number) => above ? close > level + distance : close < level - distance;
  for (let index = Math.max(sinceIndex + 1, 1); index < candles.length; index += 1) {
    const close = candles[index]!.close;
    if (past(close, settings.decisiveBreakAtr * atr)) return { index, close };
    if (past(close, settings.breakCloseAtr * atr) && past(candles[index - 1]!.close, settings.breakCloseAtr * atr) && index - 1 > sinceIndex) {
      return { index, close };
    }
  }
  return null;
}

const empty = (close: number, atr: number, reason: string): RegimeRead => ({
  regime: "TRANSITION", sufficient: false, transitionKind: "INSUFFICIENT", confidence: "LOW", close, atr, swings: [], latestSwingHigh: null, latestSwingLow: null,
  impulse: null, range: null, transition: { previous: "TRANSITION", broken: "None yet", potential: "Unknown" }, zones: [],
  interpretation: reason,
});

/**
 * Classify the regime of `candles` (any timeframe) from completed candles only.
 * `digits` is the instrument's display precision for the plain-English text.
 */
export function classifyMarketRegime(candlesInput: Candle[], settings: RegimeSettings = DEFAULT_REGIME_SETTINGS, digits = 5): RegimeRead {
  const candles = candlesInput.filter((candle) => candle.complete !== false).slice(-settings.lookback);
  const close = candles.at(-1)?.close ?? 0;
  const atr = calculateAtrValues(candles, settings.atrPeriod).at(-1) ?? 0;
  if (candles.length < settings.atrPeriod + settings.pivotReach * 4 || !(atr > 0)) {
    return empty(close, atr, "Not enough completed candles to read structure.");
  }

  const pivots = confirmedPivots(candles, settings.pivotReach);
  const swings = meaningfulSwings(pivots, settings.minLegAtr * atr);
  const zones = buildZones(pivots, settings.boundaryToleranceAtr * atr * 0.5, 0.15 * atr);
  const highs = lastOf(swings, "high", 3);
  const lows = lastOf(swings, "low", 3);
  const latestSwingHigh = highs.at(-1) ?? null;
  const latestSwingLow = lows.at(-1) ?? null;
  const base = { close, atr, swings, latestSwingHigh, latestSwingLow, zones, sufficient: true };
  if (highs.length < 2 || lows.length < 2) {
    return { ...empty(close, atr, "Too few meaningful swings to confirm a regime."), ...base, sufficient: false };
  }

  const tolerance = settings.boundaryToleranceAtr * atr;
  const [h1, h2] = highs.slice(-2) as [Swing, Swing];
  const [l1, l2] = lows.slice(-2) as [Swing, Swing];
  const lastSwing = swings.at(-1)!;

  // RANGE: the last two highs and the last two lows each sit at one boundary,
  // and the box is tall enough to trade inside. Checked first, because equal
  // highs/lows are not a trend no matter which side is a hair higher.
  // An uneven box still has two boundaries: closeness is judged against the
  // box height as well as ATR, so a slightly lower high or higher low inside
  // a tall range does not read as conflicting structure.
  const boxHeight = Math.max(h1.price, h2.price) - Math.min(l1.price, l2.price);
  const boundaryTolerance = Math.max(tolerance, settings.boundaryToleranceShare * boxHeight);
  const flatHighs = Math.abs(h2.price - h1.price) <= boundaryTolerance;
  const flatLows = Math.abs(l2.price - l1.price) <= boundaryTolerance;
  if (flatHighs && flatLows) {
    const high = Math.max(h1.price, h2.price);
    const low = Math.min(l1.price, l2.price);
    if (high - low >= settings.minRangeAtr * atr) {
      const sinceIndex = Math.min(h1.index, l1.index);
      const upBreak = brokeBeyond(candles, Math.max(h2.index, l2.index), high, true, atr, settings);
      const downBreak = brokeBeyond(candles, Math.max(h2.index, l2.index), low, false, atr, settings);
      const breakNow = upBreak && downBreak ? (upBreak.index > downBreak.index ? upBreak : downBreak) : upBreak ?? downBreak;
      if (breakNow) {
        const up = breakNow === upBreak;
        return {
          ...base, regime: "TRANSITION", transitionKind: "BREAK", confidence: "MEDIUM", impulse: null, range: null,
          transition: {
            previous: "RANGE",
            broken: `Closed ${up ? "above range high" : "below range low"} ${(up ? high : low).toFixed(digits)}`,
            potential: up ? "UPTREND, if a higher low holds above the old range" : "DOWNTREND, if a lower high holds below the old range",
          },
          interpretation: `The range ${low.toFixed(digits)}–${high.toFixed(digits)} failed with a close ${up ? "above" : "below"} it; the breakout is not yet confirmed as a trend.`,
        };
      }
      const highZone = zoneAround(zones, high, tolerance) ?? { low: high - 0.15 * atr, high, touches: 2, lastTime: h2.time };
      const lowZone = zoneAround(zones, low, tolerance) ?? { low, high: low + 0.15 * atr, touches: 2, lastTime: l2.time };
      const touches = swings.filter((swing) => swing.index >= sinceIndex
        && (swing.type === "high" ? Math.abs(swing.price - high) <= boundaryTolerance : Math.abs(swing.price - low) <= boundaryTolerance)).length;
      return {
        ...base, regime: "RANGE", transitionKind: null, confidence: touches >= 5 ? "HIGH" : touches >= 4 ? "MEDIUM" : "LOW", impulse: null,
        range: { high, low, mid: (high + low) / 2, highZone, lowZone }, transition: null,
        interpretation: `Swing highs near ${high.toFixed(digits)} and lows near ${low.toFixed(digits)} repeat; price is oscillating inside that box.`,
      };
    }
  }

  const upSequence = h2.price > h1.price + tolerance * 0.25 && l2.price > l1.price + tolerance * 0.25;
  const downSequence = h2.price < h1.price - tolerance * 0.25 && l2.price < l1.price - tolerance * 0.25;

  if (upSequence || downSequence) {
    const up = upSequence;
    // The structure level that defines the trend: the latest higher low (up)
    // or lower high (down). A real close through it ends the trend.
    const structure = up ? l2 : h2;
    const broke = brokeBeyond(candles, structure.index, structure.price, !up, atr, settings);
    if (broke) {
      return {
        ...base, regime: "TRANSITION", transitionKind: "BREAK", confidence: "MEDIUM", impulse: null, range: null,
        transition: {
          previous: up ? "UPTREND" : "DOWNTREND",
          broken: `Closed ${up ? "below the higher low" : "above the lower high"} at ${structure.price.toFixed(digits)}`,
          potential: up ? "RANGE or DOWNTREND" : "RANGE or UPTREND",
        },
        interpretation: `${up ? "Higher highs and higher lows" : "Lower highs and lower lows"} held until price closed through ${structure.price.toFixed(digits)}; the old trend is no longer reliable.`,
      };
    }
    // Impulse: the latest leg in the trend's direction.
    const from = up ? l2 : h2;
    const toCandidates = swings.filter((swing) => swing.index > from.index && swing.type === (up ? "high" : "low"));
    const to = toCandidates.at(-1) ?? (up ? h2 : l2);
    const impulse = to.index > from.index ? { from, to } : { from: up ? l1 : h1, to: up ? h2 : l2 };
    const legAtr = Math.abs(impulse.to.price - impulse.from.price) / atr;
    const [h0] = highs.length === 3 ? highs : [null];
    const [lo0] = lows.length === 3 ? lows : [null];
    const third = up
      ? h0 !== null && lo0 !== null && h1.price > h0.price && l1.price > lo0.price
      : h0 !== null && lo0 !== null && h1.price < h0.price && l1.price < lo0.price;
    const confidence: Confidence = legAtr < settings.displacementAtr ? "LOW" : third ? "HIGH" : "MEDIUM";
    return {
      ...base, regime: up ? "UPTREND" : "DOWNTREND", transitionKind: null, confidence, impulse, range: null, transition: null,
      interpretation: `${up ? "Higher highs and higher lows" : "Lower highs and lower lows"}${third ? " for three swings" : ""}; latest impulse ${legAtr.toFixed(1)} ATR${legAtr < settings.displacementAtr ? " (weak displacement)" : ""}. Structure holds while price stays ${up ? "above" : "below"} ${structure.price.toFixed(digits)}.`,
    };
  }

  // Swings conflict: expanding (higher high + lower low) or contracting
  // (lower high + higher low) without a clean box.
  const expanding = h2.price > h1.price && l2.price < l1.price;
  return {
    ...base, regime: "TRANSITION", transitionKind: "CONFLICT", confidence: "LOW", impulse: null, range: null,
    transition: {
      previous: lastSwing.type === "high" ? "UPTREND" : "DOWNTREND",
      broken: expanding ? "Swings are expanding (higher high and lower low)" : "Swings are contracting (lower high and higher low)",
      potential: expanding ? "Unclear; wait for a new sequence" : "RANGE, if the boundaries start to repeat",
    },
    interpretation: `Swing structure conflicts: ${expanding ? "a higher high and a lower low" : "a lower high and a higher low"}. No regime is confirmed yet.`,
  };
}

function zoneAround(zones: Zone[], price: number, tolerance: number) {
  return zones
    .filter((zone) => price >= zone.low - tolerance && price <= zone.high + tolerance)
    .sort((a, b) => b.touches - a.touches)[0] ?? null;
}

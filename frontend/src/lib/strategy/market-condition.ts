import type { Candle, MajorInstrument } from "@/types/forex";
import { pipSizeFor } from "@/lib/instruments/catalog";
import {
  computeSupportResistanceLevels,
  type SupportResistanceLevels,
} from "@/lib/strategy/support-resistance";

/**
 * Stage 1 market-condition engine.
 *
 * candles → per-window features → per-window classification → S/R location →
 * analyze gate. Everything here is deterministic and UI-free so it can be
 * reused later for live trade monitoring. No AI, no fetching, no chart types.
 *
 * A 15m analysis is read over three completed-candle windows:
 *   1H = last 4 completed candles
 *   2H = last 8 completed candles
 *   4H = last 16 completed candles
 * The currently forming candle is never used.
 */

export type MarketCondition =
  | "TRENDING_BULLISH"
  | "TRENDING_BEARISH"
  | "STRUCTURED_RANGE"
  | "MESSY_CHOP";

export type PriceLocation =
  | "NEAR_SUPPORT"
  | "NEAR_RESISTANCE"
  | "MIDDLE_OF_RANGE"
  | "OUTSIDE_RANGE";

export type AnalyzeGate = "CONTINUE" | "WAIT";

export type TrendDirection = "bullish" | "bearish" | "sideways";

/** ---- Classification thresholds (documented so a read can be checked). ---- */
export const MARKET_CONDITION_THRESHOLDS = {
  /** Directional efficiency at/above this is trend-like. */
  trendEfficiency: 0.5,
  /** Regression slope across the window (in ATR units) required for a trend. */
  trendSlopeAtr: 1.5,
  /** A trend cannot flip direction on more than this share of candles. */
  trendMaxDirectionChange: 0.5,
  /** Classic chop: heavy overlap AND frequent bull/bear flips together. */
  chopOverlap: 0.55,
  chopDirectionChange: 0.55,
  /** Grinding in place: low net progress while candles sit on top of each other.
   *  Low efficiency ALONE is not messy — a clean wide range also has low net
   *  displacement but its legs do not overlap. Overlap is what separates them. */
  chopEfficiency: 0.3,
  chopGrindOverlap: 0.5,
  /** Small-bodied noise: mostly wick, flipping direction, going nowhere. */
  chopNoiseBodyToRange: 0.4,
  chopNoiseDirectionChange: 0.5,
  /** "Near" a level means within this many ATRs of it... */
  nearAtrFraction: 0.6,
  /** ...clamped to a sane pip floor and ceiling (timeframe-scaled by profile). */
  nearPipsFloor: 6,
  nearPipsCeiling: 20,
} as const;

export type MarketConditionThresholds = { -readonly [K in keyof typeof MARKET_CONDITION_THRESHOLDS]: number };

export interface WindowFeatures {
  /** Completed candles in this window (4, 8, or 16). */
  bars: number;
  /** absolute net movement / total path movement, 0..1. */
  directionalEfficiency: number;
  /** |lastClose − firstClose| in price. */
  netDisplacement: number;
  /** Sum of |close_i − close_{i−1}| in price (the path length). */
  totalMovement: number;
  /** netDisplacement expressed in ATR units (signed by slope). */
  displacementAtr: number;
  /** Average overlap ratio of adjacent candles, 0..1 (compression/sideways). */
  candleOverlap: number;
  /** Share of adjacent candles that flipped bull↔bear, 0..1. */
  directionChangeRate: number;
  /** Mean candle body in price. */
  avgBody: number;
  /** Mean candle range (high−low) in price. */
  avgRange: number;
  /** avgBody / avgRange, 0..1. */
  bodyToRange: number;
  /** Mean wick length / mean body (how much of the move gets rejected). */
  wickToBody: number;
  /** Average true range across the window, in price. */
  atr: number;
  /** ATR in pips. */
  atrPips: number;
  /** Least-squares slope of closes, price per bar. */
  slope: number;
  /** Total slope displacement across the window in ATR units, signed. */
  slopeAtr: number;
  higherHighs: boolean;
  higherLows: boolean;
  lowerHighs: boolean;
  lowerLows: boolean;
  /** This window's own classification. */
  condition: MarketCondition;
}

/** Short/medium/broad window candle counts for the selected timeframe. */
export interface WindowSizes {
  short: number;
  medium: number;
  broad: number;
}

/** The default 15m windows (4/8/16 completed candles = 1H/2H/4H). */
export const DEFAULT_WINDOW_SIZES: WindowSizes = { short: 4, medium: 8, broad: 16 };

export interface MarketAssessment {
  instrument: MajorInstrument;
  /** The analysis timeframe (OANDA granularity, e.g. "M15"). */
  timeframe: string;
  windowSizes: WindowSizes;
  /** Number of completed candles the read was built from. */
  completedBars: number;
  windows: {
    short: WindowFeatures;
    medium: WindowFeatures;
    broad: WindowFeatures;
  };
  /** The final, combined classification. */
  condition: MarketCondition;
  trendDirection: TrendDirection;
  location: PriceLocation;
  /** The one gate that decides whether a proposal is even considered. */
  gate: AnalyzeGate;
  /** Plain-English explanation of the gate decision. */
  reason: string;
  levels: SupportResistanceLevels | null;
  nearestSupportPips: number | null;
  nearestResistancePips: number | null;
  /** Compact, inspectable summary for dev validation against the chart. */
  debug: MarketConditionDebug;
}

export interface MarketConditionDebug {
  pair: string;
  timeframe: string;
  windowSizes: WindowSizes;
  shortTerm: MarketCondition;
  mediumTerm: MarketCondition;
  broad: MarketCondition;
  finalCondition: MarketCondition;
  directionalEfficiency: number;
  candleOverlap: number;
  directionChangeRate: number;
  atrPips: number;
  slopeAtr: number;
  location: PriceLocation;
  nearestSupportPips: number | null;
  nearestResistancePips: number | null;
  gate: AnalyzeGate;
}

const round = (value: number, places = 4) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** Least-squares slope of a series against its integer index. */
function linearSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = index - meanX;
    numerator += dx * (values[index]! - meanY);
    denominator += dx * dx;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Average true range within a window (first bar seeded with its own range). */
function windowAtr(window: Candle[]): number {
  let sum = 0;
  for (let index = 0; index < window.length; index += 1) {
    const candle = window[index]!;
    const priorClose = window[index - 1]?.close ?? candle.open;
    sum += Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - priorClose),
      Math.abs(candle.low - priorClose),
    );
  }
  return window.length ? sum / window.length : 0;
}

/** Compute every feature for one completed-candle window. */
export function computeWindowFeatures(
  window: Candle[],
  instrument: MajorInstrument,
): WindowFeatures {
  const pip = pipSizeFor(instrument);
  const bars = window.length;
  const closes = window.map((candle) => candle.close);
  const bodies = window.map((candle) => Math.abs(candle.close - candle.open));
  const ranges = window.map((candle) => candle.high - candle.low);

  const netDisplacement = Math.abs((closes.at(-1) ?? 0) - (closes[0] ?? 0));
  let totalMovement = 0;
  for (let index = 1; index < closes.length; index += 1) {
    totalMovement += Math.abs(closes[index]! - closes[index - 1]!);
  }
  const directionalEfficiency = totalMovement > 0 ? netDisplacement / totalMovement : 0;

  // Overlap of adjacent candles: shared height / combined height.
  let overlapSum = 0;
  let overlapPairs = 0;
  for (let index = 1; index < window.length; index += 1) {
    const a = window[index - 1]!;
    const b = window[index]!;
    const overlap = Math.max(0, Math.min(a.high, b.high) - Math.max(a.low, b.low));
    const combined = Math.max(a.high, b.high) - Math.min(a.low, b.low);
    if (combined > 0) {
      overlapSum += overlap / combined;
      overlapPairs += 1;
    }
  }
  const candleOverlap = overlapPairs ? overlapSum / overlapPairs : 0;

  // Direction-change rate: adjacent bull/bear flips over comparable pairs.
  const signs = window.map((candle) => Math.sign(candle.close - candle.open));
  let changes = 0;
  let comparablePairs = 0;
  for (let index = 1; index < signs.length; index += 1) {
    const previous = signs[index - 1]!;
    const current = signs[index]!;
    if (previous === 0 || current === 0) continue;
    comparablePairs += 1;
    if (previous !== current) changes += 1;
  }
  const directionChangeRate = comparablePairs ? changes / comparablePairs : 0;

  const avgBody = bodies.reduce((sum, value) => sum + value, 0) / (bars || 1);
  const avgRange = ranges.reduce((sum, value) => sum + value, 0) / (bars || 1);
  const bodyToRange = avgRange > 0 ? avgBody / avgRange : 0;
  const wickToBody = avgBody > 0 ? Math.max(0, avgRange - avgBody) / avgBody : 0;

  const atr = windowAtr(window);
  const atrPips = pip > 0 ? atr / pip : 0;

  const slope = linearSlope(closes);
  const slopeAtr = atr > 0 ? (slope * Math.max(bars - 1, 1)) / atr : 0;
  const displacementAtr = atr > 0 ? (netDisplacement / atr) * Math.sign(slope || 1) : 0;

  // Half-over-half structure read (cheap HH/HL/LH/LL for small windows).
  const mid = Math.floor(bars / 2);
  const firstHalf = window.slice(0, mid);
  const secondHalf = window.slice(mid);
  const maxOf = (list: Candle[]) => (list.length ? Math.max(...list.map((c) => c.high)) : NaN);
  const minOf = (list: Candle[]) => (list.length ? Math.min(...list.map((c) => c.low)) : NaN);
  const higherHighs = maxOf(secondHalf) > maxOf(firstHalf);
  const higherLows = minOf(secondHalf) > minOf(firstHalf);
  const lowerHighs = maxOf(secondHalf) < maxOf(firstHalf);
  const lowerLows = minOf(secondHalf) < minOf(firstHalf);

  const features: WindowFeatures = {
    bars,
    directionalEfficiency: round(directionalEfficiency),
    netDisplacement: round(netDisplacement, 6),
    totalMovement: round(totalMovement, 6),
    displacementAtr: round(displacementAtr, 3),
    candleOverlap: round(candleOverlap),
    directionChangeRate: round(directionChangeRate),
    avgBody: round(avgBody, 6),
    avgRange: round(avgRange, 6),
    bodyToRange: round(bodyToRange),
    wickToBody: round(wickToBody),
    atr: round(atr, 6),
    atrPips: round(atrPips, 2),
    slope: round(slope, 8),
    slopeAtr: round(slopeAtr, 3),
    higherHighs,
    higherLows,
    lowerHighs,
    lowerLows,
    condition: "MESSY_CHOP",
  };
  features.condition = classifyWindow(features);
  return features;
}

/** Classify a single window from its features. */
export function classifyWindow(features: WindowFeatures): MarketCondition {
  const t = MARKET_CONDITION_THRESHOLDS;
  const trendlike =
    features.directionalEfficiency >= t.trendEfficiency &&
    Math.abs(features.slopeAtr) >= t.trendSlopeAtr &&
    features.directionChangeRate <= t.trendMaxDirectionChange;
  if (trendlike) {
    return features.slope >= 0 ? "TRENDING_BULLISH" : "TRENDING_BEARISH";
  }
  const messy =
    // Classic chop: overlapping candles constantly flipping direction.
    (features.candleOverlap >= t.chopOverlap && features.directionChangeRate >= t.chopDirectionChange) ||
    // Grinding in place: no net progress AND candles sit on top of each other.
    (features.directionalEfficiency <= t.chopEfficiency && features.candleOverlap >= t.chopGrindOverlap) ||
    // Small-bodied noise: mostly wick, flipping, going nowhere.
    (features.bodyToRange <= t.chopNoiseBodyToRange &&
      features.directionChangeRate >= t.chopNoiseDirectionChange &&
      features.directionalEfficiency < t.trendEfficiency);
  if (messy) return "MESSY_CHOP";
  // Not a trend, not messy: an organized range (clean legs, low overlap).
  return "STRUCTURED_RANGE";
}

/**
 * Combine the three window classifications into one. Longer windows anchor the
 * read; the 2H window breaks ties. A lone unconfirmed trend does not win.
 */
export function combineConditions(
  shortTerm: MarketCondition,
  mediumTerm: MarketCondition,
  broad: MarketCondition,
): MarketCondition {
  const labels = [shortTerm, mediumTerm, broad];
  const count = (label: MarketCondition) => labels.filter((value) => value === label).length;
  const bull = count("TRENDING_BULLISH");
  const bear = count("TRENDING_BEARISH");
  const messy = count("MESSY_CHOP");
  const structured = count("STRUCTURED_RANGE");

  if (bull >= 2) return "TRENDING_BULLISH";
  if (bear >= 2) return "TRENDING_BEARISH";
  if (messy >= 2) return "MESSY_CHOP";
  if (structured >= 1 && messy === 0) return "STRUCTURED_RANGE";
  // No majority and mixed signals: anchor on the medium-term read.
  return mediumTerm;
}

/** Where the current price sits relative to the existing S/R levels. */
export function locatePrice(
  levels: SupportResistanceLevels | null,
  instrument: MajorInstrument,
  atrPips: number,
  thresholds: MarketConditionThresholds = MARKET_CONDITION_THRESHOLDS,
): { location: PriceLocation; nearestSupportPips: number | null; nearestResistancePips: number | null } {
  if (!levels) {
    return { location: "MIDDLE_OF_RANGE", nearestSupportPips: null, nearestResistancePips: null };
  }
  const t = thresholds;
  const pip = pipSizeFor(instrument);
  const { current, rangeHigh, rangeLow, swingHigh, swingLow } = levels;

  const supports = [rangeLow, swingLow].filter(
    (level): level is number => level !== null && level <= current,
  );
  const resistances = [rangeHigh, swingHigh].filter(
    (level): level is number => level !== null && level >= current,
  );
  const nearestSupportPips = supports.length
    ? Math.min(...supports.map((level) => (current - level) / pip))
    : null;
  const nearestResistancePips = resistances.length
    ? Math.min(...resistances.map((level) => (level - current) / pip))
    : null;

  const nearThreshold = Math.min(
    Math.max(atrPips * t.nearAtrFraction, t.nearPipsFloor),
    t.nearPipsCeiling,
  );

  let location: PriceLocation;
  if (current > rangeHigh || current < rangeLow) {
    location = "OUTSIDE_RANGE";
  } else if (
    nearestSupportPips !== null &&
    nearestSupportPips <= nearThreshold &&
    (nearestResistancePips === null || nearestSupportPips <= nearestResistancePips)
  ) {
    location = "NEAR_SUPPORT";
  } else if (nearestResistancePips !== null && nearestResistancePips <= nearThreshold) {
    location = "NEAR_RESISTANCE";
  } else {
    location = "MIDDLE_OF_RANGE";
  }

  return {
    location,
    nearestSupportPips: nearestSupportPips === null ? null : round(nearestSupportPips, 1),
    nearestResistancePips: nearestResistancePips === null ? null : round(nearestResistancePips, 1),
  };
}

const CONDITION_LABEL: Record<MarketCondition, string> = {
  TRENDING_BULLISH: "trending higher",
  TRENDING_BEARISH: "trending lower",
  STRUCTURED_RANGE: "rotating in an organized range",
  MESSY_CHOP: "chopping with no clean direction",
};

const LOCATION_LABEL: Record<PriceLocation, string> = {
  NEAR_SUPPORT: "near support",
  NEAR_RESISTANCE: "near resistance",
  MIDDLE_OF_RANGE: "in the middle of the range",
  OUTSIDE_RANGE: "outside the recent range",
};

function gateReason(
  condition: MarketCondition,
  location: PriceLocation,
  gate: AnalyzeGate,
  medium: WindowFeatures,
): string {
  if (gate === "WAIT") {
    return `Heavy candle overlap (${Math.round(medium.candleOverlap * 100)}%) and weak directional movement ` +
      `(efficiency ${Math.round(medium.directionalEfficiency * 100)}%) over the medium-term window — ` +
      `${CONDITION_LABEL[condition]} ${LOCATION_LABEL[location]}. No clean setup, so wait.`;
  }
  return `Market is ${CONDITION_LABEL[condition]} and price is ${LOCATION_LABEL[location]} — ` +
    `clean enough to consider a setup. Continuing to full analysis.`;
}

/**
 * The one entry point. Feed it a completed-or-forming candle series for the
 * selected timeframe. Windows and the timeframe label are timeframe-aware
 * (item 4); the classification thresholds are held constant across timeframes
 * so this stays one strategy, not five (item 19).
 */
export function assessMarketCondition(input: {
  candles: Candle[];
  instrument: MajorInstrument;
  /** OANDA granularity this series is (e.g. "M15"). Default "M15". */
  timeframe?: string;
  /** Short/medium/broad window candle counts. Default 4/8/16. */
  windows?: WindowSizes;
  /** Timeframe-profile overrides (near-level pip floor/ceiling). */
  thresholds?: Partial<MarketConditionThresholds>;
}): MarketAssessment {
  const { instrument } = input;
  const timeframe = input.timeframe ?? "M15";
  const windowSizes = input.windows ?? DEFAULT_WINDOW_SIZES;
  const thresholds: MarketConditionThresholds = { ...MARKET_CONDITION_THRESHOLDS, ...input.thresholds };
  // Never use the currently forming candle for completed-candle math.
  const completed = input.candles.filter((candle) => candle.complete !== false);

  const takeLast = (count: number) => completed.slice(-count);
  const short = computeWindowFeatures(takeLast(windowSizes.short), instrument);
  const medium = computeWindowFeatures(takeLast(windowSizes.medium), instrument);
  const broad = computeWindowFeatures(takeLast(windowSizes.broad), instrument);

  const condition = combineConditions(short.condition, medium.condition, broad.condition);
  const trendDirection: TrendDirection =
    condition === "TRENDING_BULLISH"
      ? "bullish"
      : condition === "TRENDING_BEARISH"
        ? "bearish"
        : "sideways";

  // S/R location uses the same levels the chart draws, off the completed series.
  const levels = computeSupportResistanceLevels(completed, instrument);
  const { location, nearestSupportPips, nearestResistancePips } = locatePrice(
    levels,
    instrument,
    medium.atrPips,
    thresholds,
  );

  // Stage 1 gate: messy chop is a WAIT; everything else continues. Structured
  // range is deliberately NOT blocked — it is where the S/R strategy works.
  const gate: AnalyzeGate = condition === "MESSY_CHOP" ? "WAIT" : "CONTINUE";
  const reason = gateReason(condition, location, gate, medium);

  return {
    instrument,
    timeframe,
    windowSizes,
    completedBars: completed.length,
    windows: { short, medium, broad },
    condition,
    trendDirection,
    location,
    gate,
    reason,
    levels,
    nearestSupportPips,
    nearestResistancePips,
    debug: {
      pair: instrument,
      timeframe,
      windowSizes,
      shortTerm: short.condition,
      mediumTerm: medium.condition,
      broad: broad.condition,
      finalCondition: condition,
      directionalEfficiency: medium.directionalEfficiency,
      candleOverlap: medium.candleOverlap,
      directionChangeRate: medium.directionChangeRate,
      atrPips: medium.atrPips,
      slopeAtr: medium.slopeAtr,
      location,
      nearestSupportPips,
      nearestResistancePips,
      gate,
    },
  };
}

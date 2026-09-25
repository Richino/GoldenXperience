import { calculateAtr, deriveDominantSwingTrend, type SwingTrendAnchor } from "@/lib/chart-utils";
import { pipSizeFor, precisionFor } from "@/lib/instruments/catalog";
import { computeSupportResistanceLevels } from "@/lib/strategy/support-resistance";
import type { Candle, MajorInstrument } from "@/types/forex";

/** Deliberately fixed V1 research settings; none are execution inputs. */
export const TREND_PULLBACK_V1 = {
  entryBufferPips: 2,
  stopAtrMultiplier: 0.75,
  minimumRiskReward: 1.5,
} as const;

type Direction = "BULLISH" | "BEARISH" | "MIXED";
type PullbackLevelKind = "SWING_SUPPORT" | "RANGE_SUPPORT" | "SWING_RESISTANCE" | "RANGE_RESISTANCE";

export type TrendPullbackV1Result = {
  strategy: "TrendPullbackV1";
  status: "TRADE_PLAN" | "ENTRY_AVAILABLE_NOW" | "NO_VALID_ENTRY";
  trend: Direction;
  majorTrend: Direction;
  currentTrend: Direction;
  currentMove: "BEARISH_PULLBACK" | "BULLISH_PULLBACK" | "NONE";
  action: "LONG" | "SHORT" | null;
  orderType: "BUY_LIMIT" | "SELL_LIMIT" | null;
  currentPrice: number;
  priceBasis: "LIVE_QUOTE" | "LAST_M15_CLOSE";
  entry: number | null;
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  distanceToEntryPips: number | null;
  stopLoss: number | null;
  stopDistancePips: number | null;
  takeProfit: number | null;
  targetDistancePips: number | null;
  riskReward: number | null;
  reasons: string[];
  debug: {
    trendSource: "LEGACY_SWING_TREND_LINES";
    pointA: SwingTrendAnchor | null;
    pointB: SwingTrendAnchor | null;
    projectedTrendlinePrice: number | null;
    pullbackLevel: number | null;
    pullbackLevelKind: PullbackLevelKind | null;
    invalidationLevel: number | null;
    targetLevel: number | null;
  };
};

/**
 * TrendPullbackV1 has deliberately separate responsibilities:
 * - Legacy Swing Trend Lines establish direction.
 * - Shared S/R supplies the level to wait for and the opposing target.
 *
 * Adaptive Swing Trendlines remain a chart research overlay and never affect
 * this result. That prevents a local adaptive line from overriding the
 * broader visible trend.
 */
export function analyzeTrendPullbackV1(
  input: { instrument: MajorInstrument; candles: Candle[]; currentPrice?: number | null },
  settings: { entryBufferPips: number; stopAtrMultiplier?: number; minimumRiskReward?: number } = TREND_PULLBACK_V1,
): TrendPullbackV1Result {
  const candles = input.candles.filter((candle) => candle.complete !== false);
  const last = candles.at(-1);
  const pip = pipSizeFor(input.instrument);
  const round = (value: number) => Number(value.toFixed(precisionFor(input.instrument)));
  const hasCurrentPrice = typeof input.currentPrice === "number" && Number.isFinite(input.currentPrice) && input.currentPrice > 0;
  const currentPrice = hasCurrentPrice ? input.currentPrice! : last?.close ?? 0;
  const trendRead = deriveDominantSwingTrend(candles);
  const trend: Direction = trendRead ? trendRead.direction.toUpperCase() as Direction : "MIXED";
  const slope = trendRead ? (trendRead.second.price - trendRead.first.price) / (trendRead.second.index - trendRead.first.index) : null;
  const projectedTrendlinePrice = trendRead && slope !== null && last
    ? round(trendRead.second.price + slope * (trendRead.last.index - trendRead.second.index))
    : null;
  const levels = computeSupportResistanceLevels(candles, input.instrument);
  const result: TrendPullbackV1Result = {
    strategy: "TrendPullbackV1", status: "NO_VALID_ENTRY", trend, majorTrend: trend, currentTrend: trend,
    currentMove: "NONE", action: null, orderType: null, currentPrice: round(currentPrice),
    priceBasis: hasCurrentPrice ? "LIVE_QUOTE" : "LAST_M15_CLOSE",
    entry: null, entryZoneLow: null, entryZoneHigh: null, distanceToEntryPips: null,
    stopLoss: null, stopDistancePips: null, takeProfit: null, targetDistancePips: null,
    riskReward: null, reasons: [],
    debug: {
      trendSource: "LEGACY_SWING_TREND_LINES", pointA: trendRead?.first ?? null, pointB: trendRead?.second ?? null,
      projectedTrendlinePrice, pullbackLevel: null, pullbackLevelKind: null, invalidationLevel: null, targetLevel: null,
    },
  };
  const reject = (reason: string) => { result.reasons.push(reason); return result; };
  if (candles.length < 24 || !last) return reject("Not enough completed M15 candles for a trendline analysis.");
  if (!trendRead || projectedTrendlinePrice === null) return reject("No confirmed legacy swing trend is available yet.");

  const long = trend === "BULLISH";
  // A historical direction is not a valid present trend after price closes
  // through its legacy trendline support/resistance.
  const trendlineBroken = long ? last.close < projectedTrendlinePrice : last.close > projectedTrendlinePrice;
  if (trendlineBroken) return reject("The legacy swing trendline has been broken; wait for a new confirmed trend.");
  if (!levels) return reject("No support/resistance pullback levels are available yet.");
  const tolerance = settings.entryBufferPips * pip;

  const recent = candles.slice(-4);
  const changes = recent.slice(1).map((candle, index) => candle.close - recent[index]!.close);
  const activePullback = changes.filter((change) => long ? change < 0 : change > 0).length >= 2
    && (long ? last.close < recent[0]!.close : last.close > recent[0]!.close);
  result.currentMove = activePullback ? long ? "BEARISH_PULLBACK" : "BULLISH_PULLBACK" : "NONE";

  const pullbackCandidates: Array<{ price: number; kind: PullbackLevelKind } | null> = long
    ? [
      levels.swingLow === null ? null : { price: levels.swingLow, kind: "SWING_SUPPORT" },
      { price: levels.rangeLow, kind: "RANGE_SUPPORT" },
    ]
    : [
      levels.swingHigh === null ? null : { price: levels.swingHigh, kind: "SWING_RESISTANCE" },
      { price: levels.rangeHigh, kind: "RANGE_RESISTANCE" },
    ];
  const usablePullbacks = pullbackCandidates
    .filter((level): level is { price: number; kind: PullbackLevelKind } => level !== null)
    .filter((level) => long ? level.price <= currentPrice + tolerance : level.price >= currentPrice - tolerance)
    .sort((left, right) => Math.abs(left.price - currentPrice) - Math.abs(right.price - currentPrice));
  const pullback = usablePullbacks[0];
  if (!pullback) return reject("No direction-aligned support/resistance pullback level is available ahead of price.");

  const opposingCandidates = long
    ? [levels.swingHigh, levels.rangeHigh].filter((price): price is number => price !== null && price > pullback.price)
    : [levels.swingLow, levels.rangeLow].filter((price): price is number => price !== null && price < pullback.price);
  const targetLevel = opposingCandidates
    .sort((left, right) => Math.abs(left - pullback.price) - Math.abs(right - pullback.price))[0];
  if (targetLevel === undefined) return reject("No opposing support/resistance level leaves a target for this pullback.");

  const entry = round(pullback.price);
  const zoneLow = round(entry - tolerance);
  const zoneHigh = round(entry + tolerance);
  // The selected S/R level is where we want to enter. The next structural S/R
  // level beyond it is where the continuation thesis is invalidated. Do not
  // manufacture a stop from an arbitrary pip distance when that level is absent.
  const invalidationLevel = long
    ? (levels.rangeLow < entry ? levels.rangeLow : null)
    : (levels.rangeHigh > entry ? levels.rangeHigh : null);
  if (invalidationLevel === null) {
    return reject("No deeper structural support/resistance level is available for a stop; wait for a clearer pullback.");
  }
  const latestAtr = calculateAtr(candles, 14).at(-1) ?? 0;
  const stopBuffer = latestAtr * (settings.stopAtrMultiplier ?? TREND_PULLBACK_V1.stopAtrMultiplier);
  const stop = round(long ? invalidationLevel - stopBuffer : invalidationLevel + stopBuffer);
  const target = round(long ? targetLevel - pip : targetLevel + pip);
  const risk = long ? entry - stop : stop - entry;
  const reward = long ? target - entry : entry - target;
  const minimumRiskReward = settings.minimumRiskReward ?? TREND_PULLBACK_V1.minimumRiskReward;
  result.debug.pullbackLevel = entry;
  result.debug.pullbackLevelKind = pullback.kind;
  result.debug.invalidationLevel = invalidationLevel;
  result.debug.targetLevel = targetLevel;
  result.entry = entry;
  result.entryZoneLow = zoneLow;
  result.entryZoneHigh = zoneHigh;
  result.distanceToEntryPips = Number((Math.abs(currentPrice - entry) / pip).toFixed(1));
  result.stopLoss = stop;
  result.stopDistancePips = Number((risk / pip).toFixed(1));
  result.takeProfit = target;
  result.targetDistancePips = Number((reward / pip).toFixed(1));
  result.riskReward = risk > 0 ? Number((reward / risk).toFixed(2)) : null;
  if (risk <= pip || reward <= pip || result.riskReward === null || result.riskReward < minimumRiskReward) {
    return reject(`The nearest ${pullback.kind.toLowerCase().replace("_", " ")} does not leave at least ${minimumRiskReward}:1 risk/reward to the next opposing level.`);
  }

  const inZone = currentPrice >= zoneLow && currentPrice <= zoneHigh;
  result.status = inZone && hasCurrentPrice ? "ENTRY_AVAILABLE_NOW" : "TRADE_PLAN";
  result.action = long ? "LONG" : "SHORT";
  result.orderType = !hasCurrentPrice || inZone ? null : long ? "BUY_LIMIT" : "SELL_LIMIT";
  result.reasons = [
    `Legacy Swing Trend Lines confirm a ${trend.toLowerCase()} trend.`,
    `${pullback.kind.replace("_", " ")} is the nearest direction-aligned pullback level.`,
    `The next opposing S/R level provides ${result.riskReward.toFixed(2)}:1 risk/reward with the stop beyond the outer structural boundary.`,
  ];
  return result;
}

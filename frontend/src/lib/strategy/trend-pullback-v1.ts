import { calculateAtr, deriveDominantSwingTrend, type SwingTrendAnchor } from "@/lib/chart-utils";
import { pipSizeFor, precisionFor } from "@/lib/instruments/catalog";
import { computeSupportResistanceLevels } from "@/lib/strategy/support-resistance";
import type { Candle, MajorInstrument } from "@/types/forex";

/**
 * Loose V1 settings for the forward test. Loose means Analyze always returns a
 * plan: anything questionable becomes a warning instead of a refusal. Nothing
 * here has an edge proven by backtest; the plan is information to be logged.
 */
export const TREND_PULLBACK_V1 = {
  entryBufferPips: 2,
  minStopPips: 10,
  stopH1AtrMultiplier: 1,
  rewardRisk: 2,
  fallbackPullbackH1Atr: 0.5,
} as const;

type Direction = "BULLISH" | "BEARISH" | "MIXED";
type PullbackLevelKind = "SWING_SUPPORT" | "RANGE_SUPPORT" | "SWING_RESISTANCE" | "RANGE_RESISTANCE" | "ATR_PULLBACK";

export type TrendPullbackV1Result = {
  strategy: "TrendPullbackV1";
  version: "loose-v1";
  status: "TRADE_PLAN" | "ENTRY_AVAILABLE_NOW" | "NO_VALID_ENTRY";
  trend: Direction;
  majorTrend: Direction;
  currentTrend: Direction;
  trendSource: "SWING_STRUCTURE" | "PRICE_CHANGE_24H";
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
  /** Things a strict version would have refused on; shown with the plan. */
  warnings: string[];
  debug: {
    trendSource: "LEGACY_SWING_TREND_LINES";
    pointA: SwingTrendAnchor | null;
    pointB: SwingTrendAnchor | null;
    projectedTrendlinePrice: number | null;
    pullbackLevel: number | null;
    pullbackLevelKind: PullbackLevelKind | null;
    invalidationLevel: number | null;
    targetLevel: number | null;
    h1AtrPips: number | null;
  };
};

/** Group completed M15 candles into clock-hour candles so the stop can be sized from 1-hour volatility. */
function hourlyFromM15(candles: Candle[]): Candle[] {
  const hours = new Map<number, Candle>();
  for (const candle of candles) {
    const hour = Math.floor(Date.parse(candle.time) / 3_600_000);
    const existing = hours.get(hour);
    if (!existing) hours.set(hour, { ...candle });
    else {
      existing.high = Math.max(existing.high, candle.high);
      existing.low = Math.min(existing.low, candle.low);
      existing.close = candle.close;
    }
  }
  return [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([, candle]) => candle);
}

/**
 * TrendPullbackV1 (loose): detect the trend, find the pullback level in that
 * trend's direction, and return a full plan every time.
 * - Trend: Legacy Swing Trend Lines; when the swings are mixed, the last 24h
 *   of price decides.
 * - Pullback: the nearest shared S/R level on the trend side of price; when
 *   none exists, half an average 1-hour candle back from price.
 * - Stop: at least one average 1-hour candle past the pullback level.
 * - Target: 2R, with a warning if an S/R level sits in the way.
 */
export function analyzeTrendPullbackV1(
  input: { instrument: MajorInstrument; candles: Candle[]; currentPrice?: number | null },
): TrendPullbackV1Result {
  const settings = TREND_PULLBACK_V1;
  const candles = input.candles.filter((candle) => candle.complete !== false);
  const last = candles.at(-1);
  const pip = pipSizeFor(input.instrument);
  const round = (value: number) => Number(value.toFixed(precisionFor(input.instrument)));
  const hasCurrentPrice = typeof input.currentPrice === "number" && Number.isFinite(input.currentPrice) && input.currentPrice > 0;
  const currentPrice = hasCurrentPrice ? input.currentPrice! : last?.close ?? 0;
  const trendRead = deriveDominantSwingTrend(candles);
  const slope = trendRead ? (trendRead.second.price - trendRead.first.price) / (trendRead.second.index - trendRead.first.index) : null;
  const projectedTrendlinePrice = trendRead && slope !== null
    ? round(trendRead.second.price + slope * (trendRead.last.index - trendRead.second.index))
    : null;
  const h1Atr = calculateAtr(hourlyFromM15(candles), 14).at(-1) ?? null;
  const result: TrendPullbackV1Result = {
    strategy: "TrendPullbackV1", version: "loose-v1", status: "NO_VALID_ENTRY", trend: "MIXED", majorTrend: "MIXED", currentTrend: "MIXED",
    trendSource: "SWING_STRUCTURE", currentMove: "NONE", action: null, orderType: null, currentPrice: round(currentPrice),
    priceBasis: hasCurrentPrice ? "LIVE_QUOTE" : "LAST_M15_CLOSE",
    entry: null, entryZoneLow: null, entryZoneHigh: null, distanceToEntryPips: null,
    stopLoss: null, stopDistancePips: null, takeProfit: null, targetDistancePips: null,
    riskReward: null, reasons: [], warnings: [],
    debug: {
      trendSource: "LEGACY_SWING_TREND_LINES", pointA: trendRead?.first ?? null, pointB: trendRead?.second ?? null,
      projectedTrendlinePrice, pullbackLevel: null, pullbackLevelKind: null, invalidationLevel: null, targetLevel: null,
      h1AtrPips: h1Atr === null ? null : Number((h1Atr / pip).toFixed(1)),
    },
  };
  // The only refusal left: there is not enough data to read anything at all.
  if (candles.length < 110 || !last || h1Atr === null || !(h1Atr > 0)) {
    result.reasons.push("Not enough completed M15 candles to build a plan yet.");
    return result;
  }

  // 1. Trend — always pick a side.
  let trend: "BULLISH" | "BEARISH";
  if (trendRead) {
    trend = trendRead.direction === "bullish" ? "BULLISH" : "BEARISH";
    const broken = trend === "BULLISH" ? last.close < projectedTrendlinePrice! : last.close > projectedTrendlinePrice!;
    if (broken) result.warnings.push("Price has closed through the swing trendline, so this trend may be turning.");
  } else {
    const dayAgo = candles.at(-97)!.close;
    trend = last.close >= dayAgo ? "BULLISH" : "BEARISH";
    result.trendSource = "PRICE_CHANGE_24H";
    result.warnings.push(`Swing highs and lows disagree, so the trend comes from the last 24h (${last.close >= dayAgo ? "up" : "down"} ${(Math.abs(last.close - dayAgo) / pip).toFixed(1)} pips).`);
  }
  const long = trend === "BULLISH";
  const sign = long ? 1 : -1;
  result.trend = result.majorTrend = result.currentTrend = trend;

  const recent = candles.slice(-4);
  const changes = recent.slice(1).map((candle, index) => candle.close - recent[index]!.close);
  const activePullback = changes.filter((change) => long ? change < 0 : change > 0).length >= 2
    && (long ? last.close < recent[0]!.close : last.close > recent[0]!.close);
  result.currentMove = activePullback ? long ? "BEARISH_PULLBACK" : "BULLISH_PULLBACK" : "NONE";

  // 2. Pullback level — nearest S/R on the trend side of price, else an ATR pullback.
  const tolerance = settings.entryBufferPips * pip;
  const levels = computeSupportResistanceLevels(candles, input.instrument);
  const candidates: Array<{ price: number; kind: PullbackLevelKind }> = [];
  if (levels) {
    if (long) {
      if (levels.swingLow !== null) candidates.push({ price: levels.swingLow, kind: "SWING_SUPPORT" });
      candidates.push({ price: levels.rangeLow, kind: "RANGE_SUPPORT" });
    } else {
      if (levels.swingHigh !== null) candidates.push({ price: levels.swingHigh, kind: "SWING_RESISTANCE" });
      candidates.push({ price: levels.rangeHigh, kind: "RANGE_RESISTANCE" });
    }
  }
  const pullback = candidates
    .filter((level) => long ? level.price <= currentPrice + tolerance : level.price >= currentPrice - tolerance)
    .sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice))[0]
    ?? { price: currentPrice - sign * settings.fallbackPullbackH1Atr * h1Atr, kind: "ATR_PULLBACK" as const };
  if (pullback.kind === "ATR_PULLBACK") {
    result.warnings.push(`No ${long ? "support below" : "resistance above"} price, so the pullback is half an average 1-hour candle ${long ? "below" : "above"} price.`);
  }

  // 3. Stop past the pullback level, 4. fixed 2R target.
  const entry = round(pullback.price);
  const risk = Math.max(settings.stopH1AtrMultiplier * h1Atr, settings.minStopPips * pip);
  const stop = round(entry - sign * risk);
  const target = round(entry + sign * settings.rewardRisk * risk);
  const opposing = levels
    ? (long ? [levels.swingHigh, levels.rangeHigh] : [levels.swingLow, levels.rangeLow])
      .filter((price): price is number => price !== null && (long ? price > entry && price < target : price < entry && price > target))
      .sort((a, b) => Math.abs(a - entry) - Math.abs(b - entry))
    : [];
  if (opposing.length) {
    result.warnings.push(`${long ? "Resistance" : "Support"} at ${round(opposing[0]!)} sits before the target, so price may stall there.`);
  }

  const inZone = Math.abs(currentPrice - entry) <= tolerance;
  result.status = inZone && hasCurrentPrice ? "ENTRY_AVAILABLE_NOW" : "TRADE_PLAN";
  result.action = long ? "LONG" : "SHORT";
  result.orderType = !hasCurrentPrice || inZone ? null : long ? "BUY_LIMIT" : "SELL_LIMIT";
  result.entry = entry;
  result.entryZoneLow = round(entry - tolerance);
  result.entryZoneHigh = round(entry + tolerance);
  result.distanceToEntryPips = Number((Math.abs(currentPrice - entry) / pip).toFixed(1));
  result.stopLoss = stop;
  result.stopDistancePips = Number((risk / pip).toFixed(1));
  result.takeProfit = target;
  result.targetDistancePips = Number((settings.rewardRisk * risk / pip).toFixed(1));
  result.riskReward = settings.rewardRisk;
  result.debug.pullbackLevel = entry;
  result.debug.pullbackLevelKind = pullback.kind;
  result.debug.invalidationLevel = stop;
  result.debug.targetLevel = opposing[0] ?? null;
  const levelLabel: Record<PullbackLevelKind, string> = {
    SWING_SUPPORT: "swing support", RANGE_SUPPORT: "range support", SWING_RESISTANCE: "swing resistance",
    RANGE_RESISTANCE: "range resistance", ATR_PULLBACK: "an ATR pullback",
  };
  result.reasons = [
    `Trend: ${long ? "up" : "down"} (${result.trendSource === "SWING_STRUCTURE" ? "swing trend line" : "last 24h of price"}).`,
    `Pullback entry at ${levelLabel[pullback.kind]} ${entry}.`,
    `Stop ${result.stopDistancePips} pips past it (one average 1-hour candle, minimum ${settings.minStopPips}); target ${settings.rewardRisk}:1.`,
  ];
  return result;
}

/**
 * The frozen record saved with an order placed from this plan (the backend
 * keeps it as `frozenContext`), so forward-test trades can be scored later.
 */
export function trendPullbackContext(result: TrendPullbackV1Result) {
  return {
    version: 1,
    direction: result.action === "LONG" ? "long" : "short",
    setup: "trend-pullback-loose-v1",
    frozen: {
      trend: result.trend,
      trendSource: result.trendSource,
      currentMove: result.currentMove,
      pullbackLevelKind: result.debug.pullbackLevelKind,
      h1AtrPips: result.debug.h1AtrPips,
      planned: { entry: result.entry, stop: result.stopLoss, target: result.takeProfit, currentPrice: result.currentPrice, status: result.status },
      warnings: result.warnings,
    },
  };
}

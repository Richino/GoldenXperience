import { calculateAtr, calculateEma, deriveDominantSwingTrend, type SwingTrendAnchor } from "@/lib/chart-utils";
import { pipSizeFor, precisionFor } from "@/lib/instruments/catalog";
import { computeSupportResistanceLevels } from "@/lib/strategy/support-resistance";
import type { EconomicCalendarEvent } from "@/lib/oanda/calendar";
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
  /** Against the 1H/4H trend: take profit at 1:1 instead of 2:1. */
  counterTrendRewardRisk: 1,
  /** Against the 1H/4H trend, look for a tested level at most this far past the normal pullback. */
  counterTrendSearchH1Atr: 1,
  /** A level must have held at least this many swing touches to count as strong. */
  counterTrendMinTouches: 2,
  counterTrendPivotReach: 3,
  counterTrendLookback: 200,
  /** Warn when the spread is more than this share of the stop. */
  maxSpreadShareOfRisk: 0.1,
  /** Structure stop: swing extremes from the last day (96 M15 candles)... */
  structureLookback: 96,
  structurePivotReach: 3,
  /** ...no further than this from the entry, so one old spike does not set it. */
  structureMaxH1Atr: 2,
  /** Buffer past the swing, on top of the spread (never less than entryBufferPips). */
  structureBufferH1Atr: 0.15,
  /** Warn about news for either currency due within this many hours... */
  newsLookaheadHours: 4,
  /** ...and hold the order until after any due within this many hours... */
  newsDelayHours: 2,
  /** ...or released this recently, while the spike may still be running. */
  newsJustReleasedMinutes: 15,
  /** The held order starts watching this long after the last release. */
  newsSettleMinutes: 15,
  /** ForexFactory impact 3 = high ("red folder"). */
  newsMinImpact: 3,
} as const;

type NewsEvent = Pick<EconomicCalendarEvent, "title" | "currency" | "impact" | "timestamp">;

/**
 * High-impact news for either currency in the pair inside the lookahead (or
 * only just released). News candles routinely run past a one-hour-ATR stop;
 * that is how the Sep 30 EUR/USD short was stopped. News due within
 * `newsDelayHours` also holds the order until after the last such release.
 */
function newsCheck(instrument: MajorInstrument, events: NewsEvent[], now: number, stopPips: number) {
  const settings = TREND_PULLBACK_V1;
  const [base, quote] = instrument.split("_");
  const due = events
    .filter((event) => event.impact >= settings.newsMinImpact && (event.currency === base || event.currency === quote))
    .map((event) => ({ ...event, at: Date.parse(event.timestamp) }))
    .filter((event) => Number.isFinite(event.at)
      && event.at >= now - settings.newsJustReleasedMinutes * 60_000
      && event.at <= now + settings.newsLookaheadHours * 3_600_000)
    .sort((a, b) => a.at - b.at);
  const first = due[0];
  if (!first) return null;
  const sameTime = due.filter((event) => event.at === first.at);
  const later = due.length - sameTime.length;
  const titles = sameTime.slice(0, 3).map((event) => event.title).join(", ");
  const minutes = Math.round((first.at - now) / 60_000);
  const when = minutes <= 0
    ? "just released"
    : `in ${minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`}`;
  const more = later ? `, plus ${later} more in the next ${settings.newsLookaheadHours}h` : "";
  const held = due.filter((event) => event.at <= now + settings.newsDelayHours * 3_600_000);
  const lastHeld = held.at(-1);
  if (!lastHeld) {
    return {
      warning: `High-impact ${first.currency} news ${when} (${titles}${more}): a news candle can run past a ${stopPips}-pip stop. Consider closing before it.`,
      activateAfter: null,
    };
  }
  const activateAfter = new Date(lastHeld.at + settings.newsSettleMinutes * 60_000).toISOString();
  return {
    warning: `High-impact ${first.currency} news ${when} (${titles}${more}), so the order waits until ${settings.newsSettleMinutes} minutes after it before it can fill.`,
    activateAfter,
  };
}

/**
 * Higher-timeframe bias from the 50 and 200 EMAs: up when the 50 is above the
 * 200 and price is above the 50, down for the mirror, otherwise mixed.
 */
function emaBias(candles: Candle[] | undefined): Direction | null {
  const closes = (candles ?? []).filter((candle) => candle.complete !== false).map((candle) => candle.close);
  if (closes.length < 200) return null;
  const ema50 = calculateEma(closes, 50).at(-1);
  const ema200 = calculateEma(closes, 200).at(-1);
  const close = closes.at(-1)!;
  if (ema50 == null || ema200 == null) return null;
  if (ema50 > ema200 && close > ema50) return "BULLISH";
  if (ema50 < ema200 && close < ema50) return "BEARISH";
  return "MIXED";
}

/**
 * The most-tested swing level between `near` and `far` (prices on the pullback
 * side of price): swing lows for a long, swing highs for a short, grouped when
 * they sit within `tolerance`. A level only counts while no M15 candle has
 * closed through it since its first touch.
 */
function strongestHeldLevel(candles: Candle[], long: boolean, near: number, far: number, tolerance: number, reach: number, minTouches: number) {
  const pivots: Array<{ index: number; price: number }> = [];
  for (let index = reach; index < candles.length - reach; index += 1) {
    const price = long ? candles[index]!.low : candles[index]!.high;
    const window = candles.slice(index - reach, index + reach + 1);
    const isPivot = long ? window.every((other) => other.low >= price) : window.every((other) => other.high <= price);
    const inWindow = long ? price <= near && price >= far : price >= near && price <= far;
    if (isPivot && inWindow) pivots.push({ index, price });
  }
  const clusters: Array<{ touches: typeof pivots }> = [];
  for (const pivot of pivots.sort((a, b) => a.price - b.price)) {
    const cluster = clusters.find((group) => Math.abs(group.touches[0]!.price - pivot.price) <= tolerance);
    if (cluster) cluster.touches.push(pivot);
    else clusters.push({ touches: [pivot] });
  }
  return clusters
    .map((cluster) => {
      const prices = cluster.touches.map((touch) => touch.price);
      // Entry at the side price reaches first; the stop goes past the far side.
      const edge = long ? Math.max(...prices) : Math.min(...prices);
      const extreme = long ? Math.min(...prices) : Math.max(...prices);
      const firstTouch = Math.min(...cluster.touches.map((touch) => touch.index));
      const held = candles.slice(firstTouch).every((candle) => long ? candle.close >= extreme - tolerance : candle.close <= extreme + tolerance);
      return { touches: cluster.touches.length, edge, extreme, held };
    })
    .filter((cluster) => cluster.held && cluster.touches >= minTouches)
    .sort((a, b) => b.touches - a.touches || Math.abs(a.edge - near) - Math.abs(b.edge - near))[0] ?? null;
}

/**
 * The swing a structure stop has to clear: the highest swing high (short) or
 * lowest swing low (long) past the entry within `maxDistance`, including the
 * last few candles, which cannot be confirmed pivots yet but are real wicks.
 */
function structureAnchor(candles: Candle[], long: boolean, entry: number, maxDistance: number, reach: number) {
  const extremes: number[] = [];
  for (let index = reach; index < candles.length; index += 1) {
    const price = long ? candles[index]!.low : candles[index]!.high;
    const window = candles.slice(index - reach, Math.min(candles.length, index + reach + 1));
    const isPivot = long ? window.every((other) => other.low >= price) : window.every((other) => other.high <= price);
    if (isPivot) extremes.push(price);
  }
  const beyond = extremes.filter((price) => long ? price < entry && entry - price <= maxDistance : price > entry && price - entry <= maxDistance);
  if (!beyond.length) return null;
  return long ? Math.min(...beyond) : Math.max(...beyond);
}

export type StructureStop =
  | { available: false; note: string }
  | {
    available: true;
    /** The swing high/low the stop sits past. */
    anchor: number;
    stop: number;
    stopDistancePips: number;
    takeProfit: number;
    targetDistancePips: number;
    /** Spread as a share of this stop, when the spread is known. */
    spreadSharePct: number | null;
    /** Support/resistance between entry and this target, if any. */
    opposingLevel: number | null;
  };

type Direction = "BULLISH" | "BEARISH" | "MIXED";
type PullbackLevelKind = "SWING_SUPPORT" | "RANGE_SUPPORT" | "SWING_RESISTANCE" | "RANGE_RESISTANCE" | "ATR_PULLBACK" | "TESTED_SUPPORT" | "TESTED_RESISTANCE";

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
  /** 1H/4H EMA bias; null when those candles were not supplied. */
  higherTimeframe: { h1: Direction | null; h4: Direction | null };
  /** The plan goes against the 1H/4H trend, so it uses a tested level and a 1:1 target. */
  counterTrend: boolean;
  /** Alternative stop past the day's swing beyond the level, same R:R; null until a plan exists. */
  structureStop: StructureStop | null;
  /** The stop the plan recommends: the structure stop whenever one is available. */
  recommendedStop: "normal" | "structure";
  /** Hold the order until this time (ISO) because high-impact news is due; null to place it now. */
  activateAfter: string | null;
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
    /** Far side of a tested zone (the level itself for a single-price level). */
    levelExtreme: number | null;
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
  input: {
    instrument: MajorInstrument;
    candles: Candle[];
    currentPrice?: number | null;
    /** H1/H4 candles for the higher-timeframe trend; without them the plan is never treated as counter-trend. */
    h1Candles?: Candle[];
    h4Candles?: Candle[];
    spreadPips?: number | null;
    /** Economic calendar events; without them there is no news warning. */
    newsEvents?: NewsEvent[];
    /** The moment the plan is for, in ms; defaults to now. */
    now?: number;
  },
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
    riskReward: null, higherTimeframe: { h1: emaBias(input.h1Candles), h4: emaBias(input.h4Candles) }, counterTrend: false, structureStop: null,
    recommendedStop: "normal", activateAfter: null,
    reasons: [], warnings: [],
    debug: {
      trendSource: "LEGACY_SWING_TREND_LINES", pointA: trendRead?.first ?? null, pointB: trendRead?.second ?? null,
      projectedTrendlinePrice, pullbackLevel: null, pullbackLevelKind: null, levelExtreme: null, invalidationLevel: null, targetLevel: null,
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
  let pullback: { price: number; kind: PullbackLevelKind } = candidates
    .filter((level) => long ? level.price <= currentPrice + tolerance : level.price >= currentPrice - tolerance)
    .sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice))[0]
    ?? { price: currentPrice - sign * settings.fallbackPullbackH1Atr * h1Atr, kind: "ATR_PULLBACK" as const };
  if (pullback.kind === "ATR_PULLBACK") {
    result.warnings.push(`No ${long ? "support below" : "resistance above"} price, so the pullback is half an average 1-hour candle ${long ? "below" : "above"} price.`);
  }

  // Counter-trend: the 1H/4H trend points the other way (at least one against,
  // none agreeing). Look for the most-tested level that has held, from the
  // normal pullback out to one average 1-hour candle past it, and aim 1:1.
  const htf = [result.higherTimeframe.h1, result.higherTimeframe.h4].filter((bias): bias is Direction => bias !== null);
  const opposite = long ? "BEARISH" : "BULLISH";
  result.counterTrend = htf.some((bias) => bias === opposite) && !htf.some((bias) => bias === trend);
  let extremeOfLevel: number | null = null;
  if (result.counterTrend) {
    const near = long ? Math.min(pullback.price, currentPrice) : Math.max(pullback.price, currentPrice);
    const far = near - sign * settings.counterTrendSearchH1Atr * h1Atr;
    const clusterTolerance = Math.max(3 * pip, 0.15 * h1Atr);
    const strong = strongestHeldLevel(
      candles.slice(-settings.counterTrendLookback), long, near, far, clusterTolerance,
      settings.counterTrendPivotReach, settings.counterTrendMinTouches,
    );
    if (strong) {
      pullback = { price: strong.edge, kind: long ? "TESTED_SUPPORT" : "TESTED_RESISTANCE" };
      extremeOfLevel = strong.extreme;
      result.reasons.push(`${long ? "Support" : "Resistance"} tested ${strong.touches} times and held.`);
    } else {
      result.warnings.push(`No tested ${long ? "support" : "resistance"} within one average 1-hour candle of the pullback, so the normal level is used.`);
    }
  }

  // No pullback under way and price already at the level: filling now enters
  // mid-move (0 of 3 such plans won, Sep 27-30). Wait half an average 1-hour
  // candle back instead, so the order only fills on a pullback.
  const waitsForPullback = hasCurrentPrice && result.currentMove === "NONE" && Math.abs(currentPrice - pullback.price) <= tolerance;
  if (waitsForPullback) {
    pullback = { price: currentPrice - sign * settings.fallbackPullbackH1Atr * h1Atr, kind: "ATR_PULLBACK" };
    extremeOfLevel = null;
  }

  // 3. Stop past the pullback level (and past the whole tested zone), 4. fixed target.
  const rewardRisk = result.counterTrend ? settings.counterTrendRewardRisk : settings.rewardRisk;
  const entry = round(pullback.price);
  const zoneDepth = extremeOfLevel === null ? 0 : Math.abs(entry - extremeOfLevel);
  const risk = Math.max(settings.stopH1AtrMultiplier * h1Atr + zoneDepth, settings.minStopPips * pip);
  const stop = round(entry - sign * risk);
  const target = round(entry + sign * rewardRisk * risk);
  const spreadPips = input.spreadPips ?? null;
  if (spreadPips !== null && spreadPips > settings.maxSpreadShareOfRisk * (risk / pip)) {
    result.warnings.push(`Spread is ${spreadPips.toFixed(1)} pips, ${Math.round(spreadPips / (risk / pip) * 100)}% of the stop; above 10% the cost eats ${rewardRisk === 1 ? "a 1:1 target" : "the target"} quickly.`);
  }
  const opposing = levels
    ? (long ? [levels.swingHigh, levels.rangeHigh] : [levels.swingLow, levels.rangeLow])
      .filter((price): price is number => price !== null && (long ? price > entry && price < target : price < entry && price > target))
      .sort((a, b) => Math.abs(a - entry) - Math.abs(b - entry))
    : [];
  if (opposing.length) {
    result.warnings.push(`${long ? "Resistance" : "Support"} at ${round(opposing[0]!)} sits before the target, so price may stall there.`);
  }

  // Structure stop: past the most extreme swing beyond the level from the last
  // day (within two average 1-hour candles), plus a buffer and the spread, so a
  // sweep of the obvious high/low does not reach it. Never tighter than the
  // normal stop; the target keeps the same R:R from the wider stop.
  const anchor = structureAnchor(candles.slice(-settings.structureLookback), long, entry, settings.structureMaxH1Atr * h1Atr, settings.structurePivotReach);
  const structureBuffer = Math.max(settings.entryBufferPips * pip, settings.structureBufferH1Atr * h1Atr) + (spreadPips ?? 0) * pip;
  const structureRisk = anchor === null ? null : Math.abs(entry - anchor) + structureBuffer;
  if (structureRisk === null) {
    result.structureStop = { available: false, note: `No swing ${long ? "low below" : "high above"} the entry within two average 1-hour candles in the last day.` };
  } else if (structureRisk <= risk + pip) {
    result.structureStop = { available: false, note: "The normal stop is already past the nearest swing." };
  } else {
    const structureTarget = round(entry + sign * rewardRisk * structureRisk);
    const structureOpposing = levels
      ? (long ? [levels.swingHigh, levels.rangeHigh] : [levels.swingLow, levels.rangeLow])
        .filter((price): price is number => price !== null && (long ? price > entry && price < structureTarget : price < entry && price > structureTarget))
        .sort((a, b) => Math.abs(a - entry) - Math.abs(b - entry))
      : [];
    result.structureStop = {
      available: true,
      anchor: round(anchor!),
      stop: round(entry - sign * structureRisk),
      stopDistancePips: Number((structureRisk / pip).toFixed(1)),
      takeProfit: structureTarget,
      targetDistancePips: Number((rewardRisk * structureRisk / pip).toFixed(1)),
      spreadSharePct: spreadPips === null ? null : Math.round(spreadPips / (structureRisk / pip) * 100),
      opposingLevel: structureOpposing[0] === undefined ? null : round(structureOpposing[0]),
    };
    // One-hour-ATR stops sat inside normal noise: 4 of 6 stopped trades
    // (Sep 27-30) went on to reach the target. The swing stop is the default.
    result.recommendedStop = "structure";
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
  result.targetDistancePips = Number((rewardRisk * risk / pip).toFixed(1));
  result.riskReward = rewardRisk;
  result.debug.pullbackLevel = entry;
  result.debug.pullbackLevelKind = pullback.kind;
  result.debug.levelExtreme = extremeOfLevel === null ? entry : round(extremeOfLevel);
  result.debug.invalidationLevel = stop;
  result.debug.targetLevel = opposing[0] ?? null;
  const levelLabel: Record<PullbackLevelKind, string> = {
    SWING_SUPPORT: "swing support", RANGE_SUPPORT: "range support", SWING_RESISTANCE: "swing resistance",
    RANGE_RESISTANCE: "range resistance", ATR_PULLBACK: "an ATR pullback",
    TESTED_SUPPORT: "tested support", TESTED_RESISTANCE: "tested resistance",
  };
  const htfLabel = (bias: Direction | null) => bias === null ? "n/a" : bias === "BULLISH" ? "up" : bias === "BEARISH" ? "down" : "mixed";
  result.reasons = [
    `Trend: ${long ? "up" : "down"} (${result.trendSource === "SWING_STRUCTURE" ? "swing trend line" : "last 24h of price"}).`,
    ...(result.counterTrend ? [`Against the higher timeframes (1H ${htfLabel(result.higherTimeframe.h1)}, 4H ${htfLabel(result.higherTimeframe.h4)}), so the target is 1:1.`] : []),
    ...result.reasons,
    ...(waitsForPullback ? ["No pullback yet, so the entry waits half an average 1-hour candle back instead of filling mid-move."] : []),
    `Pullback entry at ${levelLabel[pullback.kind]} ${entry}.`,
    `Stop ${result.stopDistancePips} pips past it (one average 1-hour candle${zoneDepth > 0 ? " beyond the zone" : ""}, minimum ${settings.minStopPips}); target ${rewardRisk}:1.`,
  ];

  // News goes first: holding a tight stop into a release lost the Sep 30 EUR/USD short.
  const news = input.newsEvents?.length
    ? newsCheck(input.instrument, input.newsEvents, input.now ?? Date.now(), result.stopDistancePips!)
    : null;
  if (news) {
    result.warnings.unshift(news.warning);
    result.activateAfter = news.activateAfter;
  }
  return result;
}

/**
 * The frozen record saved with an order placed from this plan (the backend
 * keeps it as `frozenContext`), so forward-test trades can be scored later.
 */
export function trendPullbackContext(result: TrendPullbackV1Result, stopChoice: "normal" | "structure" = "normal") {
  const structure = stopChoice === "structure" && result.structureStop?.available ? result.structureStop : null;
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
      higherTimeframe: result.higherTimeframe,
      counterTrend: result.counterTrend,
      planned: { entry: result.entry, stop: structure?.stop ?? result.stopLoss, target: structure?.takeProfit ?? result.takeProfit, currentPrice: result.currentPrice, status: result.status },
      stopChoice: structure ? "structure" : "normal",
      normalStop: { stop: result.stopLoss, target: result.takeProfit },
      structureStop: result.structureStop,
      activateAfter: result.activateAfter,
      warnings: result.warnings,
    },
  };
}

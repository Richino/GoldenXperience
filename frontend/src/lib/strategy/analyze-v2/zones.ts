import type { Swing } from "@/lib/strategy/market-regime";
import type { ModeConfig } from "@/lib/strategy/analyze-v2/config";
import type { TrendRead } from "@/lib/strategy/analyze-v2/structure";
import type { Candle } from "@/types/forex";

/**
 * Support/resistance zones from confirmed swing reactions.
 *
 * - Built only from meaningful confirmed swings (legs of at least
 *   `minLegAtr`; no future candles) on the primary and the higher timeframe,
 *   so small wiggles do not crowd the chart with zones.
 * - Nearby pivots merge into one zone while it stays narrower than
 *   `maxWidthAtr`; a lone pivot is padded to `minWidthAtr`.
 * - The reaction count is reported, never used as strength: repeated tests
 *   can weaken a level as easily as confirm it.
 * - Type comes from where price is now: below price is SUPPORT, above is
 *   RESISTANCE, price inside the zone is MIXED.
 * - A zone is BROKEN once a closed candle has closed beyond it, by
 *   `breakCloseAtr`, on the far side from where price was at its last
 *   reaction. A broken zone price has left its original side of (or sits
 *   inside) is `flipped`: old resistance below price, old support above.
 *   A broken zone price has gone back through is stale and left out.
 * - Relevance: STRUCTURAL when it holds the trend's defining swing or the
 *   latest swing high/low, HIGHER_TF when the higher timeframe built it,
 *   otherwise MINOR.
 */

export type ZoneType = "SUPPORT" | "RESISTANCE" | "MIXED";
export type ZoneStatus = "ACTIVE" | "BROKEN";
export type ZoneRelevance = "STRUCTURAL" | "HIGHER_TF" | "MINOR";

export interface SrZone {
  low: number;
  high: number;
  type: ZoneType;
  status: ZoneStatus;
  /** Broken and now on the other side of price (role reversal candidate). */
  flipped: boolean;
  relevance: ZoneRelevance;
  /** Timeframes whose pivots built the zone. */
  sources: string[];
  /** When its first pivot became knowable. */
  createdAt: string;
  /** When its latest pivot became knowable. */
  lastReactionAt: string;
  /** Pivot reactions inside the zone (reported, not a strength score). */
  reactions: number;
  /** Swing highs and lows among those reactions. */
  highs: number;
  lows: number;
  /** Distance from the reference price to the nearest edge, in primary ATRs (0 inside). */
  distanceAtr: number;
}

interface Cluster {
  pivots: Array<Swing & { timeframe: string }>;
  low: number;
  high: number;
}

function cluster(pivots: Array<Swing & { timeframe: string }>, mergeDistance: number, maxWidth: number): Cluster[] {
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const groups: Cluster[] = [];
  for (const pivot of sorted) {
    const group = groups.at(-1);
    const mean = group ? group.pivots.reduce((sum, item) => sum + item.price, 0) / group.pivots.length : 0;
    if (group && Math.abs(pivot.price - mean) <= mergeDistance && pivot.price - group.low <= maxWidth) {
      group.pivots.push(pivot);
      group.high = Math.max(group.high, pivot.price);
    } else {
      groups.push({ pivots: [pivot], low: pivot.price, high: pivot.price });
    }
  }
  return groups;
}

export interface ZoneInput {
  primary: { timeframe: string; candles: Candle[] };
  higher?: { timeframe: string; candles: Candle[]; trend: TrendRead | null } | null;
  trend: TrendRead;
  /** Reference price (live mid, else the last close). */
  price: number;
  config: ModeConfig;
}

export function buildZones({ primary, higher, trend, price, config }: ZoneInput): SrZone[] {
  const atr = trend.atr;
  if (!(atr > 0)) return [];
  const settings = config.zones;
  const closedPrimary = primary.candles.filter((candle) => candle.complete !== false).slice(-config.regime.lookback);
  const pivots = [
    ...trend.raw.swings.map((pivot) => ({ ...pivot, timeframe: primary.timeframe })),
    ...(higher?.trend ? higher.trend.raw.swings.map((pivot) => ({ ...pivot, timeframe: higher.timeframe })) : []),
  ];
  const structural = [trend.structureLevel, trend.lastSwingHigh?.price, trend.lastSwingLow?.price]
    .filter((value): value is number => typeof value === "number");

  const zones: SrZone[] = [];
  for (const group of cluster(pivots, settings.mergeAtr * atr, settings.maxWidthAtr * atr)) {
    let low = group.low;
    let high = group.high;
    const minWidth = settings.minWidthAtr * atr;
    if (high - low < minWidth) {
      const mid = (low + high) / 2;
      low = mid - minWidth / 2;
      high = mid + minWidth / 2;
    }
    const confirmed = group.pivots.map((pivot) => pivot.confirmedAt).sort();
    const lastReactionAt = confirmed.at(-1)!;
    const lastPivot = [...group.pivots].sort((a, b) => a.confirmedAt.localeCompare(b.confirmedAt)).at(-1)!;
    // Price sat above the zone after a swing low reacted there, below it after a swing high.
    const wasAbove = lastPivot.type === "low";
    const breakDistance = settings.breakCloseAtr * atr;
    const broken = closedPrimary.some((candle) => candle.time >= lastReactionAt
      && (wasAbove ? candle.close < low - breakDistance : candle.close > high + breakDistance));
    const inside = price >= low && price <= high;
    const type: ZoneType = inside ? "MIXED" : price > high ? "SUPPORT" : "RESISTANCE";
    // Broken and price no longer on its original side (inside counts).
    const flipped = broken && (wasAbove ? price < high : price > low);
    const sources = [...new Set(group.pivots.map((pivot) => pivot.timeframe))];
    const relevance: ZoneRelevance = structural.some((level) => level >= low - 0.1 * atr && level <= high + 0.1 * atr)
      ? "STRUCTURAL"
      : higher && sources.includes(higher.timeframe) ? "HIGHER_TF" : "MINOR";
    const distanceAtr = inside ? 0 : (price > high ? price - high : low - price) / atr;
    if (distanceAtr > settings.maxDistanceAtr && relevance !== "STRUCTURAL") continue;
    if (broken && !flipped) continue;
    zones.push({
      low,
      high,
      type,
      status: broken ? "BROKEN" : "ACTIVE",
      flipped,
      relevance,
      sources,
      createdAt: confirmed[0]!,
      lastReactionAt,
      reactions: group.pivots.length,
      highs: group.pivots.filter((pivot) => pivot.type === "high").length,
      lows: group.pivots.filter((pivot) => pivot.type === "low").length,
      distanceAtr,
    });
  }
  return zones.sort((a, b) => a.low - b.low);
}

/**
 * Zones a pullback can lean on: active, or broken and flipped to the side
 * now facing price (old resistance below price for a long). Ordered nearest
 * to price first.
 */
export function zonesOnSide(zones: SrZone[], side: "below" | "above") {
  return zones
    .filter((zone) => zone.status === "ACTIVE" || zone.flipped)
    .filter((zone) => (side === "below" ? zone.type !== "RESISTANCE" : zone.type !== "SUPPORT"))
    .sort((a, b) => (side === "below" ? b.high - a.high : a.low - b.low));
}

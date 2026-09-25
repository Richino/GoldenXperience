import { analyzeAdaptiveSwingTrendlines, type AdaptiveSwingTrendlineRead } from "@/lib/adaptive-swing-trendlines";
import { pipSizeFor, precisionFor } from "@/lib/instruments/catalog";
import type { Candle, MajorInstrument } from "@/types/forex";

/** Research settings, not fitted probabilities or execution rules. */
export const TREND_PULLBACK_V1 = {
  entryBufferPips: 2,
  invalidationBufferPips: 2,
  projectionBars: 4,
} as const;

type Direction = "BULLISH" | "BEARISH" | "MIXED";
type Swing = NonNullable<AdaptiveSwingTrendlineRead["current"]>["pointA"];

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
    currentLineId: string | null;
    pointA: Swing | null;
    pointB: Swing | null;
    lineSlope: number | null;
    currentLinePrice: number | null;
    projectedLine15m: number | null;
    projectedLine30m: number | null;
    projectedLine45m: number | null;
    projectedLine60m: number | null;
    projectedPrices: number[];
    selectedProjectionTime: string | null;
    slStructuralReference: number | null;
    tpStructuralReference: number | null;
    pullbackSpeedPerBar: number | null;
  };
};

/** Completed M15 candles only. The live quote is used solely for order geometry. */
export function analyzeTrendPullbackV1(
  input: { instrument: MajorInstrument; candles: Candle[]; currentPrice?: number | null },
  settings: { entryBufferPips: number; invalidationBufferPips: number } = TREND_PULLBACK_V1,
): TrendPullbackV1Result {
  const candles = input.candles.filter((candle) => candle.complete !== false);
  const last = candles.at(-1);
  const pip = pipSizeFor(input.instrument);
  const round = (value: number) => Number(value.toFixed(precisionFor(input.instrument)));
  const hasCurrentPrice = typeof input.currentPrice === "number" && Number.isFinite(input.currentPrice) && input.currentPrice > 0;
  const currentPrice = hasCurrentPrice ? input.currentPrice! : last?.close ?? 0;
  const read = analyzeAdaptiveSwingTrendlines(candles, input.instrument);
  const majorTrend: Direction = read.major?.status === "broken" ? "MIXED" : (read.majorDirection?.toUpperCase() as Direction | undefined) ?? "MIXED";
  const currentTrend: Direction = (read.currentDirection?.toUpperCase() as Direction | undefined) ?? "MIXED";
  // Prefer the current confirmed swing structure. A viable major line is the
  // fallback when the indicator has not formed a current line yet.
  const line = read.current ?? (read.major?.status !== "broken" ? read.major : null);
  const trend: Direction = line ? line.direction.toUpperCase() as Direction : "MIXED";
  const projected = line ? [1, 2, 3, 4].map((bars) => round(line.pointA.price + line.slopePerBar * (candles.length - 1 + bars - line.pointA.index))) : [];
  const currentLinePrice = line ? round(line.pointA.price + line.slopePerBar * (candles.length - 1 - line.pointA.index)) : null;
  const result: TrendPullbackV1Result = {
    strategy: "TrendPullbackV1", status: "NO_VALID_ENTRY", trend, majorTrend, currentTrend,
    currentMove: "NONE", action: null, orderType: null, currentPrice: round(currentPrice),
    priceBasis: hasCurrentPrice ? "LIVE_QUOTE" : "LAST_M15_CLOSE",
    entry: null, entryZoneLow: null, entryZoneHigh: null, distanceToEntryPips: null,
    stopLoss: null, stopDistancePips: null, takeProfit: null, targetDistancePips: null,
    riskReward: null, reasons: [],
    debug: { currentLineId: line?.id ?? null, pointA: line?.pointA ?? null, pointB: line?.pointB ?? null,
      lineSlope: line?.slopePerBar ?? null, currentLinePrice,
      projectedLine15m: projected[0] ?? null, projectedLine30m: projected[1] ?? null,
      projectedLine45m: projected[2] ?? null, projectedLine60m: projected[3] ?? null,
      projectedPrices: projected, selectedProjectionTime: null, slStructuralReference: null,
      tpStructuralReference: null, pullbackSpeedPerBar: null },
  };
  const reject = (reason: string) => { result.reasons.push(reason); return result; };
  if (candles.length < 24 || !last) return reject("Not enough completed M15 candles for a trendline analysis.");
  if (!line || line.status === "broken") return reject("No usable confirmed swing trendline is available yet.");
  const long = trend === "BULLISH";

  // Pullback activity changes which forward point is preferred, not whether
  // the user receives a planned entry.
  const recent = candles.slice(-4);
  const changes = recent.slice(1).map((candle, index) => candle.close - recent[index]!.close);
  const toward = changes.filter((change) => long ? change < 0 : change > 0);
  const activePullback = toward.length >= 2 && (long ? last.close < recent[0]!.close : last.close > recent[0]!.close);
  const speed = changes.reduce((sum, change) => sum + change, 0) / changes.length;
  result.debug.pullbackSpeedPerBar = speed;
  result.currentMove = activePullback ? long ? "BEARISH_PULLBACK" : "BULLISH_PULLBACK" : "NONE";
  // With an active pullback, choose the projected point nearest its observed
  // path. Otherwise choose the nearest forward line price to the live quote.
  const tolerance = settings.entryBufferPips * pip;
  const candidates = projected.map((price, index) => ({
    price, index,
    score: Math.abs((activePullback ? last.close + speed * (index + 1) : currentPrice) - price),
  }));
  const inZonePoint = candidates
    .filter(({ price }) => Math.abs(currentPrice - price) <= tolerance)
    .sort((a, b) => Math.abs(currentPrice - a.price) - Math.abs(currentPrice - b.price) || a.index - b.index)[0];
  const eligible = candidates.filter(({ price }) => long ? price < currentPrice : price > currentPrice);
  const selected = inZonePoint ?? (eligible.length ? eligible : candidates).sort((a, b) => a.score - b.score || a.index - b.index)[0]!;
  const lineReached = !inZonePoint && eligible.length === 0;
  const entry = lineReached ? round(currentPrice) : selected.price;
  const zoneLow = round(entry - tolerance);
  const zoneHigh = round(entry + tolerance);
  const inZone = lineReached || currentPrice >= zoneLow && currentPrice <= zoneHigh;

  const structuralReference = line.pointB.price;
  const stop = round(long ? structuralReference - settings.invalidationBufferPips * pip : structuralReference + settings.invalidationBufferPips * pip);
  const postAnchor = candles.slice(line.pointB.index);
  const extreme = long ? Math.max(...postAnchor.map((candle) => candle.high)) : Math.min(...postAnchor.map((candle) => candle.low));
  const target = round(long ? extreme - pip : extreme + pip);
  const risk = long ? entry - stop : stop - entry;
  const reward = long ? target - entry : entry - target;
  result.debug.slStructuralReference = structuralReference;
  result.debug.tpStructuralReference = extreme;
  if (risk <= pip || reward <= pip) {
    result.entry = entry;
    result.entryZoneLow = zoneLow;
    result.entryZoneHigh = zoneHigh;
    result.distanceToEntryPips = Number((Math.abs(currentPrice - entry) / pip).toFixed(1));
    result.debug.selectedProjectionTime = new Date(Date.parse(last.time) + (selected.index + 1) * 15 * 60_000).toISOString();
    return reject("The swing line gives an entry, but its structural stop or recent extreme does not support a trade plan yet.");
  }
  result.status = inZone && hasCurrentPrice ? "ENTRY_AVAILABLE_NOW" : "TRADE_PLAN";
  result.action = long ? "LONG" : "SHORT";
  result.orderType = !hasCurrentPrice || inZone ? null : long ? "BUY_LIMIT" : "SELL_LIMIT";
  result.entry = entry;
  result.entryZoneLow = zoneLow;
  result.entryZoneHigh = zoneHigh;
  result.distanceToEntryPips = Number((Math.abs(currentPrice - entry) / pip).toFixed(1));
  result.stopLoss = stop;
  result.stopDistancePips = Number((risk / pip).toFixed(1));
  result.takeProfit = target;
  result.targetDistancePips = Number((reward / pip).toFixed(1));
  result.riskReward = Number((reward / risk).toFixed(2));
  result.debug.selectedProjectionTime = new Date(Date.parse(last.time) + (selected.index + 1) * 15 * 60_000).toISOString();
  result.reasons = [
    `The ${line.type.toUpperCase()} confirmed swing line points ${trend.toLowerCase()}.`,
    lineReached ? "Price has reached or passed the projected line; the current quote is the available entry." : activePullback
      ? `The active pullback is closest to the ${15 * (selected.index + 1)} minute line projection.`
      : `No active pullback yet; the ${15 * (selected.index + 1)} minute line projection is the nearest planned entry.`,
    "Stop and target use the confirmed swing structure and recent trend extreme.",
  ];
  return result;
}

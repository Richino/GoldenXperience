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
  const line = read.current;
  const trend: Direction = majorTrend === currentTrend ? majorTrend : "MIXED";
  const projected = line ? [1, 2, 3, 4].map((bars) => round(line.pointA.price + line.slopePerBar * (candles.length - 1 + bars - line.pointA.index))) : [];
  const currentLinePrice = line ? round(line.pointA.price + line.slopePerBar * (candles.length - 1 - line.pointA.index)) : null;
  const result: TrendPullbackV1Result = {
    strategy: "TrendPullbackV1", status: "NO_VALID_ENTRY", trend, majorTrend, currentTrend,
    currentMove: "NONE", action: null, orderType: null, currentPrice: round(currentPrice),
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
  if (!hasCurrentPrice) return reject("A valid current market price is unavailable.");
  if (!line || line.status === "broken") return reject("Adaptive Swing Trendlines V1 has no valid CURRENT line.");
  if (trend === "MIXED") return reject(`MAJOR ${majorTrend} and CURRENT ${currentTrend} do not agree.`);
  const long = trend === "BULLISH";
  if (long ? line.slopePerBar <= 0 : line.slopePerBar >= 0) return reject("The CURRENT line slope does not match the trend.");
  if (currentLinePrice === null || (long ? currentPrice < currentLinePrice - settings.entryBufferPips * pip : currentPrice > currentLinePrice + settings.entryBufferPips * pip)) {
    return reject("Price is already beyond the CURRENT trendline; the structure may be invalid.");
  }

  // A completed-bar move toward the line is enough; no touch or reversal is required.
  const recent = candles.slice(-4);
  const changes = recent.slice(1).map((candle, index) => candle.close - recent[index]!.close);
  const toward = changes.filter((change) => long ? change < 0 : change > 0);
  if (toward.length < 2 || !(long ? last.close < recent[0]!.close : last.close > recent[0]!.close)) {
    return reject("The latest completed candles are not pulling back toward the CURRENT line.");
  }
  const speed = changes.reduce((sum, change) => sum + change, 0) / changes.length;
  result.debug.pullbackSpeedPerBar = speed;
  result.currentMove = long ? "BEARISH_PULLBACK" : "BULLISH_PULLBACK";
  // Select the first of four forward line points that intersects the observed
  // countertrend path within the configured buffer. This is a geometric plan,
  // not a predicted probability or a requirement to wait for a touch.
  const tolerance = settings.entryBufferPips * pip;
  const intersection = projected.findIndex((price, index) => {
    const estimatedPullbackPrice = last.close + speed * (index + 1);
    return long ? estimatedPullbackPrice <= price + tolerance : estimatedPullbackPrice >= price - tolerance;
  });
  if (intersection < 0) return reject("At the current pullback pace, the next four M15 projections do not intersect the CURRENT line.");
  const entry = projected[intersection]!;
  const zoneLow = round(entry - tolerance);
  const zoneHigh = round(entry + tolerance);
  const inZone = currentPrice >= zoneLow && currentPrice <= zoneHigh;
  if (!inZone && (long ? entry >= currentPrice : entry <= currentPrice)) {
    return reject("The projected limit entry is on the wrong side of the current market price.");
  }
  if (long ? currentPrice < zoneLow : currentPrice > zoneHigh) {
    return reject("Price has moved through the projected entry zone; do not chase it.");
  }

  const structuralReference = line.pointB.price;
  const stop = round(long ? structuralReference - settings.invalidationBufferPips * pip : structuralReference + settings.invalidationBufferPips * pip);
  const postAnchor = candles.slice(line.pointB.index);
  const extreme = long ? Math.max(...postAnchor.map((candle) => candle.high)) : Math.min(...postAnchor.map((candle) => candle.low));
  const target = round(long ? extreme - pip : extreme + pip);
  const risk = long ? entry - stop : stop - entry;
  const reward = long ? target - entry : entry - target;
  result.debug.slStructuralReference = structuralReference;
  result.debug.tpStructuralReference = extreme;
  if (risk <= pip || reward <= pip) return reject("The structural swing does not leave a valid stop and target around this entry.");
  result.status = inZone ? "ENTRY_AVAILABLE_NOW" : "TRADE_PLAN";
  result.action = long ? "LONG" : "SHORT";
  result.orderType = inZone ? null : long ? "BUY_LIMIT" : "SELL_LIMIT";
  result.entry = entry;
  result.entryZoneLow = zoneLow;
  result.entryZoneHigh = zoneHigh;
  result.distanceToEntryPips = Number((Math.abs(currentPrice - entry) / pip).toFixed(1));
  result.stopLoss = stop;
  result.stopDistancePips = Number((risk / pip).toFixed(1));
  result.takeProfit = target;
  result.targetDistancePips = Number((reward / pip).toFixed(1));
  result.riskReward = Number((reward / risk).toFixed(2));
  result.debug.selectedProjectionTime = new Date(Date.parse(last.time) + (intersection + 1) * 15 * 60_000).toISOString();
  result.reasons = [
    `MAJOR and CURRENT Adaptive Swing Trendlines V1 are ${trend.toLowerCase()}.`,
    `The latest completed M15 candles are pulling ${long ? "down" : "up"} toward the CURRENT line.`,
    `The ${15 * (intersection + 1)} minute line projection intersects the current pullback path.`,
    `Stop is beyond the CURRENT line's structural swing; target is near the recent trend extreme.`,
  ];
  return result;
}

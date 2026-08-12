import type { Candle } from "@/types/forex";
import type { StrategyDirection } from "@/lib/strategy/types";

export interface SwingPoint {
  index: number;
  price: number;
}

export function findSwingPoints(candles: Candle[], radius = 2) {
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];
  for (let index = radius; index < candles.length - radius; index += 1) {
    const candle = candles[index]!;
    let high = true;
    let low = true;
    for (let offset = 1; offset <= radius; offset += 1) {
      high &&= candle.high > candles[index - offset]!.high && candle.high >= candles[index + offset]!.high;
      low &&= candle.low < candles[index - offset]!.low && candle.low <= candles[index + offset]!.low;
    }
    if (high) highs.push({ index, price: candle.high });
    if (low) lows.push({ index, price: candle.low });
  }
  return { highs, lows };
}

export function evaluateStructure(candles: Candle[], direction: Exclude<StrategyDirection, null>) {
  const swings = findSwingPoints(candles);
  const recentHighs = swings.highs.slice(-2);
  const recentLows = swings.lows.slice(-2);
  const close = candles.at(-1)?.close ?? 0;
  if (recentHighs.length < 2 || recentLows.length < 2) {
    return { passed: false, reason: "Not enough confirmed swing points.", swings };
  }
  if (direction === "long") {
    const sequence = recentHighs[1]!.price > recentHighs[0]!.price && recentLows[1]!.price > recentLows[0]!.price;
    const breakOfStructure = close > recentHighs[1]!.price;
    return {
      passed: sequence || breakOfStructure,
      reason: sequence ? "Confirmed higher highs and higher lows." : breakOfStructure ? "Closed above the recent swing high." : "No bullish swing sequence or break of structure.",
      swings,
    };
  }
  const sequence = recentHighs[1]!.price < recentHighs[0]!.price && recentLows[1]!.price < recentLows[0]!.price;
  const breakOfStructure = close < recentLows[1]!.price;
  return {
    passed: sequence || breakOfStructure,
    reason: sequence ? "Confirmed lower highs and lower lows." : breakOfStructure ? "Closed below the recent swing low." : "No bearish swing sequence or break of structure.",
    swings,
  };
}

export interface H1StructureRead {
  direction: "bullish" | "bearish" | "mixed";
  intact: boolean;
  reason: string;
  swings: ReturnType<typeof findSwingPoints>;
}

/** Classify completed H1 structure from pivots confirmed by right-side bars. */
export function classifyH1Structure(candles: Candle[], radius = 2): H1StructureRead {
  const completed = candles.filter((candle) => candle.complete);
  const swings = findSwingPoints(completed, radius);
  const highs = swings.highs.slice(-2);
  const lows = swings.lows.slice(-2);
  const close = completed.at(-1)?.close;
  if (highs.length < 2 || lows.length < 2 || close === undefined) {
    return { direction: "mixed", intact: false, reason: "No clear H1 direction: two confirmed swing highs and lows are required.", swings };
  }

  const bullish = highs[1]!.price > highs[0]!.price && lows[1]!.price > lows[0]!.price;
  const bearish = highs[1]!.price < highs[0]!.price && lows[1]!.price < lows[0]!.price;
  if (bullish) {
    const intact = close > lows[1]!.price;
    return { direction: intact ? "bullish" : "mixed", intact, reason: intact ? "Confirmed H1 higher highs and higher lows." : "H1 bullish structure became invalid below its latest confirmed swing low.", swings };
  }
  if (bearish) {
    const intact = close < highs[1]!.price;
    return { direction: intact ? "bearish" : "mixed", intact, reason: intact ? "Confirmed H1 lower highs and lower lows." : "H1 bearish structure became invalid above its latest confirmed swing high.", swings };
  }
  return { direction: "mixed", intact: false, reason: "No clear H1 direction: confirmed swings are mixed.", swings };
}

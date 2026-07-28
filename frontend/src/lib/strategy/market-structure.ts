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

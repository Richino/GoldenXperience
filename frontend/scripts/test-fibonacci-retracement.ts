import assert from "node:assert/strict";
import { deriveFibonacciRetracement } from "../src/lib/chart-utils";
import type { Candle } from "../src/types/forex";

function candlesFromTurns(turns: Array<[number, number]>): Candle[] {
  const closes: number[] = [];
  for (let segment = 0; segment < turns.length - 1; segment += 1) {
    const [startIndex, startPrice] = turns[segment]!;
    const [endIndex, endPrice] = turns[segment + 1]!;
    for (let index = startIndex; index < endIndex; index += 1) {
      closes[index] = startPrice + (endPrice - startPrice) * (index - startIndex) / (endIndex - startIndex);
    }
  }
  closes[turns.at(-1)![0]] = turns.at(-1)![1];
  return closes.map((close, index) => ({
    time: new Date(Date.UTC(2026, 8, 1, index * 4)).toISOString(),
    open: closes[index - 1] ?? close,
    high: close + 0.0001,
    low: close - 0.0001,
    close,
    volume: 100,
    complete: true,
  }));
}

// 33 H4 candles span more than two days. The Fib must use its timeframe-aware
// lookback instead of disappearing because the legacy two-day window has only
// 12 H4 candles.
const h4Candles = candlesFromTurns([
  [0, 1.1000], [4, 1.1200], [8, 1.1050], [12, 1.1300], [16, 1.1100],
  [20, 1.1400], [24, 1.1150], [28, 1.1500], [32, 1.1400],
]);
const fib = deriveFibonacciRetracement(h4Candles);
assert.ok(fib, "H4 Fib should have enough timeframe-aware history");
assert.equal(fib.direction, "bullish");
assert.equal(fib.levels.length, 7);
assert.equal(fib.levels.at(0)?.ratio, 0);
assert.equal(fib.levels.at(-1)?.ratio, 1);
console.log("Fibonacci retracement fixtures passed.");

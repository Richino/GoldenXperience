import type { Candle } from "@/types/forex";

export function calculateEmaValues(closes: number[], period: number) {
  const values: Array<number | null> = [];
  const multiplier = 2 / (period + 1);
  let previous: number | null = null;

  for (let index = 0; index < closes.length; index += 1) {
    if (index < period - 1) {
      values.push(null);
      continue;
    }
    if (previous === null) {
      previous = closes.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    } else {
      previous = closes[index]! * multiplier + previous * (1 - multiplier);
    }
    values.push(previous);
  }
  return values;
}

export function calculateAtrValues(candles: Candle[], period: number) {
  const values: Array<number | null> = [];
  let previousAtr: number | null = null;

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]!;
    const priorClose = candles[index - 1]?.close ?? candle.close;
    const tr = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - priorClose),
      Math.abs(candle.low - priorClose),
    );
    if (index < period - 1) {
      values.push(null);
      continue;
    }
    if (previousAtr === null) {
      let seed = 0;
      for (let seedIndex = index - period + 1; seedIndex <= index; seedIndex += 1) {
        const seedCandle = candles[seedIndex]!;
        const seedPriorClose = candles[seedIndex - 1]?.close ?? seedCandle.close;
        seed += Math.max(seedCandle.high - seedCandle.low, Math.abs(seedCandle.high - seedPriorClose), Math.abs(seedCandle.low - seedPriorClose));
      }
      previousAtr = seed / period;
    } else {
      previousAtr = (previousAtr * (period - 1) + tr) / period;
    }
    values.push(previousAtr);
  }
  return values;
}

export function calculateRsiValues(closes: number[], period: number) {
  const values: Array<number | null> = [];
  let averageGain = 0;
  let averageLoss = 0;

  for (let index = 0; index < closes.length; index += 1) {
    if (index === 0) {
      values.push(null);
      continue;
    }
    const change = closes[index]! - closes[index - 1]!;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (index < period) {
      averageGain += gain;
      averageLoss += loss;
      values.push(null);
      continue;
    }
    if (index === period) {
      averageGain = (averageGain + gain) / period;
      averageLoss = (averageLoss + loss) / period;
    } else {
      averageGain = (averageGain * (period - 1) + gain) / period;
      averageLoss = (averageLoss * (period - 1) + loss) / period;
    }
    values.push(averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss));
  }
  return values;
}

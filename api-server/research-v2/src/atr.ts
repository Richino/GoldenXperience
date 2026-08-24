/**
 * Fast ATR series: O(n) once per instrument, reused by regime/features.
 */
import type { Candle } from "./types.js";

export function precomputeAtr(candles: Candle[], period = 14): Float64Array {
  const out = new Float64Array(candles.length);
  if (candles.length < 2) return out;
  let sum = 0;
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    if (i <= period) {
      sum += tr;
      out[i] = sum / i;
    } else {
      // Wilder-ish rolling mean of last `period` TRs via incremental approx:
      out[i] = (out[i - 1]! * (period - 1) + tr) / period;
    }
  }
  return out;
}

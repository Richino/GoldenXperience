/**
 * eurusdbot3-1 — indicators.
 *
 * Self-contained, allocation-light indicator series so the harness has no
 * cross-package dependency. All series are causal: series[i] uses only bars 0..i.
 */
import type { Bar } from "./data.js";

/** EMA series over closes. ema[i] uses closes 0..i. */
export function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out = new Array<number>(values.length);
  let prev = values[0]!;
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder ATR series. atr[i] uses bars 0..i; first `period` values are seeded. */
export function atrSeries(bars: Bar[], period = 14): number[] {
  const n = bars.length;
  const tr = new Array<number>(n);
  tr[0] = bars[0]!.high - bars[0]!.low;
  for (let i = 1; i < n; i++) {
    const h = bars[i]!.high, l = bars[i]!.low, pc = bars[i - 1]!.close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const out = new Array<number>(n);
  let atr = 0;
  for (let i = 0; i < n; i++) {
    if (i < period) {
      atr += tr[i]!;
      out[i] = atr / (i + 1);
      if (i === period - 1) { atr = atr / period; out[i] = atr; }
    } else {
      atr = (atr * (period - 1) + tr[i]!) / period;
      out[i] = atr;
    }
  }
  return out;
}

/** Standard deviation of the last `window` values ending at i (causal). */
export function rollingStd(values: number[], i: number, window: number): number {
  const start = Math.max(0, i - window + 1);
  let sum = 0, cnt = 0;
  for (let j = start; j <= i; j++) { sum += values[j]!; cnt++; }
  const mean = sum / cnt;
  let v = 0;
  for (let j = start; j <= i; j++) v += (values[j]! - mean) ** 2;
  return Math.sqrt(v / cnt);
}

/**
 * Percentile rank (0..1) of values[i] within the trailing `window` values
 * ending at i. Causal.
 */
export function percentileRank(values: number[], i: number, window: number): number {
  const start = Math.max(0, i - window + 1);
  const x = values[i]!;
  let below = 0, total = 0;
  for (let j = start; j <= i; j++) { if (values[j]! <= x) below++; total++; }
  return total ? below / total : 0.5;
}

export type Swing = { index: number; price: number; kind: "high" | "low" };

/**
 * Fractal swing points on a bar array using a symmetric window `k` (a bar is a
 * swing high if its high is the max of the 2k+1 window centered on it). Because
 * confirmation needs k future bars, a swing at index j is only "known" at index
 * j + k. Callers must respect that when using swings causally.
 */
export function swingPoints(bars: Bar[], k = 3): Swing[] {
  const out: Swing[] = [];
  for (let i = k; i < bars.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (bars[j]!.high >= bars[i]!.high) isHigh = false;
      if (bars[j]!.low <= bars[i]!.low) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: bars[i]!.high, kind: "high" });
    if (isLow) out.push({ index: i, price: bars[i]!.low, kind: "low" });
  }
  return out;
}

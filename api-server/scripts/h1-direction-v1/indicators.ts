/**
 * h1-direction-v1 — causal indicator series (H1 only).
 */
import type { Bar } from "./data.js";

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

export function rsiSeries(values: number[], period = 14): number[] {
  const out = new Array<number>(values.length).fill(50);
  if (values.length <= period) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function macdSeries(values: number[]): { macd: number[]; signal: number[]; hist: number[] } {
  const ema12 = emaSeries(values, 12);
  const ema26 = emaSeries(values, 26);
  const macd = values.map((_, i) => ema12[i]! - ema26[i]!);
  const signal = emaSeries(macd, 9);
  const hist = macd.map((m, i) => m - signal[i]!);
  return { macd, signal, hist };
}

export function slope(values: number[]): number {
  const meanX = (values.length - 1) / 2;
  const meanY = values.reduce((s, v) => s + v, 0) / values.length;
  let num = 0, den = 0;
  for (let i = 0; i < values.length; i++) {
    num += (i - meanX) * (values[i]! - meanY);
    den += (i - meanX) ** 2;
  }
  return den ? num / den : 0;
}

export function percentileRank(values: number[], i: number, window: number): number {
  const start = Math.max(0, i - window + 1);
  const x = values[i]!;
  let below = 0, total = 0;
  for (let j = start; j <= i; j++) { if (values[j]! <= x) below++; total++; }
  return total ? below / total : 0.5;
}

export type Swing = { index: number; price: number; kind: "high" | "low" };

/** Fractal swings; confirmed at index + k (causal usage requires j + k <= i). */
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

export function smaSeries(values: number[], period: number): number[] {
  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - period + 1);
    let sum = 0, cnt = 0;
    for (let j = start; j <= i; j++) { sum += values[j]!; cnt++; }
    out[i] = sum / cnt;
  }
  return out;
}

export function bollingerWidth(values: number[], i: number, period = 20): number {
  const start = Math.max(0, i - period + 1);
  let sum = 0, cnt = 0;
  for (let j = start; j <= i; j++) { sum += values[j]!; cnt++; }
  const mean = sum / cnt;
  let v = 0;
  for (let j = start; j <= i; j++) v += (values[j]! - mean) ** 2;
  const std = Math.sqrt(v / cnt);
  return std * 4 / Math.max(1e-9, mean);
}

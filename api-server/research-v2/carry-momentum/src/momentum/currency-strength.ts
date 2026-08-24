import type { Currency } from "../types.js";
import { CURRENCIES } from "../config.js";

export type Candle = {
  instrument: string;
  closeTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  bidClose: number | null;
  askClose: number | null;
};

export function splitPair(instrument: string): { base: Currency; quote: Currency } {
  const [b, q] = instrument.split("_");
  return { base: b as Currency, quote: q as Currency };
}

/**
 * Currency strength from cross-sectional pair returns.
 * For each pair return R = log(C_t / C_{t-L}):
 *   base gets +R, quote gets -R
 * Average across available pairs per currency; ATR-normalize optional via pairRet already normalized.
 */
export function currencyMomentumScores(
  instruments: string[],
  closesByInst: Map<string, number[]>,
  idx: number,
  lookback: number,
  atrByInst?: Map<string, number[]>,
): Map<Currency, { score: number; n: number }> {
  const acc = new Map<Currency, { sum: number; n: number }>();
  for (const c of CURRENCIES) acc.set(c, { sum: 0, n: 0 });

  for (const inst of instruments) {
    const closes = closesByInst.get(inst);
    if (!closes || idx < lookback) continue;
    const c0 = closes[idx - lookback]!;
    const c1 = closes[idx]!;
    if (!(c0 > 0) || !(c1 > 0)) continue;
    let r = Math.log(c1 / c0);
    const atrs = atrByInst?.get(inst);
    const atr = atrs?.[idx];
    if (atr && atr > 0) r = (c1 - c0) / atr; // ATR-normalized return

    const { base, quote } = splitPair(inst);
    const b = acc.get(base)!;
    const q = acc.get(quote)!;
    b.sum += r;
    b.n += 1;
    q.sum -= r;
    q.n += 1;
  }

  const out = new Map<Currency, { score: number; n: number }>();
  for (const c of CURRENCIES) {
    const a = acc.get(c)!;
    out.set(c, { score: a.n > 0 ? a.sum / a.n : 0, n: a.n });
  }
  return out;
}

export function rankDescending(scores: Map<Currency, number>): Currency[] {
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

export function atr14(highs: number[], lows: number[], closes: number[], i: number): number {
  if (i < 14) return NaN;
  let sum = 0;
  for (let k = i - 13; k <= i; k++) {
    const prev = closes[k - 1]!;
    const tr = Math.max(highs[k]! - lows[k]!, Math.abs(highs[k]! - prev), Math.abs(lows[k]! - prev));
    sum += tr;
  }
  return sum / 14;
}

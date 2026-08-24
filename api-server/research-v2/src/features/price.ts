import { mean, olsSlopeR2, std } from "../math.js";
import type { Candle } from "../types.js";

function safeRet(a: number, b: number): number {
  if (b === 0) return 0;
  return (a - b) / b;
}

function atrSeries(candles: Candle[], i: number, period = 14): number {
  if (i < 1) return 0;
  const start = Math.max(1, i - period + 1);
  let sum = 0;
  let n = 0;
  for (let k = start; k <= i; k += 1) {
    const c = candles[k]!;
    const prev = candles[k - 1]!;
    sum += Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    n += 1;
  }
  return n ? sum / n : 0;
}

/** Price/structure features using only bars ≤ i. */
export function priceFeatures(candles: Candle[], i: number): Record<string, number> {
  const out: Record<string, number> = {};
  const c = candles[i]!;
  const atr = atrSeries(candles, i, 14);
  const close = c.close;
  const bars = [1, 3, 6, 12, 24];
  for (const b of bars) {
    const prev = candles[i - b];
    out[`ret_${b}`] = prev ? safeRet(close, prev.close) : 0;
  }

  const mom12 = out.ret_12 ?? 0;
  const mom24 = out.ret_24 ?? 0;
  out.mom_accel = mom12 - mom24 / 2;

  out.atr_pct = atr > 0 && close > 0 ? atr / close : 0;

  const rets: number[] = [];
  for (let k = Math.max(1, i - 23); k <= i; k += 1) {
    rets.push(safeRet(candles[k]!.close, candles[k - 1]!.close));
  }
  out.rvol_24 = std(rets);

  // Cheap vol percentile: compare current rvol to a sparse history of prior rvols
  const priorRvols: number[] = [];
  for (let w = 6; w <= 120 && i - 24 - w >= 24; w += 6) {
    const slice: number[] = [];
    const end = i - w;
    for (let k = end - 23; k <= end; k += 1) slice.push(safeRet(candles[k]!.close, candles[k - 1]!.close));
    priorRvols.push(std(slice));
  }
  if (priorRvols.length > 1) {
    const cur = out.rvol_24;
    out.vol_pctl = priorRvols.filter((v) => v <= cur).length / priorRvols.length;
    out.vol_of_vol = std(priorRvols);
  } else {
    out.vol_pctl = 0.5;
    out.vol_of_vol = 0;
  }

  const range20 = candles.slice(Math.max(0, i - 19), i + 1);
  const hi = Math.max(...range20.map((x) => x.high));
  const lo = Math.min(...range20.map((x) => x.low));
  out.roll_range_atr = atr > 0 ? (hi - lo) / atr : 0;
  out.dist_high_atr = atr > 0 ? (hi - close) / atr : 0;
  out.dist_low_atr = atr > 0 ? (close - lo) / atr : 0;

  const look = candles.slice(Math.max(0, i - 47), i + 1).map((x) => x.close);
  const { slope, r2 } = olsSlopeR2(look);
  out.trend_slope_atr = atr > 0 ? slope / atr : 0;
  out.trend_r2 = r2;

  const body = Math.abs(c.close - c.open);
  const full = Math.max(c.high - c.low, 1e-12);
  out.body_ratio = body / full;
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  out.wick_asym = (upper - lower) / full;

  // Directional efficiency: net move / path length
  let path = 0;
  for (let k = Math.max(1, i - 11); k <= i; k += 1) {
    path += Math.abs(candles[k]!.close - candles[k - 1]!.close);
  }
  const net = Math.abs(close - (candles[Math.max(0, i - 12)]?.close ?? close));
  out.dir_eff_12 = path > 0 ? net / path : 0;

  out.breakout_dist_atr = atr > 0 ? (close - hi) / atr : 0; // negative inside range

  const ranges = range20.map((x) => x.high - x.low);
  const recent = mean(ranges.slice(-10));
  const prior = mean(ranges.slice(0, 10));
  out.range_compress = prior > 0 ? recent / prior : 1;
  out.range_expand = out.range_compress;

  void mean;
  return out;
}

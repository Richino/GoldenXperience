/**
 * eurusd-move-v1 — Stage A (MOVE detector) features.
 *
 * DELIBERATELY non-directional: only magnitude / volatility / compression /
 * location-extremity / session / scheduled-news-proximity. The MOVE detector
 * must not be able to infer UP vs DOWN. All causal (bars 0..i).
 */
import { PIP, type NewsEvent } from "../eurusdbot3-1/data.js";
import { type Ctx } from "../eurusdbot3-1/features.js";
import { rollingStd, percentileRank } from "../eurusdbot3-1/indicators.js";
import { buildNewsFeatures } from "../eurusdbot3-1/news-features.js";

export const MOVE_FEATURES: string[] = [
  "atr_norm", "atr_pct", "atr_expand_20", "atr_expand_50",
  "rvol_24", "bbwidth_20", "range_atr_bar", "body_ratio",
  "range12_atr", "range24_atr", "range48_atr", "compression_12_96",
  "dist_hi_abs", "dist_lo_abs", "nearest_boundary", "swing_comp",
  "hour_sin", "hour_cos", "dow_sin", "dow_cos",
  "sess_asia", "sess_london", "sess_ny", "sess_overlap",
];
export const MOVE_NEWS_FEATURES: string[] = ["mins_to_high", "cluster_8h", "upcoming_60"];

function sessionFlags(hourUtc: number) {
  return {
    asia: hourUtc >= 22 || hourUtc < 7 ? 1 : 0,
    london: hourUtc >= 7 && hourUtc < 16 ? 1 : 0,
    ny: hourUtc >= 12 && hourUtc < 21 ? 1 : 0,
    overlap: hourUtc >= 12 && hourUtc < 16 ? 1 : 0,
  };
}

function rangeATR(ctx: Ctx, i: number, n: number): number {
  const start = Math.max(0, i - n + 1);
  let hi = -Infinity, lo = Infinity;
  for (let j = start; j <= i; j++) { if (ctx.h1[j]!.high > hi) hi = ctx.h1[j]!.high; if (ctx.h1[j]!.low < lo) lo = ctx.h1[j]!.low; }
  return (hi - lo) / (ctx.atr[i]! || 5 * PIP);
}

export function buildMoveFeatures(
  ctx: Ctx, i: number, news: NewsEvent[], zByEvent: Map<NewsEvent, number>, withNews: boolean,
): Record<string, number> {
  const a = ctx.atr[i]! || 5 * PIP;
  const px = ctx.closes[i]!;
  const bar = ctx.h1[i]!;

  const atrNorm = a / px / PIP;
  const atrPct = percentileRank(ctx.atr, i, 500);
  const atrExp20 = i - 20 >= 0 && ctx.atr[i - 20]! > 0 ? a / ctx.atr[i - 20]! : 1;
  const atrExp50 = i - 50 >= 0 && ctx.atr[i - 50]! > 0 ? a / ctx.atr[i - 50]! : 1;
  const rvol24 = rollingStd(ctx.ret1, i, 24) / (a / px || 1);
  const bbwidth = rollingStd(ctx.closes, i, 20) / px / PIP;
  const rng = bar.high - bar.low || a;

  const r12 = rangeATR(ctx, i, 12), r24 = rangeATR(ctx, i, 24), r48 = rangeATR(ctx, i, 48);
  const r96 = rangeATR(ctx, i, 96);
  const compression = r96 > 0 ? r12 / r96 : 1; // small = compressed

  // location extremity (absolute; no sign leaks direction)
  const start = Math.max(0, i - 119);
  let mn = Infinity, mx = -Infinity;
  for (let j = start; j <= i; j++) { if (ctx.closes[j]! < mn) mn = ctx.closes[j]!; if (ctx.closes[j]! > mx) mx = ctx.closes[j]!; }
  const distHi = Math.abs(px - mx) / a, distLo = Math.abs(px - mn) / a;
  const nearestBoundary = Math.min(distHi, distLo);

  // swing compression: span of last few confirmed swings / atr
  const highs = ctx.swingHighKnownAt.filter((s) => s.at <= i).slice(-2).map((s) => s.price);
  const lows = ctx.swingLowKnownAt.filter((s) => s.at <= i).slice(-2).map((s) => s.price);
  const swingComp = highs.length && lows.length ? (Math.max(...highs) - Math.min(...lows)) / a : r24;

  const hourUtc = new Date(bar.t).getUTCHours();
  const dow = new Date(bar.t).getUTCDay();
  const s = sessionFlags(hourUtc);

  const base: Record<string, number> = {
    atr_norm: atrNorm, atr_pct: atrPct, atr_expand_20: atrExp20, atr_expand_50: atrExp50,
    rvol_24: rvol24, bbwidth_20: bbwidth, range_atr_bar: rng / a, body_ratio: Math.abs(bar.close - bar.open) / rng,
    range12_atr: r12, range24_atr: r24, range48_atr: r48, compression_12_96: compression,
    dist_hi_abs: distHi, dist_lo_abs: distLo, nearest_boundary: nearestBoundary, swing_comp: swingComp,
    hour_sin: Math.sin((2 * Math.PI * hourUtc) / 24), hour_cos: Math.cos((2 * Math.PI * hourUtc) / 24),
    dow_sin: Math.sin((2 * Math.PI * dow) / 7), dow_cos: Math.cos((2 * Math.PI * dow) / 7),
    sess_asia: s.asia, sess_london: s.london, sess_ny: s.ny, sess_overlap: s.overlap,
  };
  if (withNews && news.length) {
    const nf = buildNewsFeatures(news, zByEvent, bar.t);
    base.mins_to_high = nf.mins_to_high!;
    base.cluster_8h = nf.cluster_8h!;
    base.upcoming_60 = nf.upcoming_60!;
  } else {
    base.mins_to_high = 1; base.cluster_8h = 0; base.upcoming_60 = 0;
  }
  return base;
}

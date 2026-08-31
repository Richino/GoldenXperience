/**
 * eurusdbot3-1 — EUR/USD-specific feature layer.
 *
 * All features are causal (index i uses bars 0..i and only completed higher-tf
 * bars). Directional features carry a sign so the same model can score a LONG
 * and a SHORT candidate from one symmetric, sign-normalized representation:
 *   - LONG  sample: features as-is.
 *   - SHORT sample: directional features negated (non-directional untouched).
 * This doubles the training data and bakes in a long/short symmetry prior,
 * which curbs overfitting on 7 years of a single instrument.
 */
import { PIP, type Bar, lastIndexAtOrBefore } from "./data.js";
import { emaSeries, atrSeries, rollingStd, percentileRank, swingPoints, type Swing } from "./indicators.js";

/** Feature names that flip sign when scoring the short side. */
export const DIRECTIONAL = new Set<string>([
  "mom_1", "mom_3", "mom_6", "mom_12", "mom_24",
  "h4_ret_1", "h4_ret_2", "h4_ret_4",
  "d_ret_1", "d_ret_2", "d_ret_3",
  "ema_slope_h1", "ema_gap_h1", "ema_gap_h4", "loc_daily",
  "trend_align", "struct_bias", "range_pos",
  "dist_swing_high", "dist_swing_low", "dist_dhigh", "dist_dlow",
  "consec", "news_surprise_dir",
]);

export const FEATURE_NAMES: string[] = [
  // directional
  "mom_1", "mom_3", "mom_6", "mom_12", "mom_24",
  "h4_ret_1", "h4_ret_2", "h4_ret_4",
  "d_ret_1", "d_ret_2", "d_ret_3",
  "ema_slope_h1", "ema_gap_h1", "ema_gap_h4", "loc_daily",
  "trend_align", "struct_bias", "range_pos",
  "dist_swing_high", "dist_swing_low", "dist_dhigh", "dist_dlow", "consec",
  // non-directional
  "atr_norm", "atr_pct", "atr_expand", "rvol", "body_ratio", "range_atr",
  "hour_sin", "hour_cos", "dow_sin", "dow_cos",
  "sess_asia", "sess_london", "sess_ny", "sess_overlap",
];

export const NEWS_FEATURE_NAMES: string[] = [
  "mins_to_high", "mins_since_high", "upcoming_60", "upcoming_eur", "upcoming_usd",
  "cluster_8h", "news_surprise_dir", "news_surprise_mag",
];

export type Ctx = {
  h1: Bar[];
  m15: Bar[];
  closes: number[];
  atr: number[];
  ema20: number[]; ema50: number[]; ema80: number[]; ema200: number[]; ema480: number[];
  ret1: number[];
  swings: Swing[];
  swingHighKnownAt: { at: number; price: number }[]; // confirmed swing highs with confirm index
  swingLowKnownAt: { at: number; price: number }[];
};

const SWING_K = 3;

export function buildContext(h1: Bar[], m15: Bar[]): Ctx {
  const closes = h1.map((b) => b.close);
  const atr = atrSeries(h1, 14);
  const ret1 = closes.map((c, i) => (i === 0 ? 0 : (c - closes[i - 1]!) / closes[i - 1]!));
  const swings = swingPoints(h1, SWING_K);
  const swingHighKnownAt = swings.filter((s) => s.kind === "high").map((s) => ({ at: s.index + SWING_K, price: s.price }));
  const swingLowKnownAt = swings.filter((s) => s.kind === "low").map((s) => ({ at: s.index + SWING_K, price: s.price }));
  return {
    h1, m15, closes, atr,
    ema20: emaSeries(closes, 20), ema50: emaSeries(closes, 50),
    ema80: emaSeries(closes, 80), ema200: emaSeries(closes, 200), ema480: emaSeries(closes, 480),
    ret1, swings, swingHighKnownAt, swingLowKnownAt,
  };
}

/** UTC-hour session mapping (deterministic; ~1h DST slippage accepted). */
function sessionFlags(hourUtc: number) {
  const asia = hourUtc >= 22 || hourUtc < 7 ? 1 : 0;
  const london = hourUtc >= 7 && hourUtc < 16 ? 1 : 0;
  const ny = hourUtc >= 12 && hourUtc < 21 ? 1 : 0;
  const overlap = hourUtc >= 12 && hourUtc < 16 ? 1 : 0;
  return { asia, london, ny, overlap };
}

function recentConfirmed(list: { at: number; price: number }[], i: number): number | null {
  // last entry confirmed at or before i
  let lo = 0, hi = list.length - 1, found = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (list[m]!.at <= i) { found = m; lo = m + 1; } else hi = m - 1; }
  return found >= 0 ? list[found]!.price : null;
}

/** Signed structure bias in [-1,1] from the last up-to-3 confirmed swing highs/lows. */
function structureBias(ctx: Ctx, i: number): number {
  const highs = ctx.swingHighKnownAt.filter((s) => s.at <= i).slice(-3).map((s) => s.price);
  const lows = ctx.swingLowKnownAt.filter((s) => s.at <= i).slice(-3).map((s) => s.price);
  let score = 0, parts = 0;
  if (highs.length >= 2) { score += highs.at(-1)! > highs.at(-2)! ? 1 : -1; parts++; }
  if (lows.length >= 2) { score += lows.at(-1)! > lows.at(-2)! ? 1 : -1; parts++; }
  return parts ? score / parts : 0;
}

export function buildRawFeatures(
  ctx: Ctx, i: number, h4: Bar[], daily: Bar[],
): Record<string, number> {
  const { closes, atr } = ctx;
  const a = atr[i]! || (5 * PIP);
  const px = closes[i]!;
  const mom = (n: number) => (i - n >= 0 ? (closes[i]! - closes[i - n]!) / a : 0);

  const h4Idx = lastIndexAtOrBefore(h4, ctx.h1[i]!.t);
  const dIdx = lastIndexAtOrBefore(daily, ctx.h1[i]!.t);
  const h4ret = (n: number) => (h4Idx - n >= 0 ? (h4[h4Idx]!.close - h4[h4Idx - n]!.close) / a : 0);
  const dret = (n: number) => (dIdx - n >= 0 ? (daily[dIdx]!.close - daily[dIdx - n]!.close) / a : 0);

  const emaSlope = i - 6 >= 0 ? (ctx.ema20[i]! - ctx.ema20[i - 6]!) / a : 0;
  const emaGapH1 = (ctx.ema20[i]! - ctx.ema50[i]!) / a;
  const emaGapH4 = (ctx.ema80[i]! - ctx.ema200[i]!) / a;
  const locDaily = (px - ctx.ema480[i]!) / a;

  const trendAlign = ((emaGapH1 > 0 ? 1 : -1) + (emaGapH4 > 0 ? 1 : -1) + (locDaily > 0 ? 1 : -1)) / 3;
  const structBias = structureBias(ctx, i);

  // range position over last 120 H1 bars
  const start = Math.max(0, i - 119);
  let mn = Infinity, mx = -Infinity;
  for (let j = start; j <= i; j++) { if (closes[j]! < mn) mn = closes[j]!; if (closes[j]! > mx) mx = closes[j]!; }
  const rangePos = mx > mn ? 2 * ((px - mn) / (mx - mn)) - 1 : 0;

  const swHigh = recentConfirmed(ctx.swingHighKnownAt, i);
  const swLow = recentConfirmed(ctx.swingLowKnownAt, i);
  const distSwingHigh = swHigh != null ? (px - swHigh) / a : 0;
  const distSwingLow = swLow != null ? (px - swLow) / a : 0;

  // rolling daily hi/lo over last 24 H1 bars
  let dh = -Infinity, dl = Infinity;
  for (let j = Math.max(0, i - 23); j <= i; j++) { if (ctx.h1[j]!.high > dh) dh = ctx.h1[j]!.high; if (ctx.h1[j]!.low < dl) dl = ctx.h1[j]!.low; }
  const distDhigh = (px - dh) / a;
  const distDlow = (px - dl) / a;

  // consecutive same-direction H1 closes (signed)
  let consec = 0;
  for (let j = i; j > 0; j--) {
    const dir = Math.sign(closes[j]! - closes[j - 1]!);
    if (j === i) { consec = dir; }
    else if (Math.sign(closes[j]! - closes[j - 1]!) === Math.sign(consec) && consec !== 0) consec += dir;
    else break;
  }
  consec = Math.max(-8, Math.min(8, consec)) / 8;

  const atrNorm = a / px / PIP; // ATR in pips
  const atrPct = percentileRank(atr, i, 500);
  const atrExpand = i - 20 >= 0 && atr[i - 20]! > 0 ? a / atr[i - 20]! : 1;
  const rvol = rollingStd(ctx.ret1, i, 24) / (a / px || 1);
  const bar = ctx.h1[i]!;
  const rng = bar.high - bar.low || a;
  const bodyRatio = Math.abs(bar.close - bar.open) / rng;
  const rangeAtr = rng / a;

  const hourUtc = new Date(bar.t).getUTCHours();
  const dow = new Date(bar.t).getUTCDay();
  const s = sessionFlags(hourUtc);

  return {
    mom_1: mom(1), mom_3: mom(3), mom_6: mom(6), mom_12: mom(12), mom_24: mom(24),
    h4_ret_1: h4ret(1), h4_ret_2: h4ret(2), h4_ret_4: h4ret(4),
    d_ret_1: dret(1), d_ret_2: dret(2), d_ret_3: dret(3),
    ema_slope_h1: emaSlope, ema_gap_h1: emaGapH1, ema_gap_h4: emaGapH4, loc_daily: locDaily,
    trend_align: trendAlign, struct_bias: structBias, range_pos: rangePos,
    dist_swing_high: distSwingHigh, dist_swing_low: distSwingLow,
    dist_dhigh: distDhigh, dist_dlow: distDlow, consec,
    atr_norm: atrNorm, atr_pct: atrPct, atr_expand: atrExpand, rvol,
    body_ratio: bodyRatio, range_atr: rangeAtr,
    hour_sin: Math.sin((2 * Math.PI * hourUtc) / 24), hour_cos: Math.cos((2 * Math.PI * hourUtc) / 24),
    dow_sin: Math.sin((2 * Math.PI * dow) / 7), dow_cos: Math.cos((2 * Math.PI * dow) / 7),
    sess_asia: s.asia, sess_london: s.london, sess_ny: s.ny, sess_overlap: s.overlap,
  };
}

/** Apply the short-side sign flip to directional features (returns a new object). */
export function orientForShort(raw: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(raw)) out[k] = DIRECTIONAL.has(k) ? -raw[k]! : raw[k]!;
  return out;
}

/**
 * Deterministic multi-label regime classifier for V2.
 * No LLM. Uses only completed bars available at index i.
 */

import { clamp, mean, olsSlopeR2, percentile, std } from "./math.js";
import { classifySession } from "./sessions.js";
import type { Candle, RegimeSnapshot } from "./types.js";

function atrAt(candles: Candle[], i: number, period = 14): number {
  if (i < 1) return 0;
  const start = Math.max(1, i - period + 1);
  let sum = 0;
  let n = 0;
  for (let k = start; k <= i; k += 1) {
    const c = candles[k]!;
    const prev = candles[k - 1]!;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    sum += tr;
    n += 1;
  }
  return n > 0 ? sum / n : 0;
}

function realizedVol(closes: number[]): number {
  if (closes.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1]!;
    if (prev === 0) continue;
    rets.push((closes[i]! - prev) / prev);
  }
  return std(rets);
}

/**
 * Classify regime at bar index `i` (inclusive, completed).
 * Event windows are stubs until economic calendar ingestion lands.
 */
export function classifyRegimeV2(candles: Candle[], i: number): RegimeSnapshot {
  const lookback = 48;
  const atr = atrAt(candles, i, 14);
  const session = classifySession(new Date(candles[i]!.closeTime));

  const base: RegimeSnapshot = {
    trend: "mixed",
    volBucket: "normal",
    volPhase: "normal",
    session,
    eventWindow: "none",
    trendStrength: 0,
    slopeAtr: 0,
    atr,
    rangeWidthAtr: 0,
  };
  if (i < lookback || atr <= 0) return base;

  const window = candles.slice(i - lookback + 1, i + 1);
  const closes = window.map((c) => c.close);
  const { slope, r2 } = olsSlopeR2(closes);
  const slopeAtr = slope / atr;
  const travelAtr = Math.abs(slope) * lookback / atr;
  const rangeHigh = Math.max(...window.map((c) => c.high));
  const rangeLow = Math.min(...window.map((c) => c.low));
  const rangeWidthAtr = (rangeHigh - rangeLow) / atr;

  let trend: RegimeSnapshot["trend"] = "mixed";
  if (r2 >= 0.5 && travelAtr >= 1.0) trend = slope > 0 ? "bull" : "bear";
  else if (r2 <= 0.25 || rangeWidthAtr <= 2.2) trend = "range";

  // Volatility percentile vs prior ATRs (sparse sample for speed)
  const atrHist: number[] = [];
  for (let k = Math.max(14, i - 200); k <= i; k += 4) atrHist.push(atrAt(candles, k, 14));
  atrHist.push(atr);  const atrPctl = atrHist.filter((a) => a > 0).length
    ? (atrHist.filter((a) => a <= atr).length / atrHist.length) * 100
    : 50;
  const volBucket: RegimeSnapshot["volBucket"] =
    atrPctl >= 80 ? "high" : atrPctl <= 20 ? "low" : "normal";

  const recentRange = mean(
    candles.slice(Math.max(0, i - 19), i + 1).map((c) => (c.high - c.low) / Math.max(atr, 1e-12)),
  );
  const priorRange = mean(
    candles.slice(Math.max(0, i - 39), i - 19).map((c) => (c.high - c.low) / Math.max(atr, 1e-12)),
  );
  let volPhase: RegimeSnapshot["volPhase"] = "normal";
  if (recentRange < priorRange * 0.7 && rangeWidthAtr <= 2.5) volPhase = "compression";
  else if (recentRange > priorRange * 1.35 || atrPctl >= 85) volPhase = "expansion";

  // Keep realized vol available via trendStrength channel companions
  void realizedVol(closes);
  void percentile;

  return {
    trend,
    volBucket,
    volPhase,
    session,
    eventWindow: "none",
    trendStrength: clamp(r2, 0, 1),
    slopeAtr,
    atr,
    rangeWidthAtr,
  };
}

export function regimeFeatures(regime: RegimeSnapshot): Record<string, number> {
  return {
    reg_trend_bull: regime.trend === "bull" ? 1 : 0,
    reg_trend_bear: regime.trend === "bear" ? 1 : 0,
    reg_trend_range: regime.trend === "range" ? 1 : 0,
    reg_vol_low: regime.volBucket === "low" ? 1 : 0,
    reg_vol_high: regime.volBucket === "high" ? 1 : 0,
    reg_phase_comp: regime.volPhase === "compression" ? 1 : 0,
    reg_phase_exp: regime.volPhase === "expansion" ? 1 : 0,
    reg_trend_strength: regime.trendStrength,
    reg_slope_atr: regime.slopeAtr,
    reg_range_w_atr: regime.rangeWidthAtr,
  };
}

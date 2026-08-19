import { pipSizeFor } from "@/lib/instruments/catalog";
import { calculateAtrValues, calculateEmaValues } from "@/lib/strategy/indicators";
import { volatilityBucketFor } from "@/lib/strategy/strategy-common";
import type { Candle, MajorInstrument } from "@/types/forex";
import type { MarketRegime, MomentumState } from "@/lib/strategy/types";

/**
 * Deterministic market-regime classifier, shared by all four strategies so they
 * evaluate the same environment.
 *
 * Uses only completed candles available at decision time. No future candles, no
 * trade outcomes, no AI. Trend strength is the R² of an ordinary least-squares
 * fit of close over the lookback — a bounded 0..1 measure where 1 is a clean
 * line and 0 is chop — and direction is the sign of the fitted slope. This is a
 * pure read of price behaviour, not a forecast.
 */
export interface RegimeConfig {
  /** Bars used for the regression, range and slope. */
  lookbackBars: number;
  emaFastPeriod: number;
  emaMidPeriod: number;
  emaSlowPeriod: number;
  atrPeriod: number;
  /** R² at or above this is a trend. */
  trendingR2: number;
  /** R² at or below this is a range. */
  rangingR2: number;
  /** Minimum |slope|·bars / ATR for a trend to have real travel, not drift. */
  minTrendSlopeAtr: number;
  /** Bars compared for the acceleration read (recent vs prior window). */
  accelerationBars: number;
  /** Range band, in ATR, used to age a range. */
  rangeBandAtr: number;
}

export const DEFAULT_REGIME_CONFIG: RegimeConfig = {
  lookbackBars: 50,
  emaFastPeriod: 21,
  emaMidPeriod: 50,
  emaSlowPeriod: 200,
  atrPeriod: 14,
  trendingR2: 0.5,
  rangingR2: 0.25,
  minTrendSlopeAtr: 1.0,
  accelerationBars: 3,
  rangeBandAtr: 1.5,
};

/** OLS fit of y against its index. Returns slope per step and R² in [0,1]. */
function linearRegression(values: number[]): { slope: number; r2: number } {
  const n = values.length;
  if (n < 2) return { slope: 0, r2: 0 };
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = index - meanX;
    const dy = values[index]! - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0) return { slope: 0, r2: 0 };
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, r2: Math.max(0, Math.min(1, r2)) };
}

function momentumStateFor(closes: number[], atr: number, bars: number): MomentumState {
  if (atr <= 0 || closes.length < bars * 2 + 1) return "steady";
  const last = closes.at(-1)!;
  const mid = closes[closes.length - 1 - bars]!;
  const prior = closes[closes.length - 1 - bars * 2]!;
  const recent = (last - mid) / atr;
  const before = (mid - prior) / atr;
  const rising = recent > 0 && before >= 0;
  const falling = recent < 0 && before <= 0;
  // Same-direction and getting faster is acceleration; a shrinking move is stalling.
  if (rising && recent > before + 0.1) return "accelerating_up";
  if (falling && recent < before - 0.1) return "accelerating_down";
  if (Math.abs(recent) + 1e-9 < Math.abs(before) * 0.6) return "stalling";
  return "steady";
}

export function classifyRegime(
  instrument: MajorInstrument,
  candles15m: Candle[],
  evaluatedAt: string,
  config: RegimeConfig = DEFAULT_REGIME_CONFIG,
): MarketRegime {
  const completed = candles15m.filter((candle) => candle.complete);
  const pip = pipSizeFor(instrument);
  const closes = completed.map((candle) => candle.close);
  const atr = calculateAtrValues(completed, config.atrPeriod).at(-1) ?? 0;
  const atrPips = atr > 0 ? atr / pip : null;

  const emaFast = calculateEmaValues(closes, config.emaFastPeriod).at(-1) ?? null;
  const emaMid = calculateEmaValues(closes, config.emaMidPeriod).at(-1) ?? null;
  const emaSlow = calculateEmaValues(closes, config.emaSlowPeriod).at(-1) ?? null;

  const base: MarketRegime = {
    regime: "mixed", trendDirection: "none", trendStrength: 0, volatility: volatilityBucketFor(atrPips),
    atr: atr > 0 ? atr : null, atrPips, momentumState: "steady",
    emaFast, emaMid, emaSlow, slopeAtrPerBar: null,
    rangeHigh: null, rangeLow: null, rangeWidthAtr: null, rangeAgeBars: null,
    lookbackBars: config.lookbackBars, evaluatedAt,
  };
  if (completed.length < config.lookbackBars || atr <= 0) return base;

  const window = completed.slice(-config.lookbackBars);
  const windowCloses = window.map((candle) => candle.close);
  const { slope, r2 } = linearRegression(windowCloses);
  const slopeAtrPerBar = slope / atr;
  const travelAtr = Math.abs(slope) * config.lookbackBars / atr;

  const rangeHigh = Math.max(...window.map((candle) => candle.high));
  const rangeLow = Math.min(...window.map((candle) => candle.low));
  const rangeWidthAtr = (rangeHigh - rangeLow) / atr;

  // Range containment: how many of the lookback bars sat within a band around
  // the window mean. A high count means the window was a genuine consolidation —
  // what mean reversion needs — and it stays high even while the newest few bars
  // stretch outside the band, which is exactly the moment a fade is considered.
  const meanClose = windowCloses.reduce((sum, value) => sum + value, 0) / windowCloses.length;
  const band = atr * config.rangeBandAtr;
  let rangeAgeBars = 0;
  for (const candle of window) {
    if (Math.abs(candle.close - meanClose) <= band) rangeAgeBars += 1;
  }

  const trending = r2 >= config.trendingR2 && travelAtr >= config.minTrendSlopeAtr;
  const ranging = r2 <= config.rangingR2;
  const regime = trending ? "trending" : ranging ? "ranging" : "mixed";
  const trendDirection = !trending ? "none" : slope > 0 ? "up" : slope < 0 ? "down" : "none";

  return {
    ...base,
    regime,
    trendDirection,
    trendStrength: r2,
    slopeAtrPerBar,
    momentumState: momentumStateFor(closes, atr, config.accelerationBars),
    rangeHigh, rangeLow, rangeWidthAtr, rangeAgeBars,
  };
}

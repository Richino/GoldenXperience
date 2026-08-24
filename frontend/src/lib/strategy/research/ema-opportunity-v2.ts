/**
 * EMA Opportunity Detector V2 — RESEARCH ONLY. NOT REGISTERED. NEVER TRADES.
 *
 * This is deliberately not a strategy. It answers one question — "is this a
 * reasonable EMA-related moment to make a decision?" — and it is structurally
 * incapable of answering the other one. There is no direction in its output
 * type, and every feature it emits is signed in absolute market terms (up is
 * positive) rather than relative to a trade direction, so nothing downstream
 * can quietly inherit a view from it.
 *
 * That separation is the whole point of the experiment. `ema-v1` took its
 * direction from the EMA stack alone — fast>mid>slow means long — and a
 * 2,317-trade walk-forward put that at -0.189R per trade with a confidence
 * interval nowhere near zero. The follow-up audit found entry-location
 * variables identical between its winners and losers, and mean forward returns
 * indistinguishable from zero once the spread was removed. So the EMA stack is
 * being stripped of directional authority here and demoted to one feature among
 * many; whether anything else can supply that direction is the open question.
 *
 * Point-in-time safety is the hard rule: everything below reads only completed
 * candles up to and including the decision bar. Forward returns are the label,
 * and they are produced elsewhere, never here.
 */
import { calculateAtrValues, calculateEmaValues } from "@/lib/strategy/indicators";
import type { Candle } from "@/types/forex";

export const EMA_OPPORTUNITY_VERSION = "ema-opportunity-v2";

export interface EmaOpportunityConfig {
  emaFast: number;
  emaSlow: number;
  atrPeriod: number;
  /** Price must be within this many ATR of the EMA zone to count as interacting. */
  zonePadAtr: number;
  /** ...and no further than this from the fast EMA, in ATR. */
  maxDistanceAtr: number;
  /** Reject a spread this large relative to ATR — the decision is not actionable. */
  maxSpreadOverAtr: number;
  /** Minimum ATR in pips; below this the pair is not really moving. */
  minAtrPips: number;
  /** Bars of history required before any decision. */
  minHistoryBars: number;
}

/**
 * Deliberately loose. The detector is meant to mark plausible EMA decision
 * points, not to be an edge in itself — tightening these until the downstream
 * numbers improve would be fitting the detector to the answer.
 */
export const DEFAULT_EMA_OPPORTUNITY_CONFIG: EmaOpportunityConfig = {
  emaFast: 20,
  emaSlow: 50,
  atrPeriod: 14,
  zonePadAtr: 0.5,
  maxDistanceAtr: 2.5,
  maxSpreadOverAtr: 0.5,
  minAtrPips: 1.0,
  minHistoryBars: 260,
};

export type OpportunityVerdict = "OPPORTUNITY" | "NO_OPPORTUNITY";

export interface EmaOpportunity {
  verdict: OpportunityVerdict;
  reason: string;
  /** Absolute-terms context. Nothing here is expressed per trade direction. */
  features: Record<string, number> | null;
}

/** Simple fractal swings: a bar whose extreme exceeds `k` neighbours each side. */
function swings(candles: Candle[], k: number) {
  const highs: number[] = []; const lows: number[] = [];
  for (let i = k; i < candles.length - k; i += 1) {
    let isHigh = true; let isLow = true;
    for (let j = i - k; j <= i + k; j += 1) {
      if (j === i) continue;
      if (candles[j]!.high >= candles[i]!.high) isHigh = false;
      if (candles[j]!.low <= candles[i]!.low) isLow = false;
    }
    if (isHigh) highs.push(i);
    if (isLow) lows.push(i);
  }
  return { highs, lows };
}

/**
 * Broad currency strength from the three majors with deep history.
 *
 * With EUR/USD, GBP/USD and USD/JPY log returns over the same window, the four
 * currency strengths are exactly determined once they are constrained to sum to
 * zero — no estimation, no fitting:
 *
 *   e - u = r(EURUSD),  g - u = r(GBPUSD),  u - j = r(USDJPY),  e+g+u+j = 0
 *   => u = -(r1 + r2 - r3) / 4
 *
 * Only four currencies are available because only these three pairs carry data
 * back to 2022; the eight-currency basket is not reconstructible here, and
 * pretending otherwise would invent information.
 */
export function currencyStrength(rEurUsd: number, rGbpUsd: number, rUsdJpy: number) {
  const usd = -(rEurUsd + rGbpUsd - rUsdJpy) / 4;
  return { usd, eur: usd + rEurUsd, gbp: usd + rGbpUsd, jpy: usd - rUsdJpy };
}

export interface OpportunityInput {
  candles15m: Candle[];
  candles1h: Candle[];
  spreadPips: number;
  pipSize: number;
  /** Minutes since the previous M15 bar; 15 when the series is intact. */
  gapMinutes: number;
  /** Gaps anywhere in the recent window, which would make the indicators stale. */
  missingInWindow: number;
}

export function detectEmaOpportunity(input: OpportunityInput, config: EmaOpportunityConfig = DEFAULT_EMA_OPPORTUNITY_CONFIG): EmaOpportunity {
  const candles = input.candles15m.filter((c) => c.complete);
  const no = (reason: string): EmaOpportunity => ({ verdict: "NO_OPPORTUNITY", reason, features: null });
  if (candles.length < config.minHistoryBars) return no("Insufficient history.");
  if (input.gapMinutes > 15.5 || input.missingInWindow > 0) return no("Stale or missing candles in the window.");

  const closes = candles.map((c) => c.close);
  const emaFast = calculateEmaValues(closes, config.emaFast).at(-1) ?? null;
  const emaSlow = calculateEmaValues(closes, config.emaSlow).at(-1) ?? null;
  const emaFastSeries = calculateEmaValues(closes, config.emaFast);
  const emaSlowSeries = calculateEmaValues(closes, config.emaSlow);
  const atr = calculateAtrValues(candles, config.atrPeriod).at(-1) ?? 0;
  if (emaFast === null || emaSlow === null || !(atr > 0)) return no("EMA or ATR unavailable.");

  const atrPips = atr / input.pipSize;
  if (atrPips < config.minAtrPips) return no("Volatility too low to be a real decision point.");
  if (input.spreadPips / atrPips > config.maxSpreadOverAtr) return no("Spread too large relative to ATR.");

  const last = candles.at(-1)!;
  const zoneLow = Math.min(emaFast, emaSlow) - atr * config.zonePadAtr;
  const zoneHigh = Math.max(emaFast, emaSlow) + atr * config.zonePadAtr;
  const interacting = last.low <= zoneHigh && last.high >= zoneLow;
  if (!interacting) return no("Price is not interacting with the EMA zone.");
  const distanceFast = Math.abs(last.close - emaFast) / atr;
  if (distanceFast > config.maxDistanceAtr) return no("Price is too far from the EMA zone.");

  // ---- absolute-terms context. Up is positive; no trade direction exists. ----
  const ret = (n: number) => { const p = closes.at(-1 - n); return p === undefined ? 0 : (last.close - p) / atr; };
  const slope = (series: Array<number | null>, n: number) => {
    const now = series.at(-1); const before = series.at(-1 - n);
    return now == null || before == null ? 0 : (now - before) / n / atr;
  };

  const atrSeries = calculateAtrValues(candles, config.atrPeriod).filter((v): v is number => typeof v === "number" && v > 0);
  const volPct = atrSeries.length ? atrSeries.filter((v) => v <= atr).length / atrSeries.length : 0.5;
  const atrBefore = atrSeries.at(-25) ?? atr;
  const rets24 = closes.slice(-25).map((c, i, a) => (i === 0 ? 0 : (c - a[i - 1]!) / a[i - 1]!)).slice(1);
  const meanRet = rets24.reduce((a, b) => a + b, 0) / (rets24.length || 1);
  const realizedVol = Math.sqrt(rets24.reduce((a, b) => a + (b - meanRet) ** 2, 0) / (rets24.length || 1));

  const w20 = candles.slice(-20); const w50 = candles.slice(-50);
  const hi20 = Math.max(...w20.map((c) => c.high)); const lo20 = Math.min(...w20.map((c) => c.low));
  const hi50 = Math.max(...w50.map((c) => c.high)); const lo50 = Math.min(...w50.map((c) => c.low));

  const { highs, lows } = swings(candles.slice(-60), 2);
  const recent = candles.slice(-60);
  const lastHigh = highs.length ? recent[highs.at(-1)!]!.high : hi20;
  const prevHigh = highs.length > 1 ? recent[highs.at(-2)!]!.high : lastHigh;
  const lastLow = lows.length ? recent[lows.at(-1)!]!.low : lo20;
  const prevLow = lows.length > 1 ? recent[lows.at(-2)!]!.low : lastLow;

  const range = last.high - last.low;
  const body = last.close - last.open;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  let consecutiveUp = 0; let consecutiveDown = 0;
  for (let i = candles.length - 1; i >= 0; i -= 1) { if (candles[i]!.close > candles[i]!.open) consecutiveUp += 1; else break; }
  for (let i = candles.length - 1; i >= 0; i -= 1) { if (candles[i]!.close < candles[i]!.open) consecutiveDown += 1; else break; }

  // Directional efficiency: net travel against total travel over 12 bars. High
  // means a clean one-way move, low means chop covering the same ground twice.
  const seg = closes.slice(-13);
  const gross = seg.slice(1).reduce((a, c, i) => a + Math.abs(c - seg[i]!), 0);
  const efficiency = gross > 0 ? (seg.at(-1)! - seg[0]!) / gross : 0;

  const h1Closes = input.candles1h.filter((c) => c.complete).map((c) => c.close);
  const h1Fast = calculateEmaValues(h1Closes, 20).at(-1) ?? null;
  const h1Slow = calculateEmaValues(h1Closes, 50).at(-1) ?? null;

  return {
    verdict: "OPPORTUNITY",
    reason: "Price is interacting with the EMA zone under usable conditions.",
    features: {
      emaFast, emaSlow, atr, atrPips, spreadPips: input.spreadPips, spreadOverAtr: input.spreadPips / atrPips,
      emaSeparationAtr: (emaFast - emaSlow) / atr,
      emaFastSlope: slope(emaFastSeries, 10), emaSlowSlope: slope(emaSlowSeries, 10),
      slopeAccel: slope(emaFastSeries, 5) - slope(emaFastSeries, 10),
      priceVsFastAtr: (last.close - emaFast) / atr,
      priceVsSlowAtr: (last.close - emaSlow) / atr,
      distanceToZoneAtr: last.close > zoneHigh ? (last.close - zoneHigh) / atr : last.close < zoneLow ? (last.close - zoneLow) / atr : 0,
      ret1: ret(1), ret3: ret(3), ret6: ret(6), ret12: ret(12), ret24: ret(24),
      retAccel: ret(3) - (ret(6) - ret(3)),
      efficiency,
      bodyOverAtr: body / atr, bodyOverRange: range > 0 ? body / range : 0,
      wickImbalance: range > 0 ? (upperWick - lowerWick) / range : 0,
      consecutiveUp, consecutiveDown,
      atrOverPrice: atr / last.close, realizedVol, volPct,
      volExpansion: atrBefore > 0 ? atr / atrBefore : 1,
      rangePos20: hi20 > lo20 ? (last.close - lo20) / (hi20 - lo20) : 0.5,
      rangePos50: hi50 > lo50 ? (last.close - lo50) / (hi50 - lo50) : 0.5,
      distToHigh20: (hi20 - last.close) / atr, distToLow20: (last.close - lo20) / atr,
      distToHigh50: (hi50 - last.close) / atr, distToLow50: (last.close - lo50) / atr,
      higherHigh: lastHigh > prevHigh ? 1 : 0, higherLow: lastLow > prevLow ? 1 : 0,
      lowerHigh: lastHigh < prevHigh ? 1 : 0, lowerLow: lastLow < prevLow ? 1 : 0,
      distFromLastSwingHigh: (lastHigh - last.close) / atr,
      distFromLastSwingLow: (last.close - lastLow) / atr,
      structureBreakUp: last.close > lastHigh ? 1 : 0,
      structureBreakDown: last.close < lastLow ? 1 : 0,
      h1EmaSeparationAtr: h1Fast !== null && h1Slow !== null ? (h1Fast - h1Slow) / atr : 0,
      h1Aligned: h1Fast !== null && h1Slow !== null ? (h1Fast > h1Slow ? 1 : -1) : 0,
    },
  };
}

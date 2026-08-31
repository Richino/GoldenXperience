/**
 * h1-direction-v1 — deterministic multi-category direction scorer.
 */
import type { Bar, Instrument } from "./data.js";
import {
  atrSeries, emaSeries, rsiSeries, macdSeries, slope, percentileRank,
  swingPoints, smaSeries, bollingerWidth, type Swing,
} from "./indicators.js";

export type StructureClass = "BULLISH_STRUCTURE" | "BEARISH_STRUCTURE" | "RANGE_STRUCTURE";
export type MomentumClass = "STRENGTHENING" | "WEAKENING" | "REVERSING" | "NEUTRAL";
export type VolatilityClass = "LOW" | "NORMAL" | "HIGH" | "EXPANDING" | "CONTRACTING";
export type MarketRegime = "TREND_UP" | "TREND_DOWN" | "RANGE" | "BREAKOUT" | "HIGH_VOLATILITY" | "LOW_VOLATILITY";
export type SignalDirection = "LONG" | "SHORT" | "WAIT";

export type FeatureSnapshot = {
  structure: StructureClass;
  momentum: MomentumClass;
  volatility: VolatilityClass;
  regime: MarketRegime;
  ema20: number;
  ema50: number;
  ema200: number;
  ema20Slope: number;
  ema50Slope: number;
  ema200Slope: number;
  rsi: number;
  macd: number;
  macdHist: number;
  atr: number;
  atrPctile: number;
  priceVsEma20: number;
  distSwingHighAtr: number;
  distSwingLowAtr: number;
  distMean20Atr: number;
  bosUp: boolean;
  bosDown: boolean;
};

export type ScoreBreakdown = {
  structure: number;
  emaTrend: number;
  momentum: number;
  volatility: number;
  priceLocation: number;
  regimeAdj: number;
};

export type ModelFlags = {
  useStructure: boolean;
  useEmaTrend: boolean;
  useMomentum: boolean;
  useVolatility: boolean;
  usePriceLocation: boolean;
  useRegimeAdj: boolean;
};

export const FULL_FLAGS: ModelFlags = {
  useStructure: true,
  useEmaTrend: true,
  useMomentum: true,
  useVolatility: true,
  usePriceLocation: true,
  useRegimeAdj: true,
};

const SWING_K = 3;
const STRUCTURE_BARS = 24;
const WARMUP = 250;

export type PairState = {
  bars: Bar[];
  closes: number[];
  ema20: number[];
  ema50: number[];
  ema200: number[];
  atr14: number[];
  rsi14: number[];
  macd: number[];
  macdHist: number[];
  mean20: number[];
  swings: Swing[];
};

export function buildPairState(bars: Bar[]): PairState {
  const closes = bars.map((b) => b.close);
  const { macd, hist } = macdSeries(closes);
  return {
    bars,
    closes,
    ema20: emaSeries(closes, 20),
    ema50: emaSeries(closes, 50),
    ema200: emaSeries(closes, 200),
    atr14: atrSeries(bars, 14),
    rsi14: rsiSeries(closes, 14),
    macd,
    macdHist: hist,
    mean20: smaSeries(closes, 20),
    swings: swingPoints(bars, SWING_K),
  };
}

export function minWarmupIndex(): number {
  return WARMUP;
}

function causalSwings(swings: Swing[], i: number): Swing[] {
  return swings.filter((s) => s.index + SWING_K <= i);
}

function classifyStructureState(state: PairState, i: number) {
  const window = state.bars.slice(Math.max(0, i - STRUCTURE_BARS + 1), i + 1);
  const half = Math.floor(window.length / 2);
  const earlier = window.slice(0, half);
  const recent = window.slice(half);
  if (earlier.length < 4 || recent.length < 4) return { cls: "RANGE_STRUCTURE" as StructureClass, bosUp: false, bosDown: false, score: 0 };

  const hh = Math.max(...recent.map((b) => b.high)) > Math.max(...earlier.map((b) => b.high));
  const hl = Math.min(...recent.map((b) => b.low)) > Math.min(...earlier.map((b) => b.low));
  const lh = Math.max(...recent.map((b) => b.high)) < Math.max(...earlier.map((b) => b.high));
  const ll = Math.min(...recent.map((b) => b.low)) < Math.min(...earlier.map((b) => b.low));

  const swings = causalSwings(state.swings, i);
  const lastHigh = swings.filter((s) => s.kind === "high").at(-1)?.price ?? state.bars[i]!.high;
  const lastLow = swings.filter((s) => s.kind === "low").at(-1)?.price ?? state.bars[i]!.low;
  const close = state.bars[i]!.close;
  const bosUp = close > lastHigh;
  const bosDown = close < lastLow;

  if (hh && hl) return { cls: "BULLISH_STRUCTURE" as StructureClass, bosUp, bosDown, score: bosUp ? 0.25 : 0.18 };
  if (lh && ll) return { cls: "BEARISH_STRUCTURE" as StructureClass, bosUp, bosDown, score: bosDown ? -0.25 : -0.18 };
  if (bosUp) return { cls: "BULLISH_STRUCTURE" as StructureClass, bosUp, bosDown, score: 0.12 };
  if (bosDown) return { cls: "BEARISH_STRUCTURE" as StructureClass, bosUp, bosDown, score: -0.12 };
  return { cls: "RANGE_STRUCTURE" as StructureClass, bosUp, bosDown, score: 0 };
}

function classifyMomentum(
  rsi: number, rsiPrev: number, hist: number, histPrev: number,
  roc: number, bodyMom: number, trendSign: number,
): { cls: MomentumClass; score: number } {
  const rsiDelta = rsi - rsiPrev;
  const histDelta = hist - histPrev;
  let score = 0;
  if (trendSign > 0) {
    if (roc > 0 && bodyMom > 0 && rsiDelta > 0 && histDelta > 0) score = 0.20;
    else if (roc > 0 && hist > 0) score = 0.12;
    else if (roc < 0 && histDelta < 0) score = -0.08;
    else if (rsi > 70 && histDelta < 0) score = -0.10;
    else score = 0.04;
  } else if (trendSign < 0) {
    if (roc < 0 && bodyMom < 0 && rsiDelta < 0 && histDelta < 0) score = -0.20;
    else if (roc < 0 && hist < 0) score = -0.12;
    else if (roc > 0 && histDelta > 0) score = 0.08;
    else if (rsi < 30 && histDelta > 0) score = 0.10;
    else score = -0.04;
  } else {
    score = Math.max(-0.06, Math.min(0.06, roc * 0.5 + bodyMom * 0.5));
  }

  let cls: MomentumClass = "NEUTRAL";
  if (Math.sign(roc) === Math.sign(hist) && Math.sign(histDelta) === Math.sign(hist)) cls = "STRENGTHENING";
  else if (Math.sign(roc) !== Math.sign(hist)) cls = "REVERSING";
  else if (Math.abs(histDelta) < 1e-9 && Math.abs(roc) < 0.05) cls = "NEUTRAL";
  else cls = "WEAKENING";
  return { cls, score };
}

function classifyVolatility(
  atrPct: number, atrPrevPct: number, bbWidth: number, bbPrev: number,
): { cls: VolatilityClass; score: number } {
  let cls: VolatilityClass = "NORMAL";
  if (atrPct >= 0.85) cls = "HIGH";
  else if (atrPct <= 0.15) cls = "LOW";
  else if (atrPct > atrPrevPct + 0.08) cls = "EXPANDING";
  else if (atrPct < atrPrevPct - 0.08) cls = "CONTRACTING";

  let score = 0;
  if (cls === "EXPANDING") score = 0.06;
  else if (cls === "CONTRACTING") score = -0.04;
  else if (cls === "HIGH") score = 0.02;
  else if (cls === "LOW") score = -0.02;
  if (bbWidth > bbPrev * 1.15) score += 0.04;
  return { cls, score };
}

function classifyRegime(
  structure: StructureClass, vol: VolatilityClass,
  emaAlignBull: boolean, emaAlignBear: boolean,
  bosUp: boolean, bosDown: boolean,
): MarketRegime {
  if (vol === "HIGH" || vol === "EXPANDING") return "HIGH_VOLATILITY";
  if (vol === "LOW" || vol === "CONTRACTING") return "LOW_VOLATILITY";
  if (bosUp || bosDown) return "BREAKOUT";
  if (structure === "BULLISH_STRUCTURE" && emaAlignBull) return "TREND_UP";
  if (structure === "BEARISH_STRUCTURE" && emaAlignBear) return "TREND_DOWN";
  return "RANGE";
}

function priceLocationScore(
  structure: StructureClass, bosUp: boolean, bosDown: boolean,
  distHigh: number, distLow: number, distMean: number,
): number {
  let score = 0;
  if (structure === "BULLISH_STRUCTURE") {
    if (distLow < 1.2 && distHigh > 1.5) score += 0.12;
    else if (distHigh < 0.8) score -= 0.10;
    else if (distMean > -0.5 && distMean < 0.5) score += 0.06;
  } else if (structure === "BEARISH_STRUCTURE") {
    if (distHigh < 1.2 && distLow > 1.5) score -= 0.12;
    else if (distLow < 0.8) score += 0.10;
    else if (distMean > -0.5 && distMean < 0.5) score -= 0.06;
  }
  if (bosUp) score += 0.08;
  if (bosDown) score -= 0.08;
  return Math.max(-0.15, Math.min(0.15, score));
}

function emaTrendScore(
  close: number, ema20: number, ema50: number, ema200: number,
  s20: number, s50: number, s200: number, atr: number,
): number {
  if (atr <= 0) return 0;
  const n20 = s20 / atr, n50 = s50 / atr, n200 = s200 / atr;
  let score = 0;
  const bullStack = close > ema20 && ema20 > ema50 && ema50 > ema200;
  const bearStack = close < ema20 && ema20 < ema50 && ema50 < ema200;
  if (bullStack && n20 > 0 && n50 > 0) score = 0.20;
  else if (bearStack && n20 < 0 && n50 < 0) score = -0.20;
  else {
    if (close > ema20) score += 0.06;
    if (close < ema20) score -= 0.06;
    if (ema20 > ema50) score += 0.05;
    if (ema20 < ema50) score -= 0.05;
    if (ema50 > ema200) score += 0.04;
    if (ema50 < ema200) score -= 0.04;
    score += Math.max(-0.05, Math.min(0.05, n20 * 0.5));
  }
  if (n200 > 0 && score > 0) score += Math.min(0.03, n200 * 0.2);
  if (n200 < 0 && score < 0) score += Math.max(-0.03, n200 * 0.2);
  return Math.max(-0.20, Math.min(0.20, score));
}

function regimeAdjustment(regime: MarketRegime, rawScore: number): number {
  switch (regime) {
    case "TREND_UP": return rawScore > 0 ? 0.05 : -0.03;
    case "TREND_DOWN": return rawScore < 0 ? -0.05 : 0.03;
    case "BREAKOUT": return Math.sign(rawScore) * 0.04;
    case "RANGE": return -Math.abs(rawScore) * 0.08;
    case "HIGH_VOLATILITY": return -Math.abs(rawScore) * 0.04;
    case "LOW_VOLATILITY": return -Math.abs(rawScore) * 0.06;
    default: {
      const _x: never = regime;
      return _x;
    }
  }
}

export function scoreDirectionAt(state: PairState, i: number, flags: ModelFlags = FULL_FLAGS): {
  score: number;
  direction: SignalDirection;
  features: FeatureSnapshot;
  breakdown: ScoreBreakdown;
} | null {
  if (i < WARMUP || i >= state.bars.length) return null;
  const atr = state.atr14[i]!;
  if (!Number.isFinite(atr) || atr <= 0) return null;

  const close = state.bars[i]!.close;
  const ema20 = state.ema20[i]!, ema50 = state.ema50[i]!, ema200 = state.ema200[i]!;
  const s20 = slope(state.ema20.slice(i - 11, i + 1));
  const s50 = slope(state.ema50.slice(i - 11, i + 1));
  const s200 = slope(state.ema200.slice(i - 23, i + 1));
  const atrPct = percentileRank(state.atr14, i, 100);
  const bb = bollingerWidth(state.closes, i, 20);
  const bbPrev = bollingerWidth(state.closes, i - 5, 20);

  const str = classifyStructureState(state, i);
  const swings = causalSwings(state.swings, i);
  const lastHigh = swings.filter((s) => s.kind === "high").at(-1)?.price ?? close;
  const lastLow = swings.filter((s) => s.kind === "low").at(-1)?.price ?? close;
  const roc = (close - state.bars[i - 4]!.close) / atr;
  const bodyMom = (state.bars[i]!.close - state.bars[i]!.open) / atr;
  const trendSign = close > ema50 ? 1 : close < ema50 ? -1 : 0;
  const mom = classifyMomentum(state.rsi14[i]!, state.rsi14[i - 1]!, state.macdHist[i]!, state.macdHist[i - 1]!, roc, bodyMom, trendSign);
  const vol = classifyVolatility(atrPct, percentileRank(state.atr14, i - 5, 100), bb, bbPrev);
  const emaAlignBull = close > ema20 && ema20 > ema50 && ema50 > ema200;
  const emaAlignBear = close < ema20 && ema20 < ema50 && ema50 < ema200;
  const regime = classifyRegime(str.cls, vol.cls, emaAlignBull, emaAlignBear, str.bosUp, str.bosDown);
  const distHigh = (lastHigh - close) / atr;
  const distLow = (close - lastLow) / atr;
  const distMean = (close - state.mean20[i]!) / atr;

  const structureScore = flags.useStructure ? str.score : 0;
  const emaTrend = flags.useEmaTrend ? emaTrendScore(close, ema20, ema50, ema200, s20, s50, s200, atr) : 0;
  const momentumScore = flags.useMomentum ? mom.score : 0;
  const volatilityScore = flags.useVolatility ? vol.score : 0;
  const priceLoc = flags.usePriceLocation ? priceLocationScore(str.cls, str.bosUp, str.bosDown, distHigh, distLow, distMean) : 0;

  let raw = structureScore + emaTrend + momentumScore + volatilityScore + priceLoc;
  raw = Math.max(-1, Math.min(1, raw));
  const regimeAdj = flags.useRegimeAdj ? regimeAdjustment(regime, raw) : 0;
  const score = Math.max(-1, Math.min(1, raw + regimeAdj));

  const features: FeatureSnapshot = {
    structure: str.cls,
    momentum: mom.cls,
    volatility: vol.cls,
    regime,
    ema20, ema50, ema200,
    ema20Slope: s20, ema50Slope: s50, ema200Slope: s200,
    rsi: state.rsi14[i]!, macd: state.macd[i]!, macdHist: state.macdHist[i]!,
    atr, atrPctile: atrPct,
    priceVsEma20: (close - ema20) / atr,
    distSwingHighAtr: distHigh,
    distSwingLowAtr: distLow,
    distMean20Atr: distMean,
    bosUp: str.bosUp, bosDown: str.bosDown,
  };

  let direction: SignalDirection = "WAIT";
  if (score >= 0.60) direction = "LONG";
  else if (score <= -0.60) direction = "SHORT";

  return {
    score,
    direction,
    features,
    breakdown: { structure: structureScore, emaTrend, momentum: momentumScore, volatility: volatilityScore, priceLocation: priceLoc, regimeAdj },
  };
}

export function scoreDirection(bars: Bar[], i: number, flags: ModelFlags = FULL_FLAGS) {
  return scoreDirectionAt(buildPairState(bars), i, flags);
}

export function directionFromScore(score: number, threshold = 0.60): SignalDirection {
  if (score >= threshold) return "LONG";
  if (score <= -threshold) return "SHORT";
  return "WAIT";
}

export function baselinePreviousCandle(bars: Bar[], i: number): SignalDirection {
  if (i < 1) return "WAIT";
  const prev = bars[i - 1]!, cur = bars[i]!;
  if (prev.close === cur.close) return "WAIT";
  return prev.close < cur.close ? "LONG" : "SHORT";
}

export function baselineEmaSlope(state: PairState, i: number): SignalDirection {
  const s = slope(state.ema20.slice(Math.max(0, i - 11), i + 1));
  if (Math.abs(s) < 1e-12) return "WAIT";
  return s > 0 ? "LONG" : "SHORT";
}

export function baselineEmaCross(state: PairState, i: number): SignalDirection {
  return state.ema20[i]! > state.ema50[i]! ? "LONG" : "SHORT";
}

export function pairLabel(pair: Instrument): string {
  return pair.replace("_", "/");
}

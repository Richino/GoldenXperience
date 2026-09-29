import { classifyRegime, DEFAULT_REGIME_CONFIG } from "@/lib/strategy/regime";
import type { MarketRegime } from "@/lib/strategy/types";
import type { Candle, MajorInstrument } from "@/types/forex";

/**
 * Pair strength for the pair picker: one trend pill per pair, plus which of
 * its currencies stand out.
 *
 * The pill combines two speeds so a normal dip does not read as "no trend":
 *
 * - Trend (slow): the shared regime classifier over 50 completed 1H candles
 *   (~2 trading days) sets the direction — R² of a straight-line fit plus
 *   enough travel to count as a trend.
 * - Now (fast): the last 16 completed 15m candles (4 hours), their net move
 *   scaled by 15m ATR, say what price is doing inside that trend. It moves
 *   every 15 minutes, so a trend breaking — or a sharp new move where there
 *   was no trend — shows as "turning" within hours.
 *
 * Currency strength reads the last 50 completed 15m candles: each pair's net
 * move in ATRs is credited to its base and debited from its quote, then
 * averaged per currency across every pair that contains it.
 *
 * Deterministic and descriptive: it reads what price did, not what it will do.
 */

export type TrendGrade = "strong" | "pullback" | "turning" | "weak" | "range";
export type CurrencyTier = "strong" | "neutral" | "weak";

export interface PairTrendRead {
  grade: TrendGrade;
  /**
   * The trend's direction for "strong" and "pullback"; the new move's
   * direction for "turning"; null for "weak" and "range".
   */
  direction: "up" | "down" | null;
  /** R² of the 1H trend fit, 0 (chop) to 1 (a clean line). */
  score: number;
  /** Net move over the last 4 hours in 15m ATRs; + is up. Null without data. */
  recentMoveAtr: number | null;
}

export interface CurrencyStrength {
  currency: string;
  /** Average ATR-scaled move across this currency's pairs; + is strong. */
  score: number;
  /** 1 is the strongest currency. */
  rank: number;
  tier: CurrencyTier;
  /** How many pairs fed the average. */
  pairCount: number;
}

export interface PairStrength {
  instrument: MajorInstrument;
  trend: PairTrendRead;
  base: CurrencyStrength | null;
  quote: CurrencyStrength | null;
}

export interface PairStrengthSnapshot {
  evaluatedAt: string;
  lookbackBars: number;
  pairs: PairStrength[];
  currencies: CurrencyStrength[];
}

export interface PairCandles {
  m15: Candle[];
  h1: Candle[];
}

/** The fast window: 16 × 15m = 4 hours. */
const RECENT_BARS = 16;
/** Moving with the trend by at least this many 15m ATRs is "strong"; less is a pullback. */
const MOVING_WITH_TREND_ATR = 0.5;
/** A 4h move of at least this many 15m ATRs (against the trend, or with no trend)... */
const TURNING_AGAINST_ATR = 2;
/** ...in a reasonably clean line (R² of the 4h closes) is "turning". */
const TURNING_MIN_R2 = 0.5;
/** A currency needs at least this average move (in ATRs) to be called strong or weak... */
const CURRENCY_TIER_MIN_SCORE = 1;
/** ...and must sit in the top or bottom this-many ranks... */
const CURRENCY_TIER_RANKS = 3;
/** ...across at least this many pairs: one pair is just that pair's own move. */
const CURRENCY_TIER_MIN_PAIRS = 2;

function completedOf(candles: Candle[]) {
  return candles.filter((candle) => candle.complete);
}

/** Net move over the last `bars` completed candles in ATRs, or null without enough history. */
function scaledMove(completed: Candle[], bars: number, atr: number | null) {
  if (!atr || atr <= 0 || completed.length <= bars) return null;
  return (completed.at(-1)!.close - completed[completed.length - 1 - bars]!.close) / atr;
}

/** R² of a straight-line fit through the closes. */
function straightness(closes: number[]) {
  const n = closes.length;
  if (n < 3) return 0;
  const meanX = (n - 1) / 2;
  const meanY = closes.reduce((sum, value) => sum + value, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = index - meanX;
    const dy = closes[index]! - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
}

function gradeTrend(trend: MarketRegime, recent: MarketRegime, m15: Candle[]): PairTrendRead {
  const score = trend.trendStrength;
  const recentMoveAtr = scaledMove(m15, RECENT_BARS, recent.atr);
  const recentR2 = straightness(m15.slice(-(RECENT_BARS + 1)).map((candle) => candle.close));
  const sharpRecentMove =
    recentMoveAtr !== null && Math.abs(recentMoveAtr) >= TURNING_AGAINST_ATR && recentR2 >= TURNING_MIN_R2;

  if (trend.regime !== "trending" || trend.trendDirection === "none") {
    // No 2-day trend yet, but a sharp, clean 4h move is a new one starting —
    // the early read this badge exists for, not a range.
    if (sharpRecentMove) {
      return { grade: "turning", direction: recentMoveAtr > 0 ? "up" : "down", score, recentMoveAtr };
    }
    return { grade: trend.regime === "ranging" ? "range" : "weak", direction: null, score, recentMoveAtr };
  }

  const direction = trend.trendDirection;
  if (recentMoveAtr === null) return { grade: "strong", direction, score, recentMoveAtr };

  const withTrend = direction === "up" ? recentMoveAtr : -recentMoveAtr;
  if (withTrend < 0 && sharpRecentMove) {
    return { grade: "turning", direction: direction === "up" ? "down" : "up", score, recentMoveAtr };
  }
  return {
    grade: withTrend >= MOVING_WITH_TREND_ATR ? "strong" : "pullback",
    direction,
    score,
    recentMoveAtr,
  };
}

export function computePairStrength(
  candlesByPair: Partial<Record<MajorInstrument, PairCandles>>,
  evaluatedAt: string,
): PairStrengthSnapshot {
  const lookbackBars = DEFAULT_REGIME_CONFIG.lookbackBars;
  const sums = new Map<string, { total: number; count: number }>();
  const trends = new Map<MajorInstrument, PairTrendRead>();

  for (const [instrument, candles] of Object.entries(candlesByPair)) {
    if (!candles?.m15.length || !candles.h1.length) continue;
    const m15 = completedOf(candles.m15);
    const trend = classifyRegime(instrument, candles.h1, evaluatedAt, DEFAULT_REGIME_CONFIG);
    const recent = classifyRegime(instrument, candles.m15, evaluatedAt, DEFAULT_REGIME_CONFIG);
    trends.set(instrument, gradeTrend(trend, recent, m15));

    const [base, quote] = instrument.split("_");
    if (!base || !quote) continue;
    const move = scaledMove(m15, lookbackBars, recent.atr);
    if (move === null) continue;
    for (const [currency, signed] of [[base, move], [quote, -move]] as const) {
      const entry = sums.get(currency) ?? { total: 0, count: 0 };
      entry.total += signed;
      entry.count += 1;
      sums.set(currency, entry);
    }
  }

  const ranked = [...sums.entries()]
    .map(([currency, { total, count }]) => ({ currency, score: total / count, pairCount: count }))
    .sort((left, right) => right.score - left.score);
  const currencies: CurrencyStrength[] = ranked.map((entry, index) => {
    const rank = index + 1;
    const tier: CurrencyTier =
      entry.pairCount < CURRENCY_TIER_MIN_PAIRS
        ? "neutral"
        : entry.score >= CURRENCY_TIER_MIN_SCORE && rank <= CURRENCY_TIER_RANKS
        ? "strong"
        : entry.score <= -CURRENCY_TIER_MIN_SCORE && rank > ranked.length - CURRENCY_TIER_RANKS
        ? "weak"
        : "neutral";
    return { ...entry, rank, tier };
  });
  const byCurrency = new Map(currencies.map((entry) => [entry.currency, entry]));

  const pairs: PairStrength[] = [...trends.entries()].map(([instrument, trend]) => {
    const [base, quote] = instrument.split("_");
    return {
      instrument,
      trend,
      base: (base && byCurrency.get(base)) || null,
      quote: (quote && byCurrency.get(quote)) || null,
    };
  });

  return { evaluatedAt, lookbackBars, pairs, currencies };
}

/**
 * EUR/USD per-pair engine.
 *
 * Stage 1: big-move gate (reuses evaluateEurUsdMoveGateV1).
 * Stage 2: direction, decided from three inputs — regime, HTF bias, structure.
 *   - regime: what kind of market (trending / ranging / chop) — context only.
 *   - htfBias: which way the H1 timeframe is leaning.
 *   - structure: swing HH/HL vs LH/LL on M15.
 * The combiner rules are documented in `decideDirection` below.
 *
 * Pure function. No I/O, no clock, no DB. Backtest and live cycle both call it.
 */
import type { Candle } from "../../frontend/src/types/forex.js";
import { calculateEmaValues, calculateAtrValues } from "../../frontend/src/lib/strategy/indicators.js";
import {
  evaluateEurUsdMoveGateV1,
  type EurUsdMoveGateDecision,
} from "./eur-usd-move-gate-v1.js";

export const EUR_USD_ENGINE = {
  instrument: "EUR_USD",
  version: "eur-usd-engine-v1",
} as const;

export type Direction = "long" | "short";
export type DirectionVote = Direction | "undecided";
export type Regime = "trending" | "ranging" | "chop";

export type RegimeAssessment = { regime: Regime; strength: number; reason: string };
export type DirectionSignal = { vote: DirectionVote; confidence: number; reason: string };

export type EurUsdEngineAction = "TRADE" | "MOVE_NO_DIRECTION" | "WAIT";

export type EurUsdEngineDecision = {
  version: typeof EUR_USD_ENGINE.version;
  observedAt: string | null;
  action: EurUsdEngineAction;
  direction: Direction | null;
  gate: EurUsdMoveGateDecision;
  regime: RegimeAssessment | null;
  htfBias: DirectionSignal | null;
  structure: DirectionSignal | null;
  combinedConfidence: number | null;
  reason: string;
};

export type EurUsdEngineInput = {
  instrument: string;
  candles: Candle[];
  bid: number;
  ask: number;
};

// --- Regime ----------------------------------------------------------------

const REGIME_MIN_CANDLES = 60;

/**
 * Trending: EMA20/EMA50 gap >= 0.8 ATR (a persistent one-way pressure).
 * Chop: last 20 bars' range < 3 ATR AND gap < 0.3 ATR (tight, directionless).
 * Ranging: everything else — market is moving but not trending.
 */
export function classifyRegime(input: EurUsdEngineInput): RegimeAssessment | null {
  const completed = input.candles.filter((c) => c.complete);
  if (completed.length < REGIME_MIN_CANDLES) return null;
  const closes = completed.map((c) => c.close);
  const fast = calculateEmaValues(closes, 20).at(-1);
  const slow = calculateEmaValues(closes, 50).at(-1);
  const atr = calculateAtrValues(completed, 14).at(-1);
  if (fast == null || slow == null || !(atr && atr > 0)) return null;
  const gapAtr = Math.abs(fast - slow) / atr;
  const recent = completed.slice(-20);
  const rangeAtr = (Math.max(...recent.map((c) => c.high)) - Math.min(...recent.map((c) => c.low))) / atr;
  if (gapAtr >= 0.8) return { regime: "trending", strength: Math.min(1, gapAtr / 2), reason: `gap_${gapAtr.toFixed(2)}atr` };
  if (rangeAtr < 3 && gapAtr < 0.3) return { regime: "chop", strength: 1 - rangeAtr / 3, reason: `range_${rangeAtr.toFixed(2)}atr` };
  return { regime: "ranging", strength: Math.min(1, rangeAtr / 6), reason: `range_${rangeAtr.toFixed(2)}atr_gap_${gapAtr.toFixed(2)}` };
}

// --- HTF bias (H1 resampled from M15) --------------------------------------

/**
 * Resample the last N complete M15 candles into H1 candles. Requires an M15
 * candle at each :00/:15/:30/:45 boundary; incomplete H1s are dropped.
 */
function resampleToH1(m15: Candle[]): Candle[] {
  const buckets = new Map<number, Candle[]>();
  for (const c of m15) {
    const t = Date.parse(c.time);
    const hourStart = t - (t % (60 * 60_000));
    const arr = buckets.get(hourStart) ?? [];
    arr.push(c);
    buckets.set(hourStart, arr);
  }
  const out: Candle[] = [];
  for (const [hourStart, group] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (group.length !== 4) continue;
    group.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    out.push({
      time: new Date(hourStart).toISOString(),
      open: group[0]!.open,
      high: Math.max(...group.map((g) => g.high)),
      low: Math.min(...group.map((g) => g.low)),
      close: group[3]!.close,
      volume: group.reduce((s, g) => s + (g.volume ?? 0), 0),
      complete: true,
    });
  }
  return out;
}

const HTF_MIN_H1 = 60;
const HTF_SLOPE_LOOKBACK = 3;

export function htfBiasVoter(input: EurUsdEngineInput): DirectionSignal {
  const m15 = input.candles.filter((c) => c.complete);
  const h1 = resampleToH1(m15);
  if (h1.length < HTF_MIN_H1) return { vote: "undecided", confidence: 0, reason: "insufficient_h1_history" };
  const closes = h1.map((c) => c.close);
  const ema20 = calculateEmaValues(closes, 20);
  const ema50 = calculateEmaValues(closes, 50);
  const atr = calculateAtrValues(h1, 14).at(-1);
  const fast = ema20.at(-1);
  const slow = ema50.at(-1);
  const fastPrev = ema20.at(-1 - HTF_SLOPE_LOOKBACK);
  if (fast == null || slow == null || fastPrev == null || !(atr && atr > 0)) {
    return { vote: "undecided", confidence: 0, reason: "h1_indicator_warmup" };
  }
  const slope = (fast - fastPrev) / HTF_SLOPE_LOOKBACK; // price per H1 bar
  const gapAtr = (fast - slow) / atr;
  if (gapAtr > 0.15 && slope > 0) {
    const confidence = Math.min(1, Math.abs(gapAtr) / 1.5);
    return { vote: "long", confidence, reason: `h1_gap_${gapAtr.toFixed(2)}atr_up` };
  }
  if (gapAtr < -0.15 && slope < 0) {
    const confidence = Math.min(1, Math.abs(gapAtr) / 1.5);
    return { vote: "short", confidence, reason: `h1_gap_${gapAtr.toFixed(2)}atr_down` };
  }
  return { vote: "undecided", confidence: 0, reason: "h1_no_bias" };
}

// --- Structure (M15 swing HH/HL) -------------------------------------------

const STRUCTURE_WINDOW = 40; // last 40 M15 bars (~10h)
const STRUCTURE_PIVOT = 3; // n-bar swing (3 lower highs / lower lows on each side)

function findPivots(candles: Candle[], n: number): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = n; i < candles.length - n; i++) {
    const c = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= n; k++) {
      if (candles[i - k]!.high >= c.high || candles[i + k]!.high >= c.high) isHigh = false;
      if (candles[i - k]!.low <= c.low || candles[i + k]!.low <= c.low) isLow = false;
    }
    if (isHigh) highs.push(c.high);
    if (isLow) lows.push(c.low);
  }
  return { highs, lows };
}

export function structureVoter(input: EurUsdEngineInput): DirectionSignal {
  const completed = input.candles.filter((c) => c.complete);
  if (completed.length < STRUCTURE_WINDOW) return { vote: "undecided", confidence: 0, reason: "insufficient_structure_history" };
  const window = completed.slice(-STRUCTURE_WINDOW);
  const { highs, lows } = findPivots(window, STRUCTURE_PIVOT);
  if (highs.length < 2 || lows.length < 2) return { vote: "undecided", confidence: 0, reason: "too_few_pivots" };
  const lastTwoHighs = highs.slice(-2);
  const lastTwoLows = lows.slice(-2);
  const higherHighs = lastTwoHighs[1]! > lastTwoHighs[0]!;
  const higherLows = lastTwoLows[1]! > lastTwoLows[0]!;
  const lowerHighs = lastTwoHighs[1]! < lastTwoHighs[0]!;
  const lowerLows = lastTwoLows[1]! < lastTwoLows[0]!;
  if (higherHighs && higherLows) return { vote: "long", confidence: 0.8, reason: "hh_hl" };
  if (lowerHighs && lowerLows) return { vote: "short", confidence: 0.8, reason: "lh_ll" };
  if (higherHighs || higherLows) return { vote: "long", confidence: 0.4, reason: "partial_up" };
  if (lowerHighs || lowerLows) return { vote: "short", confidence: 0.4, reason: "partial_down" };
  return { vote: "undecided", confidence: 0, reason: "no_structure" };
}

// --- Combine ---------------------------------------------------------------

/**
 * Regime-aware direction rule:
 *  trending: HTF and structure must agree → trade with that direction.
 *            Disagree → undecided (mixed signal in a trend is a trap).
 *  ranging:  fade HTF only if structure disagrees with HTF (a range failure of
 *            the higher timeframe). Otherwise undecided.
 *  chop:     always undecided.
 */
export function decideDirection(
  regime: RegimeAssessment | null,
  htf: DirectionSignal,
  structure: DirectionSignal,
): { direction: Direction | null; confidence: number; reason: string } {
  if (regime == null) return { direction: null, confidence: 0, reason: "regime_unknown" };
  if (regime.regime === "chop") return { direction: null, confidence: 0, reason: "chop" };

  if (regime.regime === "trending") {
    if (htf.vote === "undecided" || structure.vote === "undecided") return { direction: null, confidence: 0, reason: "trending_missing_signal" };
    if (htf.vote !== structure.vote) return { direction: null, confidence: 0, reason: "trending_signals_disagree" };
    const confidence = Math.min(1, 0.5 * (htf.confidence + structure.confidence) * (0.5 + regime.strength * 0.5));
    return { direction: htf.vote, confidence, reason: `trending_agree_${htf.vote}` };
  }

  // ranging → fade HTF only if structure disagrees
  if (htf.vote === "undecided" || structure.vote === "undecided") return { direction: null, confidence: 0, reason: "ranging_missing_signal" };
  if (htf.vote === structure.vote) return { direction: null, confidence: 0, reason: "ranging_agree_no_fade" };
  const fadeDirection: Direction = structure.vote; // fade HTF = follow structure
  const confidence = Math.min(1, 0.4 * structure.confidence * (0.5 + regime.strength * 0.5));
  return { direction: fadeDirection, confidence, reason: `ranging_fade_htf_${fadeDirection}` };
}

// --- Engine ---------------------------------------------------------------

export function runEurUsdEngine(input: EurUsdEngineInput): EurUsdEngineDecision {
  const gate = evaluateEurUsdMoveGateV1(input);

  if (gate.action !== "MOVE") {
    return {
      version: EUR_USD_ENGINE.version,
      observedAt: gate.observedAt,
      action: "WAIT",
      direction: null,
      gate,
      regime: null,
      htfBias: null,
      structure: null,
      combinedConfidence: null,
      reason: `gate_${gate.reason}`,
    };
  }

  const regime = classifyRegime(input);
  const htfBias = htfBiasVoter(input);
  const structure = structureVoter(input);
  const combined = decideDirection(regime, htfBias, structure);

  if (combined.direction === null) {
    return {
      version: EUR_USD_ENGINE.version,
      observedAt: gate.observedAt,
      action: "MOVE_NO_DIRECTION",
      direction: null,
      gate,
      regime,
      htfBias,
      structure,
      combinedConfidence: combined.confidence,
      reason: combined.reason,
    };
  }

  return {
    version: EUR_USD_ENGINE.version,
    observedAt: gate.observedAt,
    action: "TRADE",
    direction: combined.direction,
    gate,
    regime,
    htfBias,
    structure,
    combinedConfidence: combined.confidence,
    reason: combined.reason,
  };
}

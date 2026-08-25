/**
 * Eight-family movement + delayed-direction research primitives.
 *
 * RESEARCH ONLY. This module is never imported by paper-cycle, the strategy
 * registry, the live executable allowlist, or practice execution. The existing
 * four production detectors remain the source of their setup/original-direction
 * controls. Four additional detectors are deliberately isolated here until
 * evidence can justify promoting any of them.
 */
import { calculateAtrValues, calculateEmaValues, calculateRsiValues } from "../../frontend/src/lib/strategy/indicators.js";
import { classifyRegime } from "../../frontend/src/lib/strategy/regime.js";
import { evaluateAllStrategies } from "../../frontend/src/lib/strategy/strategies/index.js";
import type { StrategyCandidate } from "../../frontend/src/lib/strategy/strategy.js";
import type { MarketRegime, StrategyEvaluationInput } from "../../frontend/src/lib/strategy/types.js";
import type { Candle, MajorInstrument } from "../../frontend/src/types/forex.js";
import type { DirectionalAction } from "./adaptive-engine.js";
export {
  DEFAULT_DIRECTIONAL_ADAPTIVE_CONFIG,
  STRICT_DIRECTIONAL_CONFIDENCE_CONFIG,
  createDirectionalEvidenceStore,
  decideDirectionalAction,
  recordDirectionalEvidence,
} from "./adaptive-engine.js";
export type { DirectionalAction, DirectionalAdaptiveConfig, DirectionalDecision, DirectionalEvidenceStore } from "./adaptive-engine.js";

export const EIGHT_DIRECTIONAL_FAMILIES = [
  "ema",
  "breakout",
  "momentum",
  "meanrev",
  "scalping_continuation",
  "momentum_exhaustion",
  "intraday_breakout",
  "intraday_trend_retracement",
] as const;

export type DirectionalFamily = (typeof EIGHT_DIRECTIONAL_FAMILIES)[number];
export type TradeDirection = "long" | "short";
export type ConfirmedDirection = TradeDirection | "uncertain";

export interface ResearchQuote {
  closeTime: string;
  bidOpen: number;
  bidHigh: number;
  bidLow: number;
  bidClose: number;
  askOpen: number;
  askHigh: number;
  askLow: number;
  askClose: number;
}

export interface ResearchTradePlan {
  direction: TradeDirection;
  entry: number;
  stop: number;
  target: number;
}

export interface ResearchSetupCandidate {
  family: DirectionalFamily;
  version: string;
  instrument: MajorInstrument;
  timeframe: "M15" | "M15_PROXY";
  setupIndex: number;
  setupTime: string;
  setupQualified: boolean;
  originalDirection: TradeDirection | null;
  originalPlan: ResearchTradePlan | null;
  setupMetadata: Record<string, number | string | boolean | null>;
  regime: MarketRegime;
  atr: number;
  atrPips: number;
  spreadPips: number;
}

export interface MovementEstimate {
  version: "movement-heuristic-v1";
  movementProbability: number;
  expectedMoveAtr: number;
  movementStrength: number;
  qualified: boolean;
  costAtr: number;
  volatilityExpansion: number;
  compressionRelease: number;
  velocityAtr: number;
}

export interface DirectionConfirmation {
  version: "range-close-hold-v1";
  direction: ConfirmedDirection;
  directionConfidence: number;
  confirmationType: "range_close" | "range_close_hold" | "none";
  breakoutStrength: number;
  heldBreakout: boolean;
  structureDirection: ConfirmedDirection;
  confirmationDelayBars: number | null;
  knownAtIndex: number | null;
  entryIndex: number | null;
  localRangeHigh: number;
  localRangeLow: number;
}

export interface SimulatedTrade {
  family: DirectionalFamily;
  control: "original" | "inverted" | "confirmed" | "adaptive" | "random" | "confirmed_without_movement";
  instrument: string;
  setupTime: string;
  entryTime: string;
  resolvedAt: string;
  direction: TradeDirection;
  resultR: number;
  grossR: number;
  spreadCostR: number;
  outcome: "target_first" | "stop_first" | "timeout";
  confirmationDelayBars: number;
  movementQualified: boolean;
  confirmationType: DirectionConfirmation["confirmationType"];
  session: string;
  volatility: string;
  regime: string;
  adaptiveAction?: DirectionalAction;
  adaptiveEvidence?: number;
}


function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function completed(candles: Candle[]): Candle[] {
  return candles.filter((candle) => candle.complete);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function directionFromSign(value: number): TradeDirection | null {
  return value > 0 ? "long" : value < 0 ? "short" : null;
}

function reverse(direction: TradeDirection): TradeDirection {
  return direction === "long" ? "short" : "long";
}

function planAtClose(direction: TradeDirection, bid: number, ask: number, atr: number, targetR = 1.5): ResearchTradePlan {
  const entry = direction === "long" ? ask : bid;
  const stop = direction === "long" ? entry - atr : entry + atr;
  const target = direction === "long" ? entry + atr * targetR : entry - atr * targetR;
  return { direction, entry, stop, target };
}

function adaptExistingCandidate(candidate: StrategyCandidate, setupIndex: number, atr: number, atrPips: number, spreadPips: number): ResearchSetupCandidate {
  const direction = candidate.direction;
  const originalPlan = direction && candidate.entry != null && candidate.stop != null && candidate.target != null
    ? { direction, entry: candidate.entry, stop: candidate.stop, target: candidate.target }
    : null;
  return {
    family: candidate.family,
    version: candidate.version,
    instrument: candidate.instrument,
    timeframe: "M15",
    setupIndex,
    setupTime: candidate.evaluatedAt,
    setupQualified: candidate.status === "valid" && originalPlan !== null,
    originalDirection: direction,
    originalPlan,
    setupMetadata: {
      status: candidate.status,
      qualifyReason: candidate.qualifyReason,
      riskReward: candidate.riskReward,
      passedConditions: candidate.passedConditions.length,
      failedConditions: candidate.failedConditions.length,
    },
    regime: candidate.regime,
    atr,
    atrPips,
    spreadPips,
  };
}

function researchCandidate(args: Omit<ResearchSetupCandidate, "setupQualified"> & { setupQualified?: boolean }): ResearchSetupCandidate {
  return { ...args, setupQualified: args.setupQualified ?? args.originalPlan !== null };
}

/**
 * Run the unchanged four production detectors and the four isolated V1 research
 * detectors at one completed M15 close. No confirmation candle is read here.
 */
export function detectEightFamilySetups(input: StrategyEvaluationInput, setupIndex: number): { regime: MarketRegime; candidates: ResearchSetupCandidate[] } {
  const evaluatedAt = input.evaluatedAt ?? input.candles15m.at(-1)?.time ?? new Date(0).toISOString();
  const regime = classifyRegime(input.instrument, input.candles15m, evaluatedAt);
  const atr = regime.atr ?? 0;
  const atrPips = regime.atrPips ?? 0;
  const spreadPips = input.spreadPips ?? 0;
  const existing = evaluateAllStrategies(input, regime).candidates.map((candidate) =>
    adaptExistingCandidate(candidate, setupIndex, atr, atrPips, spreadPips));

  const c15 = completed(input.candles15m);
  const c1h = completed(input.candles1h);
  if (atr <= 0 || c15.length < 60 || c1h.length < 60 || input.bid == null || input.ask == null) {
    return { regime, candidates: existing };
  }

  const closes = c15.map((candle) => candle.close);
  const ema9 = calculateEmaValues(closes, 9);
  const ema20 = calculateEmaValues(closes, 20);
  const ema21 = calculateEmaValues(closes, 21);
  const ema50 = calculateEmaValues(closes, 50);
  const rsi14 = calculateRsiValues(closes, 14).at(-1) ?? 50;
  const last = c15.at(-1)!;
  const prior = c15.at(-2)!;
  const fast9 = ema9.at(-1) ?? last.close;
  const fast20 = ema20.at(-1) ?? last.close;
  const fast21 = ema21.at(-1) ?? last.close;
  const slow50 = ema50.at(-1) ?? last.close;
  const ret6 = (last.close - c15.at(-7)!.close) / atr;

  // 5. Scalping Continuation. Stored history has no M1/M5, so this is frozen
  // as an explicitly named M15 proxy and cannot establish an M1/M5 edge.
  const scalpContext = directionFromSign(fast9 - fast21);
  const scalpSlope = ((ema9.at(-1) ?? 0) - (ema9.at(-4) ?? 0)) / 3 / atr;
  const scalpPullback = last.low <= Math.max(fast9, fast21) + atr * 0.2
    && last.high >= Math.min(fast9, fast21) - atr * 0.2;
  const scalpResume = scalpContext === "long"
    ? last.close > last.open && last.close > prior.close
    : scalpContext === "short" ? last.close < last.open && last.close < prior.close : false;
  const scalpQualified = scalpContext !== null && scalpPullback && scalpResume
    && Math.abs(scalpSlope) >= 0.03 && Math.abs(ret6) <= 3 && atrPips >= 1
    && spreadPips / Math.max(atrPips, 1e-9) <= 0.35;
  const scalpPlan = scalpQualified && scalpContext ? planAtClose(scalpContext, input.bid, input.ask, atr, 1.25) : null;

  // 6. Momentum Exhaustion / Reversal. Extension is the opportunity; RSI is a
  // guard. A rejection or failed continuation is required before the setup is
  // admitted, and even then its counter-move direction remains only ORIGINAL.
  const moveDirection = directionFromSign(ret6);
  const range = Math.max(last.high - last.low, 1e-12);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const rejection = moveDirection === "long" ? upperWick / range >= 0.4 : moveDirection === "short" ? lowerWick / range >= 0.4 : false;
  const failedContinuation = moveDirection === "long"
    ? last.close < prior.close && last.high <= prior.high
    : moveDirection === "short" ? last.close > prior.close && last.low >= prior.low : false;
  const extremeRsi = moveDirection === "long" ? rsi14 >= 72 : moveDirection === "short" ? rsi14 <= 28 : false;
  const exhaustionDirection = moveDirection ? reverse(moveDirection) : null;
  const exhaustionQualified = moveDirection !== null && Math.abs(ret6) >= 2 && extremeRsi && (rejection || failedContinuation);
  const exhaustionPlan = exhaustionQualified && exhaustionDirection ? planAtClose(exhaustionDirection, input.bid, input.ask, atr, 1.25) : null;

  // 7. Intraday Breakout. The setup is compression plus the first completed
  // range break; that break direction is retained only as the original control.
  const rangeWindow = c15.slice(-17, -1);
  const rangeHigh = Math.max(...rangeWindow.map((candle) => candle.high));
  const rangeLow = Math.min(...rangeWindow.map((candle) => candle.low));
  const rangeWidthAtr = (rangeHigh - rangeLow) / atr;
  const atrSeries = calculateAtrValues(c15, 14).filter((value): value is number => typeof value === "number" && value > 0);
  const atrBaseline = median(atrSeries.slice(-50));
  const compression = atrBaseline > 0 ? atr / atrBaseline : 1;
  const brokeUp = last.close > rangeHigh + atr * 0.1;
  const brokeDown = last.close < rangeLow - atr * 0.1;
  const intradayBreakDirection = brokeUp ? "long" : brokeDown ? "short" : null;
  const intradayBreakQualified = intradayBreakDirection !== null && rangeWidthAtr >= 1 && rangeWidthAtr <= 5 && compression <= 1.15;
  const intradayBreakPlan = intradayBreakQualified && intradayBreakDirection ? planAtClose(intradayBreakDirection, input.bid, input.ask, atr, 1.5) : null;

  // 8. Intraday Trend Retracement. H1 and M15 trend structure create context;
  // the completed M15 resumption bar admits the setup but cannot dictate final
  // execution direction after this layer.
  const h1Closes = c1h.map((candle) => candle.close);
  const h1Fast = calculateEmaValues(h1Closes, 20).at(-1) ?? null;
  const h1Slow = calculateEmaValues(h1Closes, 50).at(-1) ?? null;
  const h1Direction = h1Fast !== null && h1Slow !== null ? directionFromSign(h1Fast - h1Slow) : null;
  const m15Direction = directionFromSign(fast20 - slow50);
  const retracementDepth = h1Direction === "long" ? (fast20 - last.low) / atr : h1Direction === "short" ? (last.high - fast20) / atr : 0;
  const retraced = last.low <= Math.max(fast20, slow50) + atr * 0.25 && last.high >= Math.min(fast20, slow50) - atr * 0.25;
  const resumed = h1Direction === "long" ? last.close > last.open && last.close > fast20 : h1Direction === "short" ? last.close < last.open && last.close < fast20 : false;
  const retracementQualified = h1Direction !== null && h1Direction === m15Direction && retraced && resumed
    && retracementDepth >= -0.25 && retracementDepth <= 1.5;
  const retracementPlan = retracementQualified && h1Direction ? planAtClose(h1Direction, input.bid, input.ask, atr, 1.5) : null;

  const additions: ResearchSetupCandidate[] = [
    researchCandidate({ family: "scalping_continuation", version: "scalping-continuation-m15-proxy-v1", instrument: input.instrument, timeframe: "M15_PROXY", setupIndex, setupTime: evaluatedAt, originalDirection: scalpContext, originalPlan: scalpPlan, setupMetadata: { ema9: fast9, ema21: fast21, slopeAtrPerBar: scalpSlope, pullback: scalpPullback, resumed: scalpResume, return6Atr: ret6, dataConstraint: "M1_M5_NOT_STORED" }, regime, atr, atrPips, spreadPips }),
    researchCandidate({ family: "momentum_exhaustion", version: "momentum-exhaustion-v1", instrument: input.instrument, timeframe: "M15", setupIndex, setupTime: evaluatedAt, originalDirection: exhaustionDirection, originalPlan: exhaustionPlan, setupMetadata: { displacement6Atr: ret6, rsi14, rejection, failedContinuation }, regime, atr, atrPips, spreadPips }),
    researchCandidate({ family: "intraday_breakout", version: "intraday-breakout-v1", instrument: input.instrument, timeframe: "M15", setupIndex, setupTime: evaluatedAt, originalDirection: intradayBreakDirection, originalPlan: intradayBreakPlan, setupMetadata: { rangeHigh, rangeLow, rangeWidthAtr, atrCompressionRatio: compression }, regime, atr, atrPips, spreadPips }),
    researchCandidate({ family: "intraday_trend_retracement", version: "intraday-trend-retracement-v1", instrument: input.instrument, timeframe: "M15", setupIndex, setupTime: evaluatedAt, originalDirection: h1Direction, originalPlan: retracementPlan, setupMetadata: { h1Fast, h1Slow, m15Fast: fast20, m15Slow: slow50, retracementDepthAtr: retracementDepth, retraced, resumed }, regime, atr, atrPips, spreadPips }),
  ];

  return { regime, candidates: [...existing, ...additions] };
}

/**
 * Small deterministic movement detector used because the repository contains
 * offline magnitude-model research, but no frozen serialized model that can be
 * reused without retraining. It must prove itself against the no-filter control.
 */
export function estimateMovementOpportunity(candles: Candle[], setupIndex: number, atr: number, spreadPips: number, pipSize: number): MovementEstimate {
  const history = completed(candles).slice(0, setupIndex + 1);
  const atrs = calculateAtrValues(history, 14).filter((value): value is number => typeof value === "number" && value > 0);
  const baseline = median(atrs.slice(-80, -10));
  const volatilityExpansion = baseline > 0 ? atr / baseline : 1;
  const last = history.at(-1)!;
  const close6 = history.at(-7)?.close ?? last.close;
  const velocityAtr = atr > 0 ? Math.abs(last.close - close6) / atr : 0;
  const recent = history.slice(-12);
  const wider = history.slice(-48);
  const recentRange = Math.max(...recent.map((candle) => candle.high)) - Math.min(...recent.map((candle) => candle.low));
  const widerRange = Math.max(...wider.map((candle) => candle.high)) - Math.min(...wider.map((candle) => candle.low));
  const compressionRelease = widerRange > 0 ? 1 - clamp(recentRange / widerRange, 0, 1) : 0;
  const bodyAtr = atr > 0 ? Math.abs(last.close - last.open) / atr : 0;
  const movementStrength = clamp(0.35 * volatilityExpansion + 0.3 * compressionRelease + 0.25 * velocityAtr + 0.1 * bodyAtr, 0, 3);
  const expectedMoveAtr = clamp(0.35 + movementStrength * 0.55, 0.2, 2.5);
  const movementProbability = clamp(0.42 + movementStrength * 0.13, 0.05, 0.9);
  const costAtr = atr > 0 ? (spreadPips * pipSize) / atr : Number.POSITIVE_INFINITY;
  const qualified = movementProbability >= 0.55 && expectedMoveAtr >= costAtr + 0.55;
  return { version: "movement-heuristic-v1", movementProbability, expectedMoveAtr, movementStrength, qualified, costAtr, volatilityExpansion, compressionRelease, velocityAtr };
}

function structureDirection(candles: Candle[]): ConfirmedDirection {
  if (candles.length < 6) return "uncertain";
  const a = candles.slice(-6, -3);
  const b = candles.slice(-3);
  const aHigh = Math.max(...a.map((candle) => candle.high));
  const aLow = Math.min(...a.map((candle) => candle.low));
  const bHigh = Math.max(...b.map((candle) => candle.high));
  const bLow = Math.min(...b.map((candle) => candle.low));
  if (bHigh > aHigh && bLow > aLow) return "long";
  if (bHigh < aHigh && bLow < aLow) return "short";
  return "uncertain";
}

export function confirmDirectionAfterSetup(
  candles: Candle[],
  setupIndex: number,
  atr: number,
  config: { rangeLookbackBars?: number; breakoutAtr?: number; maxDelayBars?: number; requireHold?: boolean } = {},
): DirectionConfirmation {
  const rangeLookbackBars = config.rangeLookbackBars ?? 8;
  const breakoutAtr = config.breakoutAtr ?? 0.1;
  const maxDelayBars = config.maxDelayBars ?? 4;
  const requireHold = config.requireHold ?? true;
  const history = completed(candles);
  const range = history.slice(Math.max(0, setupIndex - rangeLookbackBars + 1), setupIndex + 1);
  const localRangeHigh = Math.max(...range.map((candle) => candle.high));
  const localRangeLow = Math.min(...range.map((candle) => candle.low));
  const uncertain = (): DirectionConfirmation => ({ version: "range-close-hold-v1", direction: "uncertain", directionConfidence: 0, confirmationType: "none", breakoutStrength: 0, heldBreakout: false, structureDirection: "uncertain", confirmationDelayBars: null, knownAtIndex: null, entryIndex: null, localRangeHigh, localRangeLow });
  if (!(atr > 0) || !range.length) return uncertain();

  for (let index = setupIndex + 1; index <= Math.min(history.length - 1, setupIndex + maxDelayBars); index += 1) {
    const candle = history[index]!;
    const upStrength = (candle.close - localRangeHigh) / atr;
    const downStrength = (localRangeLow - candle.close) / atr;
    const direction: TradeDirection | null = upStrength >= breakoutAtr ? "long" : downStrength >= breakoutAtr ? "short" : null;
    if (!direction) continue;
    const strength = Math.max(upStrength, downStrength);
    let knownAtIndex = index;
    let heldBreakout = false;
    if (requireHold) {
      const hold = history[index + 1];
      if (!hold) return uncertain();
      heldBreakout = direction === "long" ? hold.close > localRangeHigh : hold.close < localRangeLow;
      if (!heldBreakout) continue;
      knownAtIndex = index + 1;
    }
    const structure = structureDirection(history.slice(0, knownAtIndex + 1));
    const structureBonus = structure === direction ? 0.15 : structure === "uncertain" ? 0 : -0.1;
    const confidence = clamp(0.5 + strength * 0.2 + (heldBreakout ? 0.15 : 0) + structureBonus, 0, 0.95);
    const entryIndex = knownAtIndex + 1 < history.length ? knownAtIndex + 1 : null;
    return {
      version: "range-close-hold-v1",
      direction,
      directionConfidence: confidence,
      confirmationType: heldBreakout ? "range_close_hold" : "range_close",
      breakoutStrength: strength,
      heldBreakout,
      structureDirection: structure,
      confirmationDelayBars: knownAtIndex - setupIndex,
      knownAtIndex,
      entryIndex,
      localRangeHigh,
      localRangeLow,
    };
  }
  return uncertain();
}

export function simulateResearchTrade(args: {
  family: DirectionalFamily;
  control: SimulatedTrade["control"];
  candidate: ResearchSetupCandidate;
  quotes: ResearchQuote[];
  direction: TradeDirection;
  entryIndex: number;
  entry?: number;
  stop?: number;
  target?: number;
  targetR?: number;
  maxBars?: number;
  /** Override for controls entered at the setup close but resolved from i+1. */
  spreadPrice?: number;
  entryTime?: string;
  confirmation?: DirectionConfirmation;
  movementQualified?: boolean;
  session: string;
  adaptiveAction?: DirectionalAction;
  adaptiveEvidence?: number;
}): SimulatedTrade | null {
  const quote = args.quotes[args.entryIndex];
  if (!quote) return null;
  const entry = args.entry ?? (args.direction === "long" ? quote.askOpen : quote.bidOpen);
  const risk = args.stop != null ? Math.abs(entry - args.stop) : args.candidate.atr;
  if (!(risk > 0)) return null;
  const stop = args.stop ?? (args.direction === "long" ? entry - risk : entry + risk);
  const target = args.target ?? (args.direction === "long" ? entry + risk * (args.targetR ?? 1.5) : entry - risk * (args.targetR ?? 1.5));
  const maxBars = args.maxBars ?? 24;
  let resultR: number | null = null;
  let exitIndex = -1;
  let outcome: SimulatedTrade["outcome"] = "timeout";
  for (let index = args.entryIndex; index < Math.min(args.quotes.length, args.entryIndex + maxBars); index += 1) {
    const bar = args.quotes[index]!;
    const targetHit = args.direction === "long" ? bar.bidHigh >= target : bar.askLow <= target;
    const stopHit = args.direction === "long" ? bar.bidLow <= stop : bar.askHigh >= stop;
    if (targetHit && stopHit) return null;
    if (targetHit) { resultR = Math.abs(target - entry) / risk; outcome = "target_first"; exitIndex = index; break; }
    if (stopHit) { resultR = -1; outcome = "stop_first"; exitIndex = index; break; }
  }
  if (resultR === null) {
    exitIndex = Math.min(args.quotes.length - 1, args.entryIndex + maxBars - 1);
    const exit = args.direction === "long" ? args.quotes[exitIndex]!.bidClose : args.quotes[exitIndex]!.askClose;
    resultR = (args.direction === "long" ? exit - entry : entry - exit) / risk;
  }
  const spread = args.spreadPrice ?? (quote.askOpen - quote.bidOpen);
  const spreadCostR = spread / risk;
  return {
    family: args.family,
    control: args.control,
    instrument: args.candidate.instrument,
    setupTime: args.candidate.setupTime,
    entryTime: args.entryTime ?? quote.closeTime,
    resolvedAt: args.quotes[exitIndex]!.closeTime,
    direction: args.direction,
    resultR,
    grossR: resultR + spreadCostR,
    spreadCostR,
    outcome,
    confirmationDelayBars: args.confirmation?.confirmationDelayBars ?? 0,
    movementQualified: args.movementQualified ?? false,
    confirmationType: args.confirmation?.confirmationType ?? "none",
    session: args.session,
    volatility: args.candidate.regime.volatility,
    regime: args.candidate.regime.regime,
    adaptiveAction: args.adaptiveAction,
    adaptiveEvidence: args.adaptiveEvidence,
  };
}

export function oppositeDirection(direction: TradeDirection): TradeDirection {
  return reverse(direction);
}

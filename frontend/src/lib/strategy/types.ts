import type { LiquidityKind } from "@/lib/strategy/liquidity-levels";
import type { DataSource, MajorInstrument } from "@/types/forex";

export type SetupStatus = "valid" | "developing" | "invalid" | "no_setup";
export type StrategyDirection = "long" | "short" | null;
export type StrategyEvaluationMode = "live" | "practice" | "historical_replay";

// ---------------------------------------------------------------------------
// Multi-strategy + adaptive engine (Phase 2). Defined here, in the base types
// module that imports no strategy file, so the strategy contract and the
// per-family research features can be referenced without a circular import.
// Every field below is deterministic and computed only from completed candles
// available at decision time.
// ---------------------------------------------------------------------------

export type StrategyFamily = "ema" | "breakout" | "momentum" | "meanrev";
export type RegimeClass = "trending" | "ranging" | "mixed";
export type TrendDirection = "up" | "down" | "none";
export type VolatilityBucket = "low" | "normal" | "high";
export type MomentumState = "accelerating_up" | "accelerating_down" | "steady" | "stalling";

/** The shared market environment all four strategies evaluate against. */
export interface MarketRegime {
  regime: RegimeClass;
  trendDirection: TrendDirection;
  /** Regression R² of closes over the lookback: 0 (chop) → 1 (clean trend). */
  trendStrength: number;
  volatility: VolatilityBucket;
  atr: number | null;
  atrPips: number | null;
  momentumState: MomentumState;
  emaFast: number | null;
  emaMid: number | null;
  emaSlow: number | null;
  /** Slope of the mid EMA per bar, normalized by ATR. Signed. */
  slopeAtrPerBar: number | null;
  rangeHigh: number | null;
  rangeLow: number | null;
  rangeWidthAtr: number | null;
  /** How many of the last lookback bars price stayed inside the range band. */
  rangeAgeBars: number | null;
  lookbackBars: number;
  evaluatedAt: string;
}

export interface EmaFeatures {
  emaFast: number | null;
  emaMid: number | null;
  emaSlow: number | null;
  aligned: boolean;
  slopeAtrPerBar: number | null;
  pullbackDepthAtr: number | null;
  distanceFromFastAtr: number | null;
  extensionAtr: number | null;
  confirmation: boolean;
}

export interface BreakoutFeatures {
  level: number | null;
  side: "high" | "low" | null;
  lookbackBars: number;
  breakoutDistance: number | null;
  breakoutDistanceAtr: number | null;
  candleClose: boolean;
  rangeHigh: number | null;
  rangeLow: number | null;
  rangeWidthAtr: number | null;
  retest: boolean;
  extensionAtr: number | null;
}

export interface MomentumFeatures {
  momentumAtr: number | null;
  returnPct: number | null;
  accelerationAtr: number | null;
  bodyRatio: number | null;
  consecutiveBars: number;
  extensionAtr: number | null;
  rsi14: number | null;
}

export interface MeanReversionFeatures {
  mean: number | null;
  distanceFromMean: number | null;
  stretchAtr: number | null;
  rangeHigh: number | null;
  rangeLow: number | null;
  rangeWidthAtr: number | null;
  rangeAgeBars: number | null;
  trendStrength: number | null;
  reversalConfirmation: boolean;
}

export interface StrategyCondition {
  name: string;
  passed: boolean;
  required: boolean;
  reason: string;
  currentValue: string;
}

export interface StrategyPositionSize {
  riskAmount: number;
  stopDistancePips: number;
  calculatedStandardLots: number;
  calculatedUnits: number;
  calculatedEstimatedRisk: number;
  units: number;
  standardLots: number;
  estimatedRisk: number;
  capStandardLots: number;
  capped: boolean;
}

/**
 * What macro-liquidity-v1 actually decided on, recorded per trade.
 *
 * These are the strategy's own inputs, and they exist here because a batch of a
 * hundred is only worth collecting if it can answer the questions the next
 * version needs: does a previous-day sweep beat an Asian-range one, is the
 * macro point earning its place, does a retest change anything. None of that is
 * recoverable after the fact — the level that got swept only exists in the
 * candles at decision time — so it is written when the trade opens or not at
 * all.
 */
export interface LiquidityDecisionFeatures {
  /** Which pool of orders was taken. The primary thing to slice a batch by. */
  sweptLevelKind: LiquidityKind;
  sweptLevelSide: "high" | "low";
  sweptLevelPrice: number;
  sweepDirection: "long" | "short";
  /** How far beyond the level price traded, in ATR — the sweep's conviction. */
  sweepDepthAtr: number | null;
  /** How long ago the sweep happened, in 15m bars. */
  sweepBarsAgo: number;
  pullbackDetected: boolean;
  pullbackDepthAtr: number | null;
  pullbackDurationBars: number;
  h1StructureIntact: boolean;
  sweptLevelDistanceAtr: number | null;
  atSweptLevel: boolean;
  /** The level price sits at now, if any — the scored `atLevel` factor. */
  atLevelKind: LiquidityKind | null;
  atOtherLiquidityLevel: boolean;
  liquidityConfluenceCount: number;
  rejection: boolean;
  displacement: boolean;
  structureBreak: boolean;
  confirmationType: "rejection" | "displacement" | "rejection_and_displacement" | "none";
  retest: boolean;
  macroBias: "long" | "short" | "neutral";
  macroAgrees: boolean;
  overlapSession: boolean;
  /** The session label the scorecard saw, kept beside the trade's own column. */
  session: string;
  /** The scorecard result the trade was admitted on, and its maximum. */
  score: number;
  scoreOutOf: number;
}

export interface StrategyResearchFeatures {
  trend15m: "bullish" | "bearish" | "mixed";
  trend1h: "bullish" | "bearish" | "mixed" | null;
  trend4h: "bullish" | "bearish" | "mixed" | null;
  ema21: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  atr14: number | null;
  atrPips: number | null;
  structureHighs: number;
  structureLows: number;
  h1Direction?: "bullish" | "bearish" | "mixed";
  h1DirectionState?: string;
  evaluationMode?: StrategyEvaluationMode;
  newsStatus?: "clear" | "high_impact" | "calendar_unavailable" | "not_evaluated";
  /**
   * Null until a sweep is found, and on any strategy that does not read levels.
   * The fields above describe the market; this one describes the decision.
   */
  liquidity?: LiquidityDecisionFeatures | null;
  // Multi-strategy (Phase 2). The shared regime plus whichever family produced
  // the candidate; the others stay null. Additive and optional so the retired
  // liquidity strategy and every existing consumer are unaffected.
  regime?: MarketRegime | null;
  ema?: EmaFeatures | null;
  breakout?: BreakoutFeatures | null;
  momentum?: MomentumFeatures | null;
  meanReversion?: MeanReversionFeatures | null;
}

export interface StrategySetup {
  status: SetupStatus;
  instrument: MajorInstrument;
  pair: string;
  direction: StrategyDirection;
  timeframe: "15m";
  entry: number | null;
  stop: number | null;
  target: number | null;
  riskReward: number | null;
  positionSize: StrategyPositionSize | null;
  features: StrategyResearchFeatures;
  summary: string;
  passedConditions: StrategyCondition[];
  failedConditions: StrategyCondition[];
  conditions: StrategyCondition[];
  evaluatedAt: string;
  dataSource: DataSource;
}

export interface StrategyEvaluationInput {
  instrument: MajorInstrument;
  accountBalance: number;
  accountCurrency: string;
  dataSource: DataSource;
  candles15m: import("@/types/forex").Candle[];
  candles1h: import("@/types/forex").Candle[];
  candles4h: import("@/types/forex").Candle[];
  bid: number | null;
  ask: number | null;
  spreadPips: number | null;
  marketOpen: boolean;
  calendarConnected: boolean;
  highImpactNewsWithinMinutes: number | null;
  /** Decision timestamp used for historical session evaluation. Defaults to now for live evaluations. */
  evaluatedAt?: string;
  /** Historical price-only research deliberately does not evaluate news. Live strategy evaluation keeps this true. */
  newsRequired?: boolean;
  evaluationMode?: StrategyEvaluationMode;
}

export interface StrategyEvaluationBundle {
  setups: StrategySetup[];
  bestSetup: StrategySetup;
  evaluatedAt: string;
}

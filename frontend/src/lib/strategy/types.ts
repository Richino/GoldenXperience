import type { LiquidityKind } from "@/lib/strategy/liquidity-levels";
import type { DataSource, MajorInstrument } from "@/types/forex";

export type SetupStatus = "valid" | "developing" | "invalid" | "no_setup";
export type StrategyDirection = "long" | "short" | null;

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
  /** How far beyond the level price traded, in ATR — the sweep's conviction. */
  sweepDepthAtr: number | null;
  /** How long ago the sweep happened, in 15m bars. */
  sweepBarsAgo: number;
  /** The level price sits at now, if any — the scored `atLevel` factor. */
  atLevelKind: LiquidityKind | null;
  rejection: boolean;
  displacement: boolean;
  structureBreak: boolean;
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
  /**
   * Null until a sweep is found, and on any strategy that does not read levels.
   * The fields above describe the market; this one describes the decision.
   */
  liquidity?: LiquidityDecisionFeatures | null;
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
}

export interface StrategyEvaluationBundle {
  setups: StrategySetup[];
  bestSetup: StrategySetup;
  evaluatedAt: string;
}

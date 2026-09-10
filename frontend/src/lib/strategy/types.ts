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
export type PairStrategyId = "eurusd_strategy" | "usdjpy_strategy" | "gbpusd_strategy" | "audusd_strategy" | "nzdusd_strategy" | "nzdusd_consensus_strategy" | "usdcad_strategy" | "usdchf_strategy" | "eurjpy_strategy" | "cadjpy_strategy" | "nzdjpy_strategy";
export type StrategyId = StrategyFamily | PairStrategyId;
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

/** Frozen, decision-time evidence for EURUSD London Breakout V1. */
export interface EurusdStrategyFeatures {
  strategyId: "eurusd_strategy";
  strategyName: "EURUSD London Breakout";
  strategyVersion: "v1";
  symbol: "EUR_USD";
  timeframe: "H1";
  session: "LONDON";
  setup: "A_LONDON_BO";
  signalDirection: "LONG" | "SHORT" | null;
  entryReference: number | null;
  stopATR: 1.0;
  rewardR: 2.0;
  atr14: number | null;
  ema20: number | null;
  ema50: number | null;
  asiaHigh: number | null;
  asiaLow: number | null;
  signalCandleTimestamp: string | null;
  body: number | null;
  bullTrend: boolean;
  bearTrend: boolean;
  bullStructure: boolean;
  bearStructure: boolean;
  longSetup: boolean;
  shortSetup: boolean;
  sigA: -1 | 0 | 1;
  evtA: boolean;
  strategySetupQualified: boolean;
  strategyEventQualified: boolean;
  executionAllowed: boolean;
  executionBlockReason: string | null;
  reason: string;
  waitReason: string | null;
  signalKey: string | null;
}

/** Frozen, decision-time evidence for USDJPY Body Extreme V6. */
export interface UsdjpyStrategyFeatures {
  strategyId: "usdjpy_strategy";
  strategyName: "USDJPY Body Extreme V6";
  strategyVersion: 6;
  symbol: "USD_JPY";
  timeframe: "H1";
  session: "USDJPY_11_14_UTC";
  setup: "USDJPY_BODY_EXTREME";
  signalDirection: "LONG" | null;
  signalCandleTimestamp: string | null;
  signalTimestampUtc: string | null;
  signalPrice: number | null;
  executionEntryPrice: number | null;
  actualFillPrice: number | null;
  ema20: number | null;
  ema50: number | null;
  atr14: number | null;
  entryATR: number | null;
  riskDistance: number | null;
  preHigh: number | null;
  preLow: number | null;
  preRangeBarCount: number;
  rangeReady: boolean;
  tradedEarlierUtcDay: boolean;
  signalCandle: { open: number; high: number; low: number; close: number } | null;
  body: number | null;
  bodyATRRatio: number | null;
  bodyPassed: boolean;
  barRange: number | null;
  closePositionPct: number | null;
  trendDirection: "LONG" | "SHORT" | "WAIT";
  breakoutLong: boolean;
  breakoutShort: boolean;
  bullExtremeClose: boolean;
  bearExtremeClose: boolean;
  extremeClosePassed: boolean;
  finalLongSignal: boolean;
  finalShortSignal: boolean;
  strategySignalQualified: boolean;
  executionAllowed: boolean;
  executionBlockReason: string | null;
  stopPrice: number | null;
  targetPrice: number | null;
  stopATRMultiplier: 1;
  rewardR: 2;
  maximumHoldBars: 3;
  barsHeld: number;
  exitPrice: number | null;
  exitReason: "TAKE_PROFIT" | "STOP_LOSS" | "TIME_EXIT" | null;
  realizedR: number | null;
  realizedPnL: number | null;
  reason: string;
  waitReason: string | null;
  signalKey: string | null;
}

/** Frozen, decision-time evidence for AUDUSD Strong Consensus Structure V2 HL Only. */
export interface AudusdStrategyFeatures {
  strategyId: "audusd_strategy";
  strategyName: "AUDUSD Strong Consensus Structure V2 HL Only";
  strategyVersion: "AUDUSD_STRONG_CONS_STRUCTURE_V2";
  symbol: "AUD_USD";
  timeframe: "H1";
  origin: "11:00 UTC";
  direction: "LONG" | null;
  signalKey: string | null;
  signalCandleTimestamp: string | null;
  signalTimeUtc: string | null;
  entryTimeUtc: string | null;
  signalClose: number | null;
  intendedEntry: number | null;
  actualEntry: number | null;
  ema20: number | null;
  ema50: number | null;
  ema20At0800: number | null;
  close0800: number | null;
  preRangeHigh: number | null;
  preRangeLow: number | null;
  preRangeMid: number | null;
  emaVote: -1 | 0 | 1;
  priceEmaVote: -1 | 0 | 1;
  emaSlopeVote: -1 | 0 | 1;
  rangeVote: -1 | 0 | 1;
  structureVote: -1 | 0 | 1;
  momentumVote: -1 | 0 | 1;
  voteSum: number | null;
  bullStructure: boolean;
  atr14: number | null;
  entryATR: number | null;
  candleBody: number | null;
  bodyAtrRatio: number | null;
  bodyConfirm: boolean;
  candleRange: number | null;
  extremeClose: boolean;
  confidenceTag: "AUDUSD_BODY_EXTREME" | "AUDUSD_BASE" | null;
  stopLoss: number | null;
  takeProfit: number | null;
  maximumHoldBars: 3;
  expirationTimeUtc: string | null;
  actualExit: number | null;
  exitTimeUtc: string | null;
  exitReason: "TP" | "SL" | "TIME_EXIT" | "GLOBAL_RISK_BLOCK" | "SPREAD_BLOCK" | "POSITION_LIMIT" | "EXECUTION_ERROR" | null;
  realizedPnL: number | null;
  realizedR: number | null;
  brokerOrderId: string | null;
  brokerTradeId: string | null;
  waitReason: string | null;
}

/** Frozen, decision-time evidence for NZDUSD Pre-Range Breakout V1. */
export interface NzdusdStrategyFeatures {
  strategyId: "nzdusd_strategy";
  strategyName: "NZDUSD Pre-Range Breakout V1";
  strategyVersion: "NZDUSD_PRE_RANGE_BREAKOUT_V1";
  symbol: "NZD_USD";
  timeframe: "H1";
  origin: "11:00 UTC";
  signalKey: string | null;
  direction: "LONG" | "SHORT" | null;
  signalCandleTimestamp: string | null;
  signalTimeUtc: string | null;
  entryTimeUtc: string | null;
  signalClose: number | null;
  executionEntry: number | null;
  actualEntry: number | null;
  actualBrokerFill: number | null;
  ema20: number | null;
  ema50: number | null;
  preRangeHigh: number | null;
  preRangeLow: number | null;
  atr14: number | null;
  entryATR: number | null;
  candleBody: number | null;
  bodyAtrRatio: number | null;
  confidenceTag: "NZDUSD_BODY" | "NZDUSD_BASE" | null;
  stopLoss: number | null;
  takeProfit: number | null;
  maximumHoldBars: 3;
  expirationTimeUtc: string | null;
  actualExit: number | null;
  exitTimeUtc: string | null;
  exitReason: "TP" | "SL" | "TIME_EXIT" | null;
  realizedPnL: number | null;
  realizedR: number | null;
  brokerOrderId: string | null;
  brokerTradeId: string | null;
  waitReason: string | null;
  blockReason: "GLOBAL_RISK_BLOCK" | "SPREAD_BLOCK" | "POSITION_LIMIT" | "EXECUTION_ERROR" | null;
}

/**
 * Frozen Pine and execution evidence for NZDJPY 23UTC Bull Break V1.
 * `strategySignalQualified` is deliberately independent of broker policy.
 */
export interface NzdjpyStrategyFeatures {
  strategyId: "nzdjpy_strategy";
  strategyName: "NZDJPY 23UTC Bull Break V1";
  strategyVersion: "V1";
  symbol: "NZD_JPY";
  timeframe: "H1";
  signalKey: string | null;
  originTime: string | null;
  signalMidClose: number | null;
  actualExecutableEntry: number | null;
  frozenAtr14: number | null;
  pineReferenceStop: number | null;
  pineReferenceTarget: number | null;
  executableStop: number | null;
  executableTarget: number | null;
  ema20: number | null;
  ema50: number | null;
  voteTrend: -1 | 0 | 1 | null;
  votePrice: -1 | 0 | 1 | null;
  voteSlope: -1 | 0 | 1 | null;
  voteMomentum: -1 | 0 | 1 | null;
  consensus: number | null;
  bullBody: boolean;
  bodyR: number | null;
  closeLocation: number | null;
  previousHigh: number | null;
  breakDistanceR: number | null;
  strategySignalQualified: boolean;
  executionAllowed: boolean;
  executionBlockReason: string | null;
  maxHoldBars: 3;
}

export interface CadjpyStrategyFeatures {
  strategyId: "cadjpy_strategy"; strategyName: "CADJPY Bull Break Extreme V1"; strategyVersion: "V1"; symbol: "CAD_JPY"; timeframe: "H1";
  signalKey: string | null; originTime: string | null; signalMidClose: number | null; actualExecutableEntry: number | null; frozenAtr14: number | null;
  pineReferenceStop: number | null; pineReferenceTarget: number | null; executableStop: number | null; executableTarget: number | null;
  ema20: number | null; ema50: number | null; voteTrend: -1 | 0 | 1 | null; votePrice: -1 | 0 | 1 | null; voteSlope: -1 | 0 | 1 | null; voteMomentum: -1 | 0 | 1 | null;
  consensus: number | null; previousHigh: number | null; previousHighBreak: boolean; bullBody: boolean; bodyR: number | null; closeLocation: number | null;
  strategySignalQualified: boolean; executionAllowed: boolean; executionBlockReason: string | null; maxHoldBars: 3;
}

/** Frozen Pine and execution evidence for EURJPY 01-05 Range Break V1. */
export interface EurjpyStrategyFeatures {
  strategyId: "eurjpy_strategy"; strategyName: "EURJPY 01-05 Range Break V1"; strategyVersion: "V1"; symbol: "EUR_JPY"; timeframe: "H1";
  signalKey: string | null; originTime: string | null; signalMidClose: number | null; actualExecutableEntry: number | null; frozenAtr14: number | null;
  pineReferenceStop: number | null; pineReferenceTarget: number | null; executableStop: number | null; executableTarget: number | null;
  ema20: number | null; ema20Back: number | null; previousHigh: number | null; preRangeStart: string | null; preRangeEnd: string | null; preHigh: number | null; preLow: number | null; preRangeBarCount: number; rangeReady: boolean;
  emaSlopeUp: boolean; previousHighBreak: boolean; preRangeHighBreak: boolean; strategySignalQualified: boolean; executionAllowed: boolean; executionBlockReason: string | null; maxHoldBars: 3;
}

/** Frozen Pine and execution evidence for USDCHF Bear Consensus Structure V1. */
export interface UsdchfStrategyFeatures {
  strategyId: "usdchf_strategy"; strategyName: "USDCHF Bear Consensus Structure V1"; strategyVersion: "V1"; symbol: "USD_CHF"; timeframe: "H1";
  signalKey: string | null; originTime: string | null; signalMidClose: number | null; actualExecutableEntry: number | null; frozenAtr14: number | null;
  pineReferenceStop: number | null; pineReferenceTarget: number | null; executableStop: number | null; executableTarget: number | null;
  ema20: number | null; ema50: number | null; ema20Back: number | null; voteTrend: -1 | 0 | 1 | null; votePrice: -1 | 0 | 1 | null; voteSlope: -1 | 0 | 1 | null; voteMomentum: -1 | 0 | 1 | null; consensus: number | null;
  currentHigh: number | null; previousHigh: number | null; currentLow: number | null; previousLow: number | null; bearStructure: boolean;
  strategySignalQualified: boolean; executionAllowed: boolean; executionBlockReason: string | null; maxHoldBars: 3;
}

/** Frozen Pine and execution evidence for USDCAD Structure EMA Reclaim V3. */
export interface UsdcadStrategyFeatures {
  strategyId: "usdcad_strategy"; strategyName: "USDCAD Structure EMA Reclaim V3 11:00 LONG Only"; strategyVersion: "V3"; symbol: "USD_CAD"; timeframe: "H1";
  signalKey: string | null; originTime: string | null; signalMidClose: number | null; actualExecutableEntry: number | null; frozenAtr14: number | null; pineReferenceStop: number | null; pineReferenceTarget: number | null; executableStop: number | null; executableTarget: number | null;
  currentHigh: number | null; previousHigh: number | null; currentLow: number | null; previousLow: number | null; ema20Current: number | null; ema20Previous: number | null; closeCurrent: number | null; closePrevious: number | null;
  bullStructure: boolean; longReclaim: boolean; emaPenetrationR: number | null; emaPenLong: boolean; closeLocation: number | null; extremeLong: boolean; highConfidenceLong: boolean; signalTag: "USDCAD_1100_LONG_PEN_EXTREME" | "USDCAD_1100_LONG_BASE" | null;
  strategySignalQualified: boolean; executionAllowed: boolean; executionBlockReason: string | null; maxHoldBars: 3;
}

/** Frozen Pine and execution evidence for NZDUSD Bull Consensus Structure V1. */
export interface NzdusdConsensusStrategyFeatures {
  strategyId: "nzdusd_consensus_strategy"; strategyName: "NZDUSD Bull Consensus Structure V1"; strategyVersion: "V1"; symbol: "NZD_USD"; timeframe: "H1";
  signalKey: string | null; originTime: string | null; signalMidClose: number | null; actualExecutableEntry: number | null; frozenAtr14: number | null; pineReferenceStop: number | null; pineReferenceTarget: number | null; executableStop: number | null; executableTarget: number | null;
  ema20: number | null; ema50: number | null; ema20Back: number | null; closeThreeBarsAgo: number | null; voteTrend: -1 | 0 | 1 | null; votePrice: -1 | 0 | 1 | null; voteSlope: -1 | 0 | 1 | null; voteMomentum: -1 | 0 | 1 | null; consensus: number | null;
  currentHigh: number | null; previousHigh: number | null; currentLow: number | null; previousLow: number | null; higherHigh: boolean; higherLow: boolean; bullStructure: boolean; strategySignalQualified: boolean; executionAllowed: boolean; executionBlockReason: string | null; maxHoldBars: 3;
}

/** Frozen, decision-time evidence for GBPUSD 30M Dual-Origin V2. */
export interface GbpusdStrategyFeatures {
  strategyId: "gbpusd_strategy";
  strategyName: "GBPUSD 30M Dual-Origin V2 Independent Legs";
  strategyVersion: "v2";
  symbol: "GBP_USD";
  timeframe: "M30";
  origin: "10:30" | "11:00" | null;
  originCode: "1030" | "1100" | null;
  signalLabel: "GBPUSD_1030_LONG" | "GBPUSD_1030_SHORT" | "GBPUSD_1100_LONG" | "GBPUSD_1100_SHORT" | null;
  signalTimeUtc: string | null;
  entryTimeUtc: string | null;
  signalCandleTimestamp: string | null;
  signalClose: number | null;
  intendedEntry: number | null;
  actualEntry: number | null;
  bid: number | null;
  ask: number | null;
  spreadPips: number | null;
  slippage: number | null;
  ema20: number | null;
  ema50: number | null;
  atr14: number | null;
  entryATR: number | null;
  preRangeHigh: number | null;
  preRangeLow: number | null;
  rangeBars: number;
  expectedRangeBars: number;
  rangeReady: boolean;
  breakoutDistance: number | null;
  penetration: number | null;
  extremeClose: boolean;
  confidenceTag: "BASE" | "PEN_EXTREME";
  trend: "LONG" | "SHORT" | "WAIT";
  breakout: boolean;
  rawSignal: boolean;
  signalCandle: { open: number; high: number; low: number; close: number } | null;
  stopLoss: number | null;
  takeProfit: number | null;
  maxHoldBars: 6;
  plannedExpirationUtc: string | null;
  actualExit: number | null;
  exitTimeUtc: string | null;
  exitReason: "TP" | "SL" | "TIME_EXIT" | "BLOCKED_OPPOSITE_POSITION" | "GLOBAL_RISK_BLOCK" | "SPREAD_BLOCK" | "EXECUTION_ERROR" | null;
  realizedPnL: number | null;
  realizedR: number | null;
  brokerOrderId: string | null;
  brokerTradeId: string | null;
  waitReason: string | null;
  signalKey: string | null;
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
  eurusdStrategy?: EurusdStrategyFeatures | null;
  usdjpyStrategy?: UsdjpyStrategyFeatures | null;
  gbpusdStrategy?: GbpusdStrategyFeatures | null;
  audusdStrategy?: AudusdStrategyFeatures | null;
  nzdusdStrategy?: NzdusdStrategyFeatures | null;
  nzdjpyStrategy?: NzdjpyStrategyFeatures | null;
  cadjpyStrategy?: CadjpyStrategyFeatures | null;
  eurjpyStrategy?: EurjpyStrategyFeatures | null;
  usdchfStrategy?: UsdchfStrategyFeatures | null;
  usdcadStrategy?: UsdcadStrategyFeatures | null;
  nzdusdConsensusStrategy?: NzdusdConsensusStrategyFeatures | null;
  /** Generic decision-time facts for the new frozen pair modules. */
  frozenPairStrategy?: {
    strategyId: PairStrategyId;
    strategyName: string;
    strategyVersion: string;
    symbol: string;
    timeframe: "H1";
    signalKey: string | null;
    originHourUtc: number;
    frozenAtr14: number | null;
    maxHoldBars: 3;
    actualExit: number | null;
    exitTimeUtc: string | null;
    exitReason: "TP" | "SL" | "TIME_EXIT" | null;
    realizedR: number | null;
  } | null;
}

export interface StrategySetup {
  status: SetupStatus;
  instrument: MajorInstrument;
  pair: string;
  direction: StrategyDirection;
  timeframe: "15m" | "30m" | "1h";
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
  /** Pair-specific M30 history. Optional so existing strategy/research callers remain source-compatible. */
  candles30m?: import("@/types/forex").Candle[];
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

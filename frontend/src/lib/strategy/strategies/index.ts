import { classifyRegime, DEFAULT_REGIME_CONFIG } from "@/lib/strategy/regime";
import { DEFAULT_EMA_CONFIG, EMA_CONFIG_VERSION, emaStrategy, evaluateEma } from "@/lib/strategy/strategies/ema";
import { BREAKOUT_CONFIG_VERSION, breakoutStrategy, DEFAULT_BREAKOUT_CONFIG, evaluateBreakout } from "@/lib/strategy/strategies/breakout";
import { DEFAULT_MOMENTUM_CONFIG, evaluateMomentum, MOMENTUM_CONFIG_VERSION, momentumStrategy } from "@/lib/strategy/strategies/momentum";
import { DEFAULT_MEANREV_CONFIG, evaluateMeanReversion, MEANREV_CONFIG_VERSION, meanReversionStrategy } from "@/lib/strategy/strategies/meanrev";
import type { StrategyCandidate } from "@/lib/strategy/strategy";
import type { MarketRegime, StrategyEvaluationInput, StrategyFamily, StrategyId } from "@/lib/strategy/types";
import {
  EURUSD_STRATEGY_CONFIG, EURUSD_STRATEGY_CONFIG_VERSION, EURUSD_STRATEGY_ID, EURUSD_STRATEGY_NAME,
  EURUSD_STRATEGY_SYMBOL, EURUSD_STRATEGY_TIMEFRAME, EURUSD_STRATEGY_VERSION,
  evaluateEurusdStrategy,
} from "@/lib/strategy/strategies/eurusd-strategy";
import {
  USDJPY_STRATEGY_CONFIG, USDJPY_STRATEGY_CONFIG_VERSION, USDJPY_STRATEGY_ID,
  USDJPY_STRATEGY_NAME, USDJPY_STRATEGY_SYMBOL, USDJPY_STRATEGY_TIMEFRAME,
  USDJPY_STRATEGY_VERSION_LABEL, evaluateUsdjpyStrategy,
} from "@/lib/strategy/strategies/usdjpy-strategy";
import {
  GBPUSD_STRATEGY_CONFIG, GBPUSD_STRATEGY_CONFIG_VERSION, GBPUSD_STRATEGY_ID,
  GBPUSD_STRATEGY_NAME, GBPUSD_STRATEGY_SYMBOL, GBPUSD_STRATEGY_TIMEFRAME,
  GBPUSD_STRATEGY_VERSION, evaluateGbpusdStrategy,
} from "@/lib/strategy/strategies/gbpusd-strategy";
import {
  AUDUSD_STRATEGY_CONFIG, AUDUSD_STRATEGY_CONFIG_VERSION, AUDUSD_STRATEGY_ID,
  AUDUSD_STRATEGY_NAME, AUDUSD_STRATEGY_SYMBOL, AUDUSD_STRATEGY_TIMEFRAME,
  AUDUSD_STRATEGY_VERSION, evaluateAudusdStrategy,
} from "@/lib/strategy/strategies/audusd-strategy";
import {
  NZDUSD_CONSENSUS_STRATEGY_CONFIG, NZDUSD_CONSENSUS_STRATEGY_CONFIG_VERSION, NZDUSD_CONSENSUS_STRATEGY_ID,
  NZDUSD_CONSENSUS_STRATEGY_NAME, NZDUSD_CONSENSUS_STRATEGY_SYMBOL, NZDUSD_CONSENSUS_STRATEGY_TIMEFRAME,
  NZDUSD_CONSENSUS_STRATEGY_VERSION, evaluateNzdusdConsensusStrategy,
} from "@/lib/strategy/strategies/nzdusd-consensus-strategy";
import { USDCAD_STRATEGY_CONFIG, USDCAD_STRATEGY_CONFIG_VERSION, USDCAD_STRATEGY_ID, USDCAD_STRATEGY_NAME, USDCAD_STRATEGY_SYMBOL, USDCAD_STRATEGY_TIMEFRAME, USDCAD_STRATEGY_VERSION, evaluateUsdcadStrategy } from "@/lib/strategy/strategies/usdcad-strategy";
import { USDCHF_STRATEGY_CONFIG, USDCHF_STRATEGY_CONFIG_VERSION, USDCHF_STRATEGY_ID, USDCHF_STRATEGY_NAME, USDCHF_STRATEGY_SYMBOL, USDCHF_STRATEGY_TIMEFRAME, USDCHF_STRATEGY_VERSION, evaluateUsdchfStrategy } from "@/lib/strategy/strategies/usdchf-strategy";
import { EURJPY_STRATEGY_CONFIG, EURJPY_STRATEGY_CONFIG_VERSION, EURJPY_STRATEGY_ID, EURJPY_STRATEGY_NAME, EURJPY_STRATEGY_SYMBOL, EURJPY_STRATEGY_TIMEFRAME, EURJPY_STRATEGY_VERSION, evaluateEurjpyStrategy } from "@/lib/strategy/strategies/eurjpy-strategy";
import { CADJPY_STRATEGY_CONFIG, CADJPY_STRATEGY_CONFIG_VERSION, CADJPY_STRATEGY_ID, CADJPY_STRATEGY_NAME, CADJPY_STRATEGY_SYMBOL, CADJPY_STRATEGY_TIMEFRAME, CADJPY_STRATEGY_VERSION, evaluateCadjpyStrategy } from "@/lib/strategy/strategies/cadjpy-strategy";
import { NZDJPY_STRATEGY_CONFIG, NZDJPY_STRATEGY_CONFIG_VERSION, NZDJPY_STRATEGY_ID, NZDJPY_STRATEGY_NAME, NZDJPY_STRATEGY_SYMBOL, NZDJPY_STRATEGY_TIMEFRAME, NZDJPY_STRATEGY_VERSION, evaluateNzdjpyStrategy } from "@/lib/strategy/strategies/nzdjpy-strategy";
import { AUDJPY_STRATEGY_CONFIG, AUDJPY_STRATEGY_CONFIG_VERSION, AUDJPY_STRATEGY_ID, AUDJPY_STRATEGY_NAME, AUDJPY_STRATEGY_SYMBOL, AUDJPY_STRATEGY_TIMEFRAME, AUDJPY_STRATEGY_VERSION, evaluateAudjpyStrategy } from "@/lib/strategy/strategies/audjpy-strategy";
import { EURAUD_STRATEGY_CONFIG, EURAUD_STRATEGY_CONFIG_VERSION, EURAUD_STRATEGY_ID, EURAUD_STRATEGY_NAME, EURAUD_STRATEGY_SYMBOL, EURAUD_STRATEGY_TIMEFRAME, EURAUD_STRATEGY_VERSION, evaluateEuraudStrategy } from "@/lib/strategy/strategies/euraud-strategy";

export { classifyRegime, DEFAULT_REGIME_CONFIG } from "@/lib/strategy/regime";
export type { EmaConfig } from "@/lib/strategy/strategies/ema";
export type { BreakoutConfig } from "@/lib/strategy/strategies/breakout";
export type { MomentumConfig } from "@/lib/strategy/strategies/momentum";
export type { MeanReversionConfig } from "@/lib/strategy/strategies/meanrev";
export * from "@/lib/strategy/strategies/eurusd-strategy";
export * from "@/lib/strategy/strategies/gbpusd-strategy";
export * from "@/lib/strategy/strategies/usdjpy-strategy";
export * from "@/lib/strategy/strategies/audusd-strategy";
export * from "@/lib/strategy/strategies/nzdusd-strategy.legacy";
export * from "@/lib/strategy/strategies/nzdusd-consensus-strategy";
export * from "@/lib/strategy/strategies/usdcad-strategy";
export * from "@/lib/strategy/strategies/usdchf-strategy";
export * from "@/lib/strategy/strategies/eurjpy-strategy";
export * from "@/lib/strategy/strategies/cadjpy-strategy";
export * from "@/lib/strategy/strategies/nzdjpy-strategy";
export * from "@/lib/strategy/strategies/audjpy-strategy";
export * from "@/lib/strategy/strategies/euraud-strategy";

/** The strategy_versions.name namespace for the whole multi-strategy family. */
export const MULTISTRATEGY_NAME = "adaptive-multistrategy";
/** The fresh experiment these four strategies collect into. */
export const MULTISTRATEGY_EXPERIMENT_LABEL = "multi-strategy-1";
export const STRATEGY_FAMILIES: StrategyFamily[] = ["ema", "breakout", "momentum", "meanrev"];

/**
 * The four legacy families remain available for historical/research evaluation,
 * but an empty execution allowlist prevents them from opening new paper or
 * OANDA-practice trades. Existing positions are still resolved by paper-cycle.
 */
export const LIVE_EXECUTABLE_FAMILIES: readonly StrategyFamily[] = [];

/**
 * The immutable V1 configurations, seeded into `strategy_configs`. The code
 * default IS the V1 config; the database row is the reproducible record. A
 * future parameter change is a new configVersion (EMA V2), never an edit here.
 */
export const SEED_STRATEGY_CONFIGS: Array<{ family: StrategyFamily; version: string; configVersion: string; configuration: unknown }> = [
  { family: "ema", version: emaStrategy.version, configVersion: EMA_CONFIG_VERSION, configuration: DEFAULT_EMA_CONFIG },
  { family: "breakout", version: breakoutStrategy.version, configVersion: BREAKOUT_CONFIG_VERSION, configuration: DEFAULT_BREAKOUT_CONFIG },
  { family: "momentum", version: momentumStrategy.version, configVersion: MOMENTUM_CONFIG_VERSION, configuration: DEFAULT_MOMENTUM_CONFIG },
  { family: "meanrev", version: meanReversionStrategy.version, configVersion: MEANREV_CONFIG_VERSION, configuration: DEFAULT_MEANREV_CONFIG },
];

export const strategies = { emaStrategy, breakoutStrategy, momentumStrategy, meanReversionStrategy };

/** Pair-specific registry. Each entry declares its own execution activation. */
export const PAIR_STRATEGY_REGISTRY = {
  [EURUSD_STRATEGY_SYMBOL]: {
    id: EURUSD_STRATEGY_ID,
    name: EURUSD_STRATEGY_NAME,
    version: EURUSD_STRATEGY_VERSION,
    timeframe: EURUSD_STRATEGY_TIMEFRAME,
    config: EURUSD_STRATEGY_CONFIG,
    evaluate: evaluateEurusdStrategy,
    executionEnabled: true,
    adaptiveParametersMutable: false,
    requiresActivePositionState: true,
  },
  [GBPUSD_STRATEGY_SYMBOL]: {
    id: GBPUSD_STRATEGY_ID,
    name: GBPUSD_STRATEGY_NAME,
    version: GBPUSD_STRATEGY_VERSION,
    timeframe: GBPUSD_STRATEGY_TIMEFRAME,
    config: GBPUSD_STRATEGY_CONFIG,
    evaluate: evaluateGbpusdStrategy,
    executionEnabled: true,
    adaptiveParametersMutable: false,
    requiresActivePositionState: true,
  },
  [USDJPY_STRATEGY_SYMBOL]: {
    id: USDJPY_STRATEGY_ID,
    name: USDJPY_STRATEGY_NAME,
    version: USDJPY_STRATEGY_VERSION_LABEL,
    timeframe: USDJPY_STRATEGY_TIMEFRAME,
    config: USDJPY_STRATEGY_CONFIG,
    evaluate: evaluateUsdjpyStrategy,
    executionEnabled: true,
    adaptiveParametersMutable: false,
    requiresActivePositionState: true,
  },
  [AUDUSD_STRATEGY_SYMBOL]: {
    id: AUDUSD_STRATEGY_ID,
    name: AUDUSD_STRATEGY_NAME,
    version: AUDUSD_STRATEGY_VERSION,
    timeframe: AUDUSD_STRATEGY_TIMEFRAME,
    config: AUDUSD_STRATEGY_CONFIG,
    evaluate: evaluateAudusdStrategy,
    executionEnabled: true,
    adaptiveParametersMutable: false,
    requiresActivePositionState: true,
  },
  [NZDUSD_CONSENSUS_STRATEGY_SYMBOL]: {
    id: NZDUSD_CONSENSUS_STRATEGY_ID,
    name: NZDUSD_CONSENSUS_STRATEGY_NAME,
    version: NZDUSD_CONSENSUS_STRATEGY_VERSION,
    timeframe: NZDUSD_CONSENSUS_STRATEGY_TIMEFRAME,
    config: NZDUSD_CONSENSUS_STRATEGY_CONFIG,
    evaluate: evaluateNzdusdConsensusStrategy,
    executionEnabled: true,
    adaptiveParametersMutable: false,
    requiresActivePositionState: true,
  },
  [USDCAD_STRATEGY_SYMBOL]: { id: USDCAD_STRATEGY_ID, name: USDCAD_STRATEGY_NAME, version: USDCAD_STRATEGY_VERSION, timeframe: USDCAD_STRATEGY_TIMEFRAME, config: USDCAD_STRATEGY_CONFIG, evaluate: evaluateUsdcadStrategy, executionEnabled: true, adaptiveParametersMutable: false, requiresActivePositionState: true },
  [USDCHF_STRATEGY_SYMBOL]: { id: USDCHF_STRATEGY_ID, name: USDCHF_STRATEGY_NAME, version: USDCHF_STRATEGY_VERSION, timeframe: USDCHF_STRATEGY_TIMEFRAME, config: USDCHF_STRATEGY_CONFIG, evaluate: evaluateUsdchfStrategy, executionEnabled: true, adaptiveParametersMutable: false, requiresActivePositionState: true },
  [EURJPY_STRATEGY_SYMBOL]: { id: EURJPY_STRATEGY_ID, name: EURJPY_STRATEGY_NAME, version: EURJPY_STRATEGY_VERSION, timeframe: EURJPY_STRATEGY_TIMEFRAME, config: EURJPY_STRATEGY_CONFIG, evaluate: evaluateEurjpyStrategy, executionEnabled: true, adaptiveParametersMutable: false, requiresActivePositionState: true },
  [CADJPY_STRATEGY_SYMBOL]: { id: CADJPY_STRATEGY_ID, name: CADJPY_STRATEGY_NAME, version: CADJPY_STRATEGY_VERSION, timeframe: CADJPY_STRATEGY_TIMEFRAME, config: CADJPY_STRATEGY_CONFIG, evaluate: evaluateCadjpyStrategy, executionEnabled: true, adaptiveParametersMutable: false, requiresActivePositionState: true },
  [NZDJPY_STRATEGY_SYMBOL]: { id: NZDJPY_STRATEGY_ID, name: NZDJPY_STRATEGY_NAME, version: NZDJPY_STRATEGY_VERSION, timeframe: NZDJPY_STRATEGY_TIMEFRAME, config: NZDJPY_STRATEGY_CONFIG, evaluate: evaluateNzdjpyStrategy, executionEnabled: true, adaptiveParametersMutable: false, requiresActivePositionState: true },
  [AUDJPY_STRATEGY_SYMBOL]: { id: AUDJPY_STRATEGY_ID, name: AUDJPY_STRATEGY_NAME, version: AUDJPY_STRATEGY_VERSION, timeframe: AUDJPY_STRATEGY_TIMEFRAME, config: AUDJPY_STRATEGY_CONFIG, evaluate: evaluateAudjpyStrategy, executionEnabled: true, adaptiveParametersMutable: false, requiresActivePositionState: true },
  [EURAUD_STRATEGY_SYMBOL]: { id: EURAUD_STRATEGY_ID, name: EURAUD_STRATEGY_NAME, version: EURAUD_STRATEGY_VERSION, timeframe: EURAUD_STRATEGY_TIMEFRAME, config: EURAUD_STRATEGY_CONFIG, evaluate: evaluateEuraudStrategy, executionEnabled: true, adaptiveParametersMutable: false, requiresActivePositionState: true },
} as const;

/** Pair-specific strategies that are intentionally live in the paper/practice pipeline. */
export const ENABLED_PAIR_STRATEGY_IDS = [
  EURUSD_STRATEGY_ID,
  USDJPY_STRATEGY_ID,
  GBPUSD_STRATEGY_ID,
  AUDUSD_STRATEGY_ID,
  USDCAD_STRATEGY_ID,
  USDCHF_STRATEGY_ID,
  NZDUSD_CONSENSUS_STRATEGY_ID,
  EURJPY_STRATEGY_ID,
  CADJPY_STRATEGY_ID,
  NZDJPY_STRATEGY_ID,
  AUDJPY_STRATEGY_ID,
  EURAUD_STRATEGY_ID,
] as const;

export const ENABLED_PAIR_STRATEGY_SEEDS: Array<{
  family: StrategyId; version: string; configVersion: string; configuration: unknown;
}> = [
  { family: EURUSD_STRATEGY_ID, version: EURUSD_STRATEGY_VERSION, configVersion: EURUSD_STRATEGY_CONFIG_VERSION, configuration: EURUSD_STRATEGY_CONFIG },
  {
    family: GBPUSD_STRATEGY_ID,
    version: GBPUSD_STRATEGY_VERSION,
    configVersion: GBPUSD_STRATEGY_CONFIG_VERSION,
    configuration: GBPUSD_STRATEGY_CONFIG,
  },
  {
    family: USDJPY_STRATEGY_ID,
    version: USDJPY_STRATEGY_VERSION_LABEL,
    configVersion: USDJPY_STRATEGY_CONFIG_VERSION,
    configuration: USDJPY_STRATEGY_CONFIG,
  },
  {
    family: AUDUSD_STRATEGY_ID,
    version: AUDUSD_STRATEGY_VERSION,
    configVersion: AUDUSD_STRATEGY_CONFIG_VERSION,
    configuration: AUDUSD_STRATEGY_CONFIG,
  },
  { family: USDCAD_STRATEGY_ID, version: USDCAD_STRATEGY_VERSION, configVersion: USDCAD_STRATEGY_CONFIG_VERSION, configuration: USDCAD_STRATEGY_CONFIG },
  { family: USDCHF_STRATEGY_ID, version: USDCHF_STRATEGY_VERSION, configVersion: USDCHF_STRATEGY_CONFIG_VERSION, configuration: USDCHF_STRATEGY_CONFIG },
  { family: NZDUSD_CONSENSUS_STRATEGY_ID, version: NZDUSD_CONSENSUS_STRATEGY_VERSION, configVersion: NZDUSD_CONSENSUS_STRATEGY_CONFIG_VERSION, configuration: NZDUSD_CONSENSUS_STRATEGY_CONFIG },
  { family: EURJPY_STRATEGY_ID, version: EURJPY_STRATEGY_VERSION, configVersion: EURJPY_STRATEGY_CONFIG_VERSION, configuration: EURJPY_STRATEGY_CONFIG },
  { family: CADJPY_STRATEGY_ID, version: CADJPY_STRATEGY_VERSION, configVersion: CADJPY_STRATEGY_CONFIG_VERSION, configuration: CADJPY_STRATEGY_CONFIG },
  { family: NZDJPY_STRATEGY_ID, version: NZDJPY_STRATEGY_VERSION, configVersion: NZDJPY_STRATEGY_CONFIG_VERSION, configuration: NZDJPY_STRATEGY_CONFIG },
  { family: AUDJPY_STRATEGY_ID, version: AUDJPY_STRATEGY_VERSION, configVersion: AUDJPY_STRATEGY_CONFIG_VERSION, configuration: AUDJPY_STRATEGY_CONFIG },
  { family: EURAUD_STRATEGY_ID, version: EURAUD_STRATEGY_VERSION, configVersion: EURAUD_STRATEGY_CONFIG_VERSION, configuration: EURAUD_STRATEGY_CONFIG },
];

export const REPORTING_STRATEGY_IDS: readonly StrategyId[] = [
  ...STRATEGY_FAMILIES,
  ...ENABLED_PAIR_STRATEGY_IDS,
];

/** Pair-specific evaluation stays outside adaptive selection and cannot be tuned by it. */
export function evaluateEnabledPairStrategies(input: StrategyEvaluationInput): StrategyCandidate<StrategyId>[] {
  if (input.instrument === EURUSD_STRATEGY_SYMBOL && PAIR_STRATEGY_REGISTRY[EURUSD_STRATEGY_SYMBOL].executionEnabled) return [evaluateEurusdStrategy(input)];
  if (input.instrument === GBPUSD_STRATEGY_SYMBOL && PAIR_STRATEGY_REGISTRY[GBPUSD_STRATEGY_SYMBOL].executionEnabled) return [evaluateGbpusdStrategy(input)];
  if (input.instrument === USDJPY_STRATEGY_SYMBOL && PAIR_STRATEGY_REGISTRY[USDJPY_STRATEGY_SYMBOL].executionEnabled) return [evaluateUsdjpyStrategy(input)];
  if (input.instrument === AUDUSD_STRATEGY_SYMBOL && PAIR_STRATEGY_REGISTRY[AUDUSD_STRATEGY_SYMBOL].executionEnabled) return [evaluateAudusdStrategy(input)];
  if (input.instrument === USDCAD_STRATEGY_SYMBOL && PAIR_STRATEGY_REGISTRY[USDCAD_STRATEGY_SYMBOL].executionEnabled) return [evaluateUsdcadStrategy(input)];
  if (input.instrument === USDCHF_STRATEGY_SYMBOL && PAIR_STRATEGY_REGISTRY[USDCHF_STRATEGY_SYMBOL].executionEnabled) return [evaluateUsdchfStrategy(input)];
  if (input.instrument === NZDUSD_CONSENSUS_STRATEGY_SYMBOL && PAIR_STRATEGY_REGISTRY[NZDUSD_CONSENSUS_STRATEGY_SYMBOL].executionEnabled) return [evaluateNzdusdConsensusStrategy(input)];
  if (input.instrument === EURJPY_STRATEGY_SYMBOL && PAIR_STRATEGY_REGISTRY[EURJPY_STRATEGY_SYMBOL].executionEnabled) return [evaluateEurjpyStrategy(input)];
  if (input.instrument === CADJPY_STRATEGY_SYMBOL && PAIR_STRATEGY_REGISTRY[CADJPY_STRATEGY_SYMBOL].executionEnabled) return [evaluateCadjpyStrategy(input)];
  if (input.instrument === NZDJPY_STRATEGY_SYMBOL && PAIR_STRATEGY_REGISTRY[NZDJPY_STRATEGY_SYMBOL].executionEnabled) return [evaluateNzdjpyStrategy(input)];
  if (input.instrument === AUDJPY_STRATEGY_SYMBOL && PAIR_STRATEGY_REGISTRY[AUDJPY_STRATEGY_SYMBOL].executionEnabled) return [evaluateAudjpyStrategy(input)];
  if (input.instrument === EURAUD_STRATEGY_SYMBOL && PAIR_STRATEGY_REGISTRY[EURAUD_STRATEGY_SYMBOL].executionEnabled) return [evaluateEuraudStrategy(input)];
  return [];
}

/**
 * Run all four strategies over the same instrument and regime.
 *
 * Each strategy is fully independent — it never consults another's verdict — so
 * the result may hold zero, one, or several candidates, agreeing or opposing.
 * Every candidate is returned (valid or not) so the pipeline can record them.
 */
export function evaluateAllStrategies(input: StrategyEvaluationInput, regime?: MarketRegime): { regime: MarketRegime; candidates: StrategyCandidate[] } {
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
  const resolvedRegime = regime ?? classifyRegime(input.instrument, input.candles15m, evaluatedAt, DEFAULT_REGIME_CONFIG);
  const candidates: StrategyCandidate[] = [
    evaluateEma(input, resolvedRegime, DEFAULT_EMA_CONFIG),
    evaluateBreakout(input, resolvedRegime, DEFAULT_BREAKOUT_CONFIG),
    evaluateMomentum(input, resolvedRegime, DEFAULT_MOMENTUM_CONFIG),
    evaluateMeanReversion(input, resolvedRegime, DEFAULT_MEANREV_CONFIG),
  ];
  return { regime: resolvedRegime, candidates };
}

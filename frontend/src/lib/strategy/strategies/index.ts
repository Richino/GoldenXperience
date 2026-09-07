import { classifyRegime, DEFAULT_REGIME_CONFIG } from "@/lib/strategy/regime";
import { DEFAULT_EMA_CONFIG, EMA_CONFIG_VERSION, emaStrategy, evaluateEma } from "@/lib/strategy/strategies/ema";
import { BREAKOUT_CONFIG_VERSION, breakoutStrategy, DEFAULT_BREAKOUT_CONFIG, evaluateBreakout } from "@/lib/strategy/strategies/breakout";
import { DEFAULT_MOMENTUM_CONFIG, evaluateMomentum, MOMENTUM_CONFIG_VERSION, momentumStrategy } from "@/lib/strategy/strategies/momentum";
import { DEFAULT_MEANREV_CONFIG, evaluateMeanReversion, MEANREV_CONFIG_VERSION, meanReversionStrategy } from "@/lib/strategy/strategies/meanrev";
import type { StrategyCandidate } from "@/lib/strategy/strategy";
import type { MarketRegime, StrategyEvaluationInput, StrategyFamily, StrategyId } from "@/lib/strategy/types";
import {
  EURUSD_STRATEGY_CONFIG, EURUSD_STRATEGY_ID, EURUSD_STRATEGY_NAME,
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
  NZDUSD_STRATEGY_CONFIG, NZDUSD_STRATEGY_CONFIG_VERSION, NZDUSD_STRATEGY_ID,
  NZDUSD_STRATEGY_NAME, NZDUSD_STRATEGY_SYMBOL, NZDUSD_STRATEGY_TIMEFRAME,
  NZDUSD_STRATEGY_VERSION, evaluateNzdusdStrategy,
} from "@/lib/strategy/strategies/nzdusd-strategy";

export { classifyRegime, DEFAULT_REGIME_CONFIG } from "@/lib/strategy/regime";
export type { EmaConfig } from "@/lib/strategy/strategies/ema";
export type { BreakoutConfig } from "@/lib/strategy/strategies/breakout";
export type { MomentumConfig } from "@/lib/strategy/strategies/momentum";
export type { MeanReversionConfig } from "@/lib/strategy/strategies/meanrev";
export * from "@/lib/strategy/strategies/eurusd-strategy";
export * from "@/lib/strategy/strategies/gbpusd-strategy";
export * from "@/lib/strategy/strategies/usdjpy-strategy";
export * from "@/lib/strategy/strategies/audusd-strategy";
export * from "@/lib/strategy/strategies/nzdusd-strategy";

/** The strategy_versions.name namespace for the whole multi-strategy family. */
export const MULTISTRATEGY_NAME = "adaptive-multistrategy";
/** The fresh experiment these four strategies collect into. */
export const MULTISTRATEGY_EXPERIMENT_LABEL = "multi-strategy-1";
export const STRATEGY_FAMILIES: StrategyFamily[] = ["ema", "breakout", "momentum", "meanrev"];

/**
 * Families allowed to open paper trades. THE single authoritative allowlist —
 * `toAdaptiveCandidate` reads this and nothing else decides executability.
 *
 * All four are enabled. Momentum's DIRECTION is inverted at execution time by
 * `momentum-inversion-v1`, which is a separate policy applied after a signal
 * exists; this list governs only whether a family may trade at all, never which
 * way. Nothing here alters any strategy's signal generation.
 *
 * The prior value was `[]`, which suppressed every family after walk-forward
 * research found no sealed-holdout winner. That gate is deliberately lifted so
 * the four-family engine can trade on the practice account and produce the
 * forward evidence the inversion experiment needs.
 */
export const LIVE_EXECUTABLE_FAMILIES: readonly StrategyFamily[] = [
  "ema",
  "breakout",
  "momentum",
  "meanrev",
];

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
    executionEnabled: false,
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
  [NZDUSD_STRATEGY_SYMBOL]: {
    id: NZDUSD_STRATEGY_ID,
    name: NZDUSD_STRATEGY_NAME,
    version: NZDUSD_STRATEGY_VERSION,
    timeframe: NZDUSD_STRATEGY_TIMEFRAME,
    config: NZDUSD_STRATEGY_CONFIG,
    evaluate: evaluateNzdusdStrategy,
    executionEnabled: true,
    adaptiveParametersMutable: false,
    requiresActivePositionState: true,
  },
} as const;

/** Pair-specific strategies that are intentionally live in the paper/practice pipeline. */
export const ENABLED_PAIR_STRATEGY_IDS = [GBPUSD_STRATEGY_ID, USDJPY_STRATEGY_ID, AUDUSD_STRATEGY_ID, NZDUSD_STRATEGY_ID] as const;

export const ENABLED_PAIR_STRATEGY_SEEDS: Array<{
  family: StrategyId; version: string; configVersion: string; configuration: unknown;
}> = [
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
  {
    family: NZDUSD_STRATEGY_ID,
    version: NZDUSD_STRATEGY_VERSION,
    configVersion: NZDUSD_STRATEGY_CONFIG_VERSION,
    configuration: NZDUSD_STRATEGY_CONFIG,
  },
];

export const REPORTING_STRATEGY_IDS: readonly StrategyId[] = [
  ...STRATEGY_FAMILIES,
  ...ENABLED_PAIR_STRATEGY_IDS,
];

/** Pair-specific evaluation stays outside adaptive selection and cannot be tuned by it. */
export function evaluateEnabledPairStrategies(input: StrategyEvaluationInput): StrategyCandidate<StrategyId>[] {
  if (input.instrument === GBPUSD_STRATEGY_SYMBOL) return [evaluateGbpusdStrategy(input)];
  if (input.instrument === USDJPY_STRATEGY_SYMBOL) return [evaluateUsdjpyStrategy(input)];
  if (input.instrument === AUDUSD_STRATEGY_SYMBOL) return [evaluateAudusdStrategy(input)];
  if (input.instrument === NZDUSD_STRATEGY_SYMBOL) return [evaluateNzdusdStrategy(input)];
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

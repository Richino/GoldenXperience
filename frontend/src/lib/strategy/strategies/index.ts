import { classifyRegime, DEFAULT_REGIME_CONFIG } from "@/lib/strategy/regime";
import { DEFAULT_EMA_CONFIG, EMA_CONFIG_VERSION, emaStrategy, evaluateEma } from "@/lib/strategy/strategies/ema";
import { BREAKOUT_CONFIG_VERSION, breakoutStrategy, DEFAULT_BREAKOUT_CONFIG, evaluateBreakout } from "@/lib/strategy/strategies/breakout";
import { DEFAULT_MOMENTUM_CONFIG, evaluateMomentum, MOMENTUM_CONFIG_VERSION, momentumStrategy } from "@/lib/strategy/strategies/momentum";
import { DEFAULT_MEANREV_CONFIG, evaluateMeanReversion, MEANREV_CONFIG_VERSION, meanReversionStrategy } from "@/lib/strategy/strategies/meanrev";
import type { StrategyCandidate } from "@/lib/strategy/strategy";
import type { MarketRegime, StrategyEvaluationInput, StrategyFamily } from "@/lib/strategy/types";

export { classifyRegime, DEFAULT_REGIME_CONFIG } from "@/lib/strategy/regime";
export type { EmaConfig } from "@/lib/strategy/strategies/ema";
export type { BreakoutConfig } from "@/lib/strategy/strategies/breakout";
export type { MomentumConfig } from "@/lib/strategy/strategies/momentum";
export type { MeanReversionConfig } from "@/lib/strategy/strategies/meanrev";

/** The strategy_versions.name namespace for the whole multi-strategy family. */
export const MULTISTRATEGY_NAME = "adaptive-multistrategy";
/** The fresh experiment these four strategies collect into. */
export const MULTISTRATEGY_EXPERIMENT_LABEL = "multi-strategy-1";
export const STRATEGY_FAMILIES: StrategyFamily[] = ["ema", "breakout", "momentum", "meanrev"];

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

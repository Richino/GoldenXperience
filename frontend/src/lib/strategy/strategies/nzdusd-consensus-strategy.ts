import { evaluateFrozenH1Pair, resolveFrozenH1Exit, type FrozenH1EvaluationOptions, type FrozenH1ExitInput } from "@/lib/strategy/strategies/frozen-h1-pair";
import type { StrategyEvaluationInput } from "@/lib/strategy/types";
/** The requested frozen candidate; distinct from retained pre-range V1 source. */
export const NZDUSD_CONSENSUS_STRATEGY_ID = "nzdusd_consensus_strategy" as const;
export const NZDUSD_CONSENSUS_STRATEGY_NAME = "NZDUSD Bull Consensus Structure V1" as const;
export const NZDUSD_CONSENSUS_STRATEGY_VERSION = "V1" as const;
export const NZDUSD_CONSENSUS_STRATEGY_CONFIG_VERSION = "nzdusd-consensus-v1-frozen" as const;
export const NZDUSD_CONSENSUS_STRATEGY_SYMBOL = "NZD_USD" as const;
export const NZDUSD_CONSENSUS_STRATEGY_TIMEFRAME = "H1" as const;
export const NZDUSD_CONSENSUS_STRATEGY_CONFIG = Object.freeze({ symbol: NZDUSD_CONSENSUS_STRATEGY_SYMBOL, timeframe: NZDUSD_CONSENSUS_STRATEGY_TIMEFRAME, originHourUtc: 11, direction: "LONG_ONLY", emaFastPeriod: 20, emaSlowPeriod: 50, atrPeriod: 14, consensus: ">= +3", structure: "HH_HL", stopAtr: 1, rewardR: 2, maxHoldBars: 3, executionEnabled: true, adaptiveParametersMutable: false });
export const evaluateNzdusdConsensusStrategy = (input: StrategyEvaluationInput, options: FrozenH1EvaluationOptions = {}) => evaluateFrozenH1Pair({ id: NZDUSD_CONSENSUS_STRATEGY_ID, name: NZDUSD_CONSENSUS_STRATEGY_NAME, version: NZDUSD_CONSENSUS_STRATEGY_VERSION, configVersion: NZDUSD_CONSENSUS_STRATEGY_CONFIG_VERSION, symbol: NZDUSD_CONSENSUS_STRATEGY_SYMBOL, originHour: 11, direction: "long", consensus: "bull", structure: "hhhl" }, input, options);
export const resolveNzdusdConsensusExit = (input: FrozenH1ExitInput) => resolveFrozenH1Exit(input);

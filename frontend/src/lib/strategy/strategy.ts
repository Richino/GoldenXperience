import type { MajorInstrument } from "@/types/forex";
import type {
  MarketRegime, StrategyEvaluationInput, StrategyFamily, StrategySetup,
} from "@/lib/strategy/types";

/**
 * The common contract for the four independent Phase 2 strategies.
 *
 * A candidate is exactly the existing {@link StrategySetup} — so every
 * downstream consumer (watchlist, evaluations, risk, execution) keeps working —
 * plus the explicit attribution the adaptive engine and research need. The
 * strategy-specific research features live inside `features` (the EMA/breakout/
 * momentum/mean-reversion blocks on {@link StrategyResearchFeatures}).
 *
 * Strategies are pure and deterministic: no I/O, no clock beyond `evaluatedAt`,
 * no future candles. Each returns a single candidate per instrument whose
 * `status` is `valid` (executable) or `no_setup`/`invalid` (recorded only).
 */
export interface StrategyCandidate extends StrategySetup {
  family: StrategyFamily;
  /** The strategy version, e.g. "ema-v1". */
  version: string;
  /** The immutable configuration version that produced this candidate. */
  configVersion: string;
  /** The shared market environment at decision time. */
  regime: MarketRegime;
  /** One line on why the setup qualified, or why it did not. */
  qualifyReason: string;
}

export interface Strategy<Config> {
  family: StrategyFamily;
  version: string;
  defaultConfigVersion: string;
  defaultConfig: Config;
  evaluate(input: StrategyEvaluationInput, regime: MarketRegime, config: Config): StrategyCandidate;
}

export type { MarketRegime, StrategyFamily } from "@/lib/strategy/types";

export function isExecutable(candidate: StrategyCandidate): boolean {
  return candidate.status === "valid" && candidate.direction !== null
    && candidate.entry !== null && candidate.stop !== null && candidate.target !== null;
}

export function candidateSummary(candidate: StrategyCandidate): {
  family: StrategyFamily; version: string; configVersion: string; instrument: MajorInstrument;
  direction: StrategyCandidate["direction"]; status: StrategyCandidate["status"];
  entry: number | null; stop: number | null; target: number | null; riskReward: number | null;
} {
  return {
    family: candidate.family, version: candidate.version, configVersion: candidate.configVersion,
    instrument: candidate.instrument, direction: candidate.direction, status: candidate.status,
    entry: candidate.entry, stop: candidate.stop, target: candidate.target, riskReward: candidate.riskReward,
  };
}

/**
 * Stage 1 of the EUR/USD research bot: decide only whether a material move is
 * worth examining. It never chooses long/short and is not registered for paper
 * or practice execution.
 */
import { calculateAtrValues } from "../../frontend/src/lib/strategy/indicators.js";
import type { Candle } from "../../frontend/src/types/forex.js";
import { estimateMovementOpportunity } from "./directional-research.js";

export const EUR_USD_MOVE_GATE_V1 = {
  instrument: "EUR_USD",
  timeframe: "M15",
  minimumCompletedCandles: 200,
  atrPeriod: 14,
  version: "eur-usd-move-gate-v1",
} as const;

export type EurUsdMoveGateAction = "MOVE" | "WAIT";
export type EurUsdMoveGateWaitReason =
  | "unsupported_instrument"
  | "latest_candle_incomplete"
  | "insufficient_completed_history"
  | "invalid_quote"
  | "invalid_atr"
  | "movement_threshold_not_met";

export type EurUsdMoveGateDecision = {
  version: typeof EUR_USD_MOVE_GATE_V1.version;
  action: EurUsdMoveGateAction;
  reason: "frozen_move_threshold_met" | EurUsdMoveGateWaitReason;
  observedAt: string | null;
  atr: number | null;
  expectedMoveAtr: number | null;
  costAtr: number | null;
  movementStrength: number | null;
  volatilityExpansion: number | null;
  compressionRelease: number | null;
  velocityAtr: number | null;
};

export type EurUsdMoveGateInput = {
  instrument: string;
  candles: Candle[];
  bid: number;
  ask: number;
};

function wait(reason: EurUsdMoveGateWaitReason, observedAt: string | null = null): EurUsdMoveGateDecision {
  return { version: EUR_USD_MOVE_GATE_V1.version, action: "WAIT", reason, observedAt, atr: null, expectedMoveAtr: null, costAtr: null, movementStrength: null, volatilityExpansion: null, compressionRelease: null, velocityAtr: null };
}

/**
 * Evaluates only the most recently completed M15 candle. The returned score
 * fields are diagnostics, not calibrated probabilities or a trading signal.
 */
export function evaluateEurUsdMoveGateV1(input: EurUsdMoveGateInput): EurUsdMoveGateDecision {
  if (input.instrument !== EUR_USD_MOVE_GATE_V1.instrument) return wait("unsupported_instrument");
  const latest = input.candles.at(-1);
  if (!latest?.complete) return wait("latest_candle_incomplete", latest?.time ?? null);
  const completed = input.candles.filter((candle) => candle.complete);
  if (completed.length < EUR_USD_MOVE_GATE_V1.minimumCompletedCandles) return wait("insufficient_completed_history", latest.time);
  if (!(input.bid > 0) || !(input.ask > 0) || input.ask < input.bid) return wait("invalid_quote", latest.time);

  const history = completed.slice(-EUR_USD_MOVE_GATE_V1.minimumCompletedCandles);
  const atr = calculateAtrValues(history, EUR_USD_MOVE_GATE_V1.atrPeriod).at(-1) ?? 0;
  if (!(atr > 0)) return wait("invalid_atr", latest.time);
  const spreadPips = (input.ask - input.bid) / 0.0001;
  const estimate = estimateMovementOpportunity(history, history.length - 1, atr, spreadPips, 0.0001);
  return {
    version: EUR_USD_MOVE_GATE_V1.version,
    action: estimate.qualified ? "MOVE" : "WAIT",
    reason: estimate.qualified ? "frozen_move_threshold_met" : "movement_threshold_not_met",
    observedAt: latest.time,
    atr,
    expectedMoveAtr: estimate.expectedMoveAtr,
    costAtr: estimate.costAtr,
    movementStrength: estimate.movementStrength,
    volatilityExpansion: estimate.volatilityExpansion,
    compressionRelease: estimate.compressionRelease,
    velocityAtr: estimate.velocityAtr,
  };
}

import type { Decision, Prediction } from "../types.js";
import type { ModelPrediction } from "./fit.js";

export type AbstentionThresholds = {
  minProbAdvantage: number;
  minExpectedNet: number;
  minConfidence: number;
  minModelAgreement: number;
};

export const DEFAULT_ABSTENTION: AbstentionThresholds = {
  minProbAdvantage: 0.05,
  minExpectedNet: 0.00005,
  minConfidence: 0.55,
  minModelAgreement: 0.5,
};

/**
 * Convert model output + costs into LONG / SHORT / WAIT.
 * expectedNet is already after spread/slip/safety for the long side;
 * short uses the negated expected gross with same costs.
 */
export function decide(args: {
  pred: ModelPrediction;
  spread: number;
  slip: number;
  safety: number;
  thresholds: AbstentionThresholds;
  agreement?: number;
  regimeSupported?: boolean;
  directionMode?: "both" | "long_only" | "short_only";
}): Prediction {
  const { pred, spread, slip, safety, thresholds } = args;
  const cost = spread + 2 * slip + safety;
  const expectedNetLong = pred.expectedReturn - cost;
  const expectedNetShort = -pred.expectedReturn - cost;
  const confidence = Math.max(pred.probabilityUp, 1 - pred.probabilityUp);
  const advantage = Math.abs(pred.probabilityUp - 0.5);
  const agreement = args.agreement ?? 1;
  const mode = args.directionMode ?? "both";

  if (args.regimeSupported === false) {
    return {
      decision: "wait",
      expectedNetReturn: Math.max(expectedNetLong, expectedNetShort),
      probabilityAdvantage: advantage,
      confidence,
      modelAgreement: agreement,
      reason: "unsupported_regime",
    };
  }
  if (advantage < thresholds.minProbAdvantage) {
    return wait("low_prob_advantage", expectedNetLong, expectedNetShort, advantage, confidence, agreement);
  }
  if (confidence < thresholds.minConfidence) {
    return wait("low_confidence", expectedNetLong, expectedNetShort, advantage, confidence, agreement);
  }
  if (agreement < thresholds.minModelAgreement) {
    return wait("model_disagreement", expectedNetLong, expectedNetShort, advantage, confidence, agreement);
  }

  let best: "long" | "short";
  let bestNet: number;
  if (mode === "long_only") {
    best = "long";
    bestNet = expectedNetLong;
  } else if (mode === "short_only") {
    best = "short";
    bestNet = expectedNetShort;
  } else {
    best = expectedNetLong >= expectedNetShort ? "long" : "short";
    bestNet = best === "long" ? expectedNetLong : expectedNetShort;
  }

  if (bestNet <= 0 || bestNet < thresholds.minExpectedNet) {
    return wait("nonpositive_net_edge", expectedNetLong, expectedNetShort, advantage, confidence, agreement);
  }

  return {
    decision: best,
    expectedNetReturn: bestNet,
    probabilityAdvantage: advantage,
    confidence,
    modelAgreement: agreement,
  };
}

function wait(
  reason: string,
  netLong: number,
  netShort: number,
  advantage: number,
  confidence: number,
  agreement: number,
): Prediction {
  return {
    decision: "wait" satisfies Decision,
    expectedNetReturn: Math.max(netLong, netShort),
    probabilityAdvantage: advantage,
    confidence,
    modelAgreement: agreement,
    reason,
  };
}

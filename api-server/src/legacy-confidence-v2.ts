/**
 * Legacy-confidence-v2 model loader + decision helper.
 *
 * Consumers:
 *   - dry-run hook in paper-cycle.ts (writes prediction to paper_strategy_evaluations,
 *     execution_status="research_only", DOES NOT create trades)
 *   - later, live decision hook (creates trades per the combined rule)
 *
 * See scripts/_retrain_legacy_confidence_v2.ts for how the artifact is trained
 * and scripts/_walkforward_confidence_v2.ts for the walk-forward validation.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_PATH = path.join(__dirname, "data", "legacy-confidence-v2-model.json");

export type LegacyConfidenceArtifact = {
  modelName: "legacy-confidence-v2";
  version: string;
  scoreKind: "probability";
  outputMeaning: string;
  featureNames: string[];
  intercept: number;
  coefficients: Record<string, number>;
  normalization: { mean: Record<string, number>; std: Record<string, number> };
  metadata: {
    trainedAt: string;
    trainWindowStart: string;
    trainWindowEnd: string;
    trainMonths: number;
    trainingSamples: number;
    trainingPairs: string[];
    excludedFromTraining: string[];
    inSampleAccuracy: number;
    confidenceThreshold: number;
    combinedRule: { fx: string; XAU_USD: string; other: string };
    sourceDataset: string;
  };
};

let cached: LegacyConfidenceArtifact | null = null;

export function loadLegacyConfidenceArtifact(): LegacyConfidenceArtifact {
  if (cached) return cached;
  const raw = fs.readFileSync(ARTIFACT_PATH, "utf8");
  const parsed = JSON.parse(raw) as LegacyConfidenceArtifact;
  if (parsed.modelName !== "legacy-confidence-v2") {
    throw new Error(`unexpected model artifact at ${ARTIFACT_PATH}: ${parsed.modelName}`);
  }
  cached = parsed;
  return parsed;
}

/** Reset the in-memory cache so tests / scheduled retrains pick up a new artifact. */
export function clearLegacyConfidenceCache(): void { cached = null; }

/**
 * Ages the loaded artifact against wall clock. If it's older than maxAgeDays,
 * callers should skip taking model-directed trades (fall back to baseline).
 */
export function artifactAgeDays(artifact: LegacyConfidenceArtifact = loadLegacyConfidenceArtifact()): number {
  return (Date.now() - Date.parse(artifact.metadata.trainedAt)) / 86400e3;
}

/**
 * Raw feature vector at a decision bar. Feed this into predictPLong().
 * Must be computed the same way as scripts/_retrain_legacy_confidence_v2.ts:
 *   atrPct      = trailing-500-bar rank of current ATR14 (0..1)
 *   atrRatio    = ATR14 / ATR50
 *   hourEt      = 0..23, ET clock
 *   dayOfWeek   = 0..4 (Mon..Fri) — Sat/Sun should never occur on a live setup
 *   rsiVelocity = (rsi14[i] - rsi14[i-3]) / 3
 *   rangePos    = (close - low_20) / (high_20 - low_20), 0..1
 *   mom3        = (close - close_{i-3}) / close
 */
export type LegacyConfidenceFeatures = {
  atrPct: number; atrRatio: number; hourEt: number; dayOfWeek: number;
  rsiVelocity: number; rangePos: number; mom3: number;
};

function sigmoid(z: number): number { return 1 / (1 + Math.exp(-z)); }

export function predictPLong(features: LegacyConfidenceFeatures, artifact: LegacyConfidenceArtifact = loadLegacyConfidenceArtifact()): number {
  const { coefficients, intercept, normalization } = artifact;
  let z = intercept;
  for (const name of artifact.featureNames) {
    const raw = features[name as keyof LegacyConfidenceFeatures];
    if (!Number.isFinite(raw)) return 0.5; // missing feature → no signal
    const scaled = (raw - normalization.mean[name]!) / (normalization.std[name] || 1);
    z += scaled * (coefficients[name] ?? 0);
  }
  return sigmoid(z);
}

/**
 * Apply the combined rule to a legacy-strategy setup.
 * Returns the decision the paper engine should make.
 *
 * The rule (validated in scripts/_walkforward_confidence_v2.ts):
 *   - XAU_USD → always take the legacy stack direction (do not consult model)
 *   - other pairs → take model pick when model DISAGREES with stack AND
 *                   |pLong - 0.5| >= confidenceThreshold; otherwise SKIP
 */
export type LegacyConfidenceDecision =
  | { action: "take_baseline"; direction: "long" | "short"; reason: "xau_always_baseline" }
  | { action: "take_model_pick"; direction: "long" | "short"; originalDirection: "long" | "short"; pLong: number; reason: "confident_disagreement" }
  | { action: "skip"; reason: "low_confidence" | "model_agrees_with_stack" | "artifact_stale" | "missing_feature" };

export function decideDirection(params: {
  pair: string;
  legacyDirection: "long" | "short";
  features: LegacyConfidenceFeatures;
  maxArtifactAgeDays?: number; // guardrail; default 14
}): { decision: LegacyConfidenceDecision; pLong: number; artifactVersion: string; trainedAt: string } {
  const artifact = loadLegacyConfidenceArtifact();
  const maxAge = params.maxArtifactAgeDays ?? 14;

  if (artifactAgeDays(artifact) > maxAge) {
    return {
      decision: { action: "skip", reason: "artifact_stale" },
      pLong: NaN, artifactVersion: artifact.version, trainedAt: artifact.metadata.trainedAt,
    };
  }

  // XAU always takes baseline — do not consult model
  if (params.pair === "XAU_USD") {
    return {
      decision: { action: "take_baseline", direction: params.legacyDirection, reason: "xau_always_baseline" },
      pLong: NaN, artifactVersion: artifact.version, trainedAt: artifact.metadata.trainedAt,
    };
  }

  const pLong = predictPLong(params.features, artifact);
  if (!Number.isFinite(pLong)) {
    return {
      decision: { action: "skip", reason: "missing_feature" },
      pLong, artifactVersion: artifact.version, trainedAt: artifact.metadata.trainedAt,
    };
  }

  const modelPick: "long" | "short" = pLong >= 0.5 ? "long" : "short";
  const disagrees = modelPick !== params.legacyDirection;
  const confidenceOk = Math.abs(pLong - 0.5) >= artifact.metadata.confidenceThreshold;

  if (disagrees && confidenceOk) {
    return {
      decision: {
        action: "take_model_pick",
        direction: modelPick,
        originalDirection: params.legacyDirection,
        pLong,
        reason: "confident_disagreement",
      },
      pLong, artifactVersion: artifact.version, trainedAt: artifact.metadata.trainedAt,
    };
  }

  return {
    decision: {
      action: "skip",
      reason: disagrees ? "low_confidence" : "model_agrees_with_stack",
    },
    pLong, artifactVersion: artifact.version, trainedAt: artifact.metadata.trainedAt,
  };
}

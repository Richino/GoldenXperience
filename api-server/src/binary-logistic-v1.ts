import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BinaryDecision, BinaryFeatures } from "./binary-engine.js";

export const BINARY_LOGISTIC_MODEL_NAME = "binary-logistic-v1";
export const BINARY_LOGISTIC_MODEL_VERSION = "1.0.0";

const SESSIONS = ["New York", "London", "London/New York overlap"] as const;

export type BinaryLogisticArtifact = {
  modelName: string;
  version: string;
  horizonMinutes: number;
  horizonSeconds: number;
  scoreKind: "probability";
  featureNames: string[];
  intercept: number;
  coefficients: Record<string, number>;
  normalization: {
    mean: Record<string, number>;
    std: Record<string, number>;
  };
  metadata: Record<string, unknown>;
};

export type BinaryLogisticVector = Record<string, number | null>;

export type BinaryLogisticInference = {
  direction: "up" | "down";
  confidence: number;
  rawProbabilityUp: number;
  scaledFeatures: Record<string, number>;
  skipReason?: never;
};

export type BinaryLogisticSkip = {
  skipReason: string;
  direction?: never;
  confidence?: never;
  rawProbabilityUp?: never;
  scaledFeatures?: never;
};

export type BinaryLogisticResult = BinaryLogisticInference | BinaryLogisticSkip;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Map persisted BinaryFeatures to the training script's 25-feature vector. */
export function vectorizeBinaryFeatures(features: BinaryFeatures): BinaryLogisticVector {
  const candle = features.candle;
  const emaGapPct = num(features.emaFast) != null && num(features.emaSlow) != null && features.referenceClose
    ? (features.emaFast! - features.emaSlow!) / features.referenceClose
    : null;
  const hour = num(features.hourEt) ?? 0;
  return {
    mom_m1: num(features.momentumPips.m1),
    mom_m5: num(features.momentumPips.m5),
    mom_m10: num(features.momentumPips.m10),
    mom_m15: num(features.momentumPips.m15),
    ret_m1: num(features.returnPct.m1),
    ret_m5: num(features.returnPct.m5),
    ret_m10: num(features.returnPct.m10),
    ret_m15: num(features.returnPct.m15),
    atrPips: num(features.atrPips),
    emaGapPct,
    volatilityPips: num(features.volatilityPips),
    bodyPips: candle ? num(candle.bodyPips) : null,
    bodyRatio: candle ? num(candle.bodyRatio) : null,
    upperWick: candle ? num(candle.upperWickPips) : null,
    lowerWick: candle ? num(candle.lowerWickPips) : null,
    distHigh: num(features.distanceFromHighPips),
    distLow: num(features.distanceFromLowPips),
    spreadPips: num(features.spreadPips),
    hour_sin: Math.sin((2 * Math.PI * hour) / 24),
    hour_cos: Math.cos((2 * Math.PI * hour) / 24),
    trend_up: features.trend === "up" ? 1 : 0,
    trend_down: features.trend === "down" ? 1 : 0,
    sess_ny: features.session === SESSIONS[0] ? 1 : 0,
    sess_ldn: features.session === SESSIONS[1] ? 1 : 0,
    sess_ovl: features.session === SESSIONS[2] ? 1 : 0,
  };
}

function sigmoid(z: number) {
  return 1 / (1 + Math.exp(-z));
}

/** Standardize a raw feature vector using frozen train-time mean/std. Null → train mean → 0 after standardize. */
export function standardizeBinaryLogisticFeatures(
  raw: BinaryLogisticVector,
  artifact: BinaryLogisticArtifact,
): Record<string, number> {
  const scaled: Record<string, number> = {};
  for (const name of artifact.featureNames) {
    const value = raw[name];
    if (value == null) {
      scaled[name] = 0;
      continue;
    }
    const mean = artifact.normalization.mean[name] ?? 0;
    const std = artifact.normalization.std[name] ?? 1;
    scaled[name] = (value - mean) / std;
  }
  return scaled;
}

export function probabilityUpFromScaledFeatures(
  scaled: Record<string, number>,
  artifact: BinaryLogisticArtifact,
): number {
  let logit = artifact.intercept;
  for (const name of artifact.featureNames) {
    logit += (artifact.coefficients[name] ?? 0) * (scaled[name] ?? 0);
  }
  return sigmoid(logit);
}

export function inferBinaryLogistic(
  features: BinaryFeatures,
  artifact: BinaryLogisticArtifact,
): BinaryLogisticResult {
  const raw = vectorizeBinaryFeatures(features);
  for (const name of artifact.featureNames) {
    if (!(name in raw)) {
      return { skipReason: `Missing required feature "${name}" in vectorizer output.` };
    }
  }
  const scaled = standardizeBinaryLogisticFeatures(raw, artifact);
  const rawProbabilityUp = probabilityUpFromScaledFeatures(scaled, artifact);
  if (!Number.isFinite(rawProbabilityUp)) {
    return { skipReason: "Logistic inference produced a non-finite probability." };
  }
  const direction: "up" | "down" = rawProbabilityUp >= 0.5 ? "up" : "down";
  const confidence = direction === "up" ? rawProbabilityUp : 1 - rawProbabilityUp;
  return { direction, confidence, rawProbabilityUp, scaledFeatures: scaled };
}

export function binaryLogisticDecision(result: BinaryLogisticInference): BinaryDecision {
  return {
    direction: result.direction,
    score: result.confidence,
    rationale: `Logistic p(up)=${result.rawProbabilityUp.toFixed(4)} → ${result.direction.toUpperCase()} (confidence ${result.confidence.toFixed(4)}).`,
  };
}

let cachedArtifact: BinaryLogisticArtifact | null = null;

export function loadBinaryLogisticArtifact(customPath?: string): BinaryLogisticArtifact {
  if (cachedArtifact && !customPath) return cachedArtifact;
  const artifactPath = customPath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "binary-logistic-v1.json");
  const parsed = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as BinaryLogisticArtifact;
  if (parsed.modelName !== BINARY_LOGISTIC_MODEL_NAME) {
    throw new Error(`Expected model ${BINARY_LOGISTIC_MODEL_NAME}, got ${parsed.modelName}`);
  }
  if (!customPath) cachedArtifact = parsed;
  return parsed;
}

export function createBinaryLogisticModel(artifact = loadBinaryLogisticArtifact()) {
  return {
    name: BINARY_LOGISTIC_MODEL_NAME,
    version: BINARY_LOGISTIC_MODEL_VERSION,
    scoreKind: "probability" as const,
    artifact,
    evaluate(features: BinaryFeatures): BinaryLogisticResult {
      return inferBinaryLogistic(features, artifact);
    },
  };
}

export function isBinaryLogisticShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.BINARY_LOGISTIC_SHADOW_ENABLED ?? "false").toLowerCase() === "true";
}

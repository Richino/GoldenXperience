/**
 * Breakout-confidence-v1 model loader + decision helper.
 *
 * Trained on 8,316 breakout opportunities (EUR/GBP/USD_JPY, 2016-2025).
 * Walk-forward: +0.141R/trade, 68% winrate, 36/37 windows beat baseline.
 *
 * Applied to LIVE breakout candidates (from getMultiStrategySnapshot). When the
 * model confidently disagrees with the strategy's direction, we invert. Same
 * pattern as legacy-confidence-v2 but with a breakout-specific feature set
 * (session/regime/volBucket categorical + trendStrength/atrPips/spreadPips/quality/hour/day).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_PATH = path.join(__dirname, "data", "breakout-confidence-v1-model.json");

export type BreakoutConfidenceArtifact = {
  modelName: "breakout-confidence-v1";
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
    trainingSamples: number;
    trainingPairs: string[];
    inSampleAccuracy: number;
    confidenceThreshold: number;
    combinedRule: { fx: string; other: string };
    sourceDataset: string;
  };
};

let cached: BreakoutConfidenceArtifact | null = null;
export function loadBreakoutConfidenceArtifact(): BreakoutConfidenceArtifact {
  if (cached) return cached;
  const parsed = JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf8")) as BreakoutConfidenceArtifact;
  if (parsed.modelName !== "breakout-confidence-v1") {
    throw new Error(`unexpected model artifact at ${ARTIFACT_PATH}: ${parsed.modelName}`);
  }
  cached = parsed;
  return parsed;
}
export function clearBreakoutConfidenceCache(): void { cached = null; }
export function breakoutArtifactAgeDays(artifact: BreakoutConfidenceArtifact = loadBreakoutConfidenceArtifact()): number {
  return (Date.now() - Date.parse(artifact.metadata.trainedAt)) / 86400e3;
}

const SESSIONS = ["London", "New York", "London/New York overlap", "Off"];
const REGIMES = ["trending", "ranging", "mixed"];
const VOL_BUCKETS = ["low", "normal", "high"];
const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"];

export type BreakoutConfidenceRawFeatures = {
  session: string;
  regime: string;
  volBucket: string;
  pair: string;
  trendStrength: number;
  atrPips: number;
  spreadPips: number;
  quality: number;
  hourEt: number;
  dayOfWeek: number;
};

function vectorize(f: BreakoutConfidenceRawFeatures): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of SESSIONS) out[`session_${s.replace(/[^A-Za-z]/g, "")}`] = f.session === s ? 1 : 0;
  for (const r of REGIMES) out[`regime_${r}`] = f.regime === r ? 1 : 0;
  for (const v of VOL_BUCKETS) out[`vol_${v}`] = f.volBucket === v ? 1 : 0;
  for (const p of PAIRS) out[`pair_${p}`] = f.pair === p ? 1 : 0;
  out.trendStrength = f.trendStrength;
  out.atrPips = f.atrPips;
  out.spreadPips = f.spreadPips;
  out.quality = f.quality;
  out.hourEt = f.hourEt;
  out.dayOfWeek = f.dayOfWeek;
  return out;
}

function sigmoid(z: number): number { return 1 / (1 + Math.exp(-z)); }

export function predictBreakoutPLong(
  features: BreakoutConfidenceRawFeatures,
  artifact: BreakoutConfidenceArtifact = loadBreakoutConfidenceArtifact(),
): number {
  const raw = vectorize(features);
  let z = artifact.intercept;
  for (const name of artifact.featureNames) {
    const v = raw[name];
    if (!Number.isFinite(v)) return 0.5;
    const scaled = (v! - artifact.normalization.mean[name]!) / (artifact.normalization.std[name] || 1);
    z += scaled * (artifact.coefficients[name] ?? 0);
  }
  return sigmoid(z);
}

export type BreakoutConfidenceDecision =
  | { action: "take_model_pick"; direction: "long" | "short"; originalDirection: "long" | "short"; pLong: number; reason: "confident_disagreement" }
  | { action: "skip"; reason: "low_confidence" | "model_agrees_with_stack" | "artifact_stale" | "pair_not_trained" };

export function decideBreakoutDirection(params: {
  pair: string;
  breakoutDirection: "long" | "short";
  features: BreakoutConfidenceRawFeatures;
  maxArtifactAgeDays?: number;
}): { decision: BreakoutConfidenceDecision; pLong: number; artifactVersion: string; trainedAt: string } {
  const artifact = loadBreakoutConfidenceArtifact();
  const maxAge = params.maxArtifactAgeDays ?? 14;
  if (breakoutArtifactAgeDays(artifact) > maxAge) {
    return {
      decision: { action: "skip", reason: "artifact_stale" },
      pLong: NaN, artifactVersion: artifact.version, trainedAt: artifact.metadata.trainedAt,
    };
  }
  // Model was trained only on EUR_USD, GBP_USD, USD_JPY — other pairs are out-of-distribution
  if (!artifact.metadata.trainingPairs.includes(params.pair)) {
    return {
      decision: { action: "skip", reason: "pair_not_trained" },
      pLong: NaN, artifactVersion: artifact.version, trainedAt: artifact.metadata.trainedAt,
    };
  }
  const pLong = predictBreakoutPLong(params.features, artifact);
  const modelPick: "long" | "short" = pLong >= 0.5 ? "long" : "short";
  const disagrees = modelPick !== params.breakoutDirection;
  const confidenceOk = Math.abs(pLong - 0.5) >= artifact.metadata.confidenceThreshold;
  if (disagrees && confidenceOk) {
    return {
      decision: {
        action: "take_model_pick", direction: modelPick,
        originalDirection: params.breakoutDirection, pLong,
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

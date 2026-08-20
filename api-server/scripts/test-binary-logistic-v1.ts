import assert from "node:assert/strict";

import { createBaselineModel, type BinaryFeatures } from "../src/binary-engine.js";
import {
  binaryLogisticDecision,
  inferBinaryLogistic,
  isBinaryLogisticShadowEnabled,
  loadBinaryLogisticArtifact,
  probabilityUpFromScaledFeatures,
  standardizeBinaryLogisticFeatures,
  vectorizeBinaryFeatures,
} from "../src/binary-logistic-v1.js";

const artifact = loadBinaryLogisticArtifact();

function sampleFeatures(overrides: Partial<BinaryFeatures> = {}): BinaryFeatures {
  return {
    momentumPips: { m1: 0.5, m5: 1.2, m10: 0.8, m15: 1.5 },
    returnPct: { m1: 0.0001, m5: 0.0002, m10: 0.00015, m15: 0.0003 },
    trend: "up",
    emaFast: 1.10010,
    emaSlow: 1.10000,
    atrPips: 1.1,
    volatilityPips: 0.7,
    candle: { bodyPips: 0.6, upperWickPips: 0.2, lowerWickPips: 0.3, bodyRatio: 0.55 },
    distanceFromHighPips: 2.2,
    distanceFromLowPips: 2.4,
    spreadPips: 0.8,
    session: "London/New York overlap",
    hourEt: 10,
    timeOfDayBucket: "08-12 ET",
    referenceClose: 1.10005,
    referenceCloseTime: "2026-01-06T10:39:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Feature-order safety: reordering object keys must not change inference.
// ---------------------------------------------------------------------------
const features = sampleFeatures();
const rawA = vectorizeBinaryFeatures(features);
const rawB = Object.fromEntries(Object.entries(rawA).reverse()) as typeof rawA;
const scaledA = standardizeBinaryLogisticFeatures(rawA, artifact);
const scaledB = standardizeBinaryLogisticFeatures(rawB, artifact);
const pA = probabilityUpFromScaledFeatures(scaledA, artifact);
const pB = probabilityUpFromScaledFeatures(scaledB, artifact);
assert.equal(pA, pB, "feature object key order must not change probability");

// ---------------------------------------------------------------------------
// Deterministic inference: preprocessing → logit → sigmoid matches training script.
// ---------------------------------------------------------------------------
const inference = inferBinaryLogistic(features, artifact);
assert.ok(!("skipReason" in inference), "complete features produce a prediction");
assert.ok(Number.isFinite(inference.rawProbabilityUp), "raw p(up) is finite");
assert.ok(inference.confidence >= 0.5 && inference.confidence <= 1, "confidence is a valid probability for the chosen direction");
if (inference.rawProbabilityUp >= 0.5) {
  assert.equal(inference.direction, "up");
  assert.equal(inference.confidence, inference.rawProbabilityUp);
} else {
  assert.equal(inference.direction, "down");
  assert.equal(inference.confidence, 1 - inference.rawProbabilityUp);
}

// Recompute manually from artifact to verify determinism.
let manualLogit = artifact.intercept;
const raw = vectorizeBinaryFeatures(features);
const scaled = standardizeBinaryLogisticFeatures(raw, artifact);
for (const name of artifact.featureNames) {
  manualLogit += (artifact.coefficients[name] ?? 0) * (scaled[name] ?? 0);
}
const manualP = 1 / (1 + Math.exp(-manualLogit));
assert.equal(inference.rawProbabilityUp, manualP, "runtime inference matches manual logit calculation");

// ---------------------------------------------------------------------------
// Confidence semantics
// ---------------------------------------------------------------------------
const highUp = inferBinaryLogistic(sampleFeatures({ trend: "up", atrPips: 2.5 }), artifact);
assert.ok(!("skipReason" in highUp));
if (highUp.rawProbabilityUp >= 0.5) {
  assert.equal(highUp.direction, "up");
  assert.equal(highUp.confidence, highUp.rawProbabilityUp);
}

// Force a down-leaning vector by inverting strong up momentum while keeping required fields.
const downLean = inferBinaryLogistic(sampleFeatures({
  momentumPips: { m1: -5, m5: -8, m10: -6, m15: -10 },
  returnPct: { m1: -0.001, m5: -0.002, m10: -0.0015, m15: -0.003 },
  trend: "down",
  emaFast: 1.09990,
  emaSlow: 1.10010,
}), artifact);
assert.ok(!("skipReason" in downLean));
if (downLean.rawProbabilityUp < 0.5) {
  assert.equal(downLean.direction, "down");
  assert.equal(downLean.confidence, 1 - downLean.rawProbabilityUp);
}

// ---------------------------------------------------------------------------
// Missing-data handling matches training: null → train mean → 0 after standardize.
// ---------------------------------------------------------------------------
const withNulls = inferBinaryLogistic(sampleFeatures({
  momentumPips: { m1: null, m5: null, m10: null, m15: null },
  returnPct: { m1: null, m5: null, m10: null, m15: null },
  atrPips: null,
  volatilityPips: null,
  candle: null,
  distanceFromHighPips: null,
  distanceFromLowPips: null,
  spreadPips: null,
}), artifact);
assert.ok(!("skipReason" in withNulls), "null features are imputed like training, not rejected");

const nullRaw = vectorizeBinaryFeatures(sampleFeatures({
  momentumPips: { m1: null, m5: 1, m10: 1, m15: 1 },
  returnPct: { m1: null, m5: 0.0001, m10: 0.0001, m15: 0.0001 },
}));
const nullScaled = standardizeBinaryLogisticFeatures(nullRaw, artifact);
assert.equal(nullScaled.mom_m1, 0, "null mom_m1 standardizes to 0 (train mean imputation)");

// ---------------------------------------------------------------------------
// Shadow isolation: baseline evaluate is independent of logistic module.
// ---------------------------------------------------------------------------
const baseline = createBaselineModel();
const upTrend = sampleFeatures();
const baselineBefore = baseline.evaluate(upTrend);
const _ = inferBinaryLogistic(upTrend, artifact);
const baselineAfter = baseline.evaluate(upTrend);
assert.deepEqual(baselineBefore, baselineAfter, "logistic inference must not mutate baseline output");

assert.equal(isBinaryLogisticShadowEnabled({}), false, "shadow disabled by default");
assert.equal(isBinaryLogisticShadowEnabled({ BINARY_LOGISTIC_SHADOW_ENABLED: "false" }), false);
assert.equal(isBinaryLogisticShadowEnabled({ BINARY_LOGISTIC_SHADOW_ENABLED: "true" }), true);

// ---------------------------------------------------------------------------
// Resolution semantics via decision mapping (direction used by classifyBinaryResult).
// ---------------------------------------------------------------------------
const decision = binaryLogisticDecision(inference);
assert.equal(decision.direction, inference.direction);
assert.equal(decision.score, inference.confidence);
assert.ok(decision.rationale.includes("Logistic p(up)="));

// ---------------------------------------------------------------------------
// Artifact integrity
// ---------------------------------------------------------------------------
assert.equal(artifact.modelName, "binary-logistic-v1");
assert.equal(artifact.featureNames.length, 25);
assert.equal(artifact.metadata.trainedSamples, 1713);
assert.equal(artifact.metadata.testSamples, 735);
assert.equal(artifact.metadata.trainingMethod, "chronological 70/30 split");

console.log("Binary-logistic-v1 checks passed.");

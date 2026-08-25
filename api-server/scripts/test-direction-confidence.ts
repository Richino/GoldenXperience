import assert from "node:assert/strict";
import {
  STRICT_DIRECTIONAL_CONFIDENCE_CONFIG,
  createDirectionalEvidenceStore,
  decideDirectionalAction,
  recordDirectionalEvidence,
} from "../src/adaptive-engine.js";

const context = {
  family: "ema",
  instrument: "EUR_USD",
  session: "London",
  regime: "trending",
  confirmationType: "range_close_hold",
  direction: "long",
};

// Strict mode makes WAIT the honest default. No fabricated cold-start direction.
const empty = createDirectionalEvidenceStore();
const cold = decideDirectionalAction(empty, context, STRICT_DIRECTIONAL_CONFIDENCE_CONFIG);
assert.equal(cold.action, "skip");
assert.equal(cold.preferredAction, null);
assert.equal(cold.confidenceScore, 0);
assert.equal(cold.evidenceQuality, "insufficient");

// A strong FOLLOW history remains unavailable until the frozen sample threshold.
const followStore = createDirectionalEvidenceStore();
for (let index = 0; index < 99; index += 1) recordDirectionalEvidence(followStore, context, 0.6, -0.6);
assert.equal(decideDirectionalAction(followStore, context, STRICT_DIRECTIONAL_CONFIDENCE_CONFIG).action, "skip");
recordDirectionalEvidence(followStore, context, 0.6, -0.6);
const follow = decideDirectionalAction(followStore, context, STRICT_DIRECTIONAL_CONFIDENCE_CONFIG);
assert.equal(follow.action, "follow");
assert.equal(follow.preferredAction, "follow");
assert.equal(follow.evidenceQuality, "supported");
assert.ok(follow.confidenceScore >= 95 && follow.confidenceScore <= 100);
assert.ok((follow.directionAccuracyLower ?? 0) > 0.5);
assert.ok((follow.followExpectancy ?? 0) > 0);

// Context isolation is the past-only contract: evidence from another family
// cannot authorize a decision here.
const unseen = decideDirectionalAction(followStore, { ...context, family: "breakout" }, STRICT_DIRECTIONAL_CONFIDENCE_CONFIG);
assert.equal(unseen.action, "skip");
assert.equal(unseen.confidenceScore, 0);

// REVERSE requires its stricter 150-observation threshold even when every
// resolved paired outcome favours it.
const reverseStore = createDirectionalEvidenceStore();
for (let index = 0; index < 149; index += 1) recordDirectionalEvidence(reverseStore, context, -0.5, 0.5);
assert.equal(decideDirectionalAction(reverseStore, context, STRICT_DIRECTIONAL_CONFIDENCE_CONFIG).action, "skip");
recordDirectionalEvidence(reverseStore, context, -0.5, 0.5);
const reversed = decideDirectionalAction(reverseStore, context, STRICT_DIRECTIONAL_CONFIDENCE_CONFIG);
assert.equal(reversed.action, "reverse");
assert.equal(reversed.preferredAction, "reverse");
assert.ok(reversed.confidenceScore >= 95 && reversed.confidenceScore <= 100);

// A large but directionless sample must not gain authority merely from size.
const noisyStore = createDirectionalEvidenceStore();
for (let index = 0; index < 300; index += 1) {
  if (index % 2 === 0) recordDirectionalEvidence(noisyStore, context, 0.4, -0.4);
  else recordDirectionalEvidence(noisyStore, context, -0.4, 0.4);
}
const noisy = decideDirectionalAction(noisyStore, context, STRICT_DIRECTIONAL_CONFIDENCE_CONFIG);
assert.equal(noisy.action, "skip");
assert.equal(noisy.evidenceQuality, "weak");
assert.ok(noisy.confidenceScore >= 45 && noisy.confidenceScore <= 55);
assert.ok((noisy.directionAccuracyLower ?? 1) < 0.5);

console.log("strict directional confidence tests passed");


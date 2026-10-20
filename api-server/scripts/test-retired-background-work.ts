import assert from "node:assert/strict";
import { binaryCollectionEnabled } from "../src/binary-lifecycle.js";
import { collectBinaryCycle } from "../src/binary-engine.js";
import { collectPatternV1Cycle } from "../src/pattern-v1-engine.js";
import { collectLegacyConfidenceV2Cycle } from "../src/legacy-confidence-v2-collector.js";
import { loadLegacyConfidenceArtifact } from "../src/legacy-confidence-v2.js";

assert.equal(binaryCollectionEnabled({}), false);
assert.equal(binaryCollectionEnabled({ BINARY_ENABLED: "false" }), false);
assert.equal(binaryCollectionEnabled({ BINARY_ENABLED: "true" }), true);
// A retired collector must return before touching any database or provider.
delete process.env.DATABASE_URL;
process.env.BINARY_ENABLED = "false";
let requests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { requests++; throw new Error("Unexpected provider call"); };
const artifact = loadLegacyConfidenceArtifact();
const trainedAt = artifact.metadata.trainedAt;
try {
  assert.deepEqual(await collectBinaryCycle(), { opened: 0, resolved: 0, evaluated: 0, reason: "Binary predictions are retired." });
  assert.deepEqual(await collectPatternV1Cycle(), { evaluated: 0, fired: 0, opened: 0, duplicates: 0, reason: "Binary predictions are retired." });
  process.env.LEGACY_CONFIDENCE_V2_ENABLED = "true";
  process.env.OANDA_API_KEY = "test-only-placeholder";
  for (const date of [new Date(Date.now() - 15 * 86400000).toISOString(), "invalid", new Date(Date.now() + 86400000).toISOString()]) {
    artifact.metadata.trainedAt = date;
    const result = await collectLegacyConfidenceV2Cycle();
    assert.equal(result.ran, false);
    assert.equal(result.pairsChecked, 0);
    assert.match(result.reason ?? "", /artifact is stale or has an invalid training date/);
  }
  assert.equal(requests, 0);
} finally {
  artifact.metadata.trainedAt = trainedAt;
  globalThis.fetch = originalFetch;
}
console.log("Retirement checks passed: binary collectors make no DB/provider calls; stale/invalid legacy models fetch no candles.");

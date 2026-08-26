import { loadLegacyConfidenceArtifact, predictPLong, decideDirection, artifactAgeDays } from "../src/legacy-confidence-v2.js";

const a = loadLegacyConfidenceArtifact();
console.log("model:", a.modelName, "v" + a.version, "| trained:", a.metadata.trainedAt, "| age (days):", artifactAgeDays(a).toFixed(2));
console.log("training samples:", a.metadata.trainingSamples, "| threshold:", a.metadata.confidenceThreshold);

const f = { atrPct: 0.5, atrRatio: 1.0, hourEt: 9, dayOfWeek: 2, rsiVelocity: 0, rangePos: 0.5, mom3: 0 };
console.log("\nneutral features       -> pLong =", predictPLong(f).toFixed(4));
const bull = { ...f, rangePos: 0.9, mom3: 0.002, rsiVelocity: 3 };
console.log("bullish features       -> pLong =", predictPLong(bull).toFixed(4));
const bear = { ...f, rangePos: 0.1, mom3: -0.002, rsiVelocity: -3 };
console.log("bearish features       -> pLong =", predictPLong(bear).toFixed(4));

console.log("\n--- decideDirection ---");
console.log("XAU long              :", JSON.stringify(decideDirection({ pair: "XAU_USD", legacyDirection: "long", features: f }).decision));
console.log("EUR_USD long bullFeat :", JSON.stringify(decideDirection({ pair: "EUR_USD", legacyDirection: "long", features: bull }).decision));
console.log("EUR_USD long bearFeat :", JSON.stringify(decideDirection({ pair: "EUR_USD", legacyDirection: "long", features: bear }).decision));
console.log("EUR_USD short bullFeat:", JSON.stringify(decideDirection({ pair: "EUR_USD", legacyDirection: "short", features: bull }).decision));

process.exit(0);

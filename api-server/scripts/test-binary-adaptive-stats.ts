import assert from "node:assert/strict";

import {
  buildBaselineOnlyAdaptiveStats,
  buildBinaryAdaptiveStats,
  buildHeadToHeadStats,
  buildRollingModelStats,
  type AdaptivePredictionRow,
} from "../src/binary-adaptive-stats.js";
import {
  BINARY_EVIDENCE_THRESHOLDS,
  classifyAtrRegime,
  classifyConfidenceBucket,
  classifyTrendRegime,
  classifyVolatilityRegime,
  deriveRegimeDescriptor,
  evidenceLabel,
  loadBinaryRegimeConfig,
  wilsonInterval,
} from "../src/binary-regimes.js";
import { BINARY_MODEL_NAME, binaryStats, type BinaryStatRow } from "../src/binary-engine.js";
import { BINARY_LOGISTIC_MODEL_NAME } from "../src/binary-logistic-v1.js";

const config = loadBinaryRegimeConfig();

// ---------------------------------------------------------------------------
// Regime classification boundaries
// ---------------------------------------------------------------------------
assert.equal(classifyAtrRegime(config.atrPips.lowUpper - 0.001, config), "LOW");
assert.equal(classifyAtrRegime((config.atrPips.lowUpper + config.atrPips.highLower) / 2, config), "NORMAL");
assert.equal(classifyAtrRegime(config.atrPips.highLower + 0.001, config), "HIGH");
assert.equal(classifyAtrRegime(null, config), "NORMAL");

assert.equal(classifyVolatilityRegime(config.volatilityPips.lowUpper - 0.001, config), "LOW");
assert.equal(classifyVolatilityRegime(config.volatilityPips.highLower + 0.001, config), "HIGH");

assert.equal(classifyTrendRegime(config.trend.downUpper - 0.0001, config), "DOWN");
assert.equal(classifyTrendRegime(config.trend.upLower + 0.0001, config), "UP");
assert.equal(classifyTrendRegime(0, config), "FLAT");

assert.equal(classifyConfidenceBucket(0.59, "heuristic_score", config), "0.58-0.65");
assert.equal(classifyConfidenceBucket(0.72, "heuristic_score", config), "0.70-0.80");
assert.equal(classifyConfidenceBucket(0.52, "probability", config), "0.50-0.55");
assert.equal(classifyConfidenceBucket(0.73, "probability", config), "0.70+");

// ---------------------------------------------------------------------------
// Wilson interval — known case: 578/1000 ≈ 0.578
// ---------------------------------------------------------------------------
const wilson578 = wilsonInterval(578, 1000);
assert.ok(wilson578.ciLow != null && wilson578.ciHigh != null);
assert.ok(wilson578.ciLow > 0.54 && wilson578.ciLow < 0.58);
assert.ok(wilson578.ciHigh > 0.59 && wilson578.ciHigh < 0.63);
assert.deepEqual(wilsonInterval(0, 0), { ciLow: null, ciHigh: null });

// ---------------------------------------------------------------------------
// Evidence labels
// ---------------------------------------------------------------------------
assert.equal(evidenceLabel(10), "INSUFFICIENT");
assert.equal(evidenceLabel(BINARY_EVIDENCE_THRESHOLDS.insufficientBelow - 1), "INSUFFICIENT");
assert.equal(evidenceLabel(50), "EARLY");
assert.equal(evidenceLabel(150), "USABLE");
assert.equal(evidenceLabel(400), "STRONG");

function makeRow(overrides: Partial<AdaptivePredictionRow> & Pick<AdaptivePredictionRow, "id" | "modelName">): AdaptivePredictionRow {
  const features = {
    atrPips: 1.2,
    volatilityPips: 0.8,
    emaFast: 1.10010,
    emaSlow: 1.10000,
    referenceClose: 1.10005,
    session: "London",
    spreadPips: 1.0,
    ...(overrides.features ?? {}),
  };
  const confidence = overrides.confidence ?? 0.62;
  const scoreKind = overrides.scoreKind ?? (overrides.modelName === BINARY_LOGISTIC_MODEL_NAME ? "probability" : "heuristic_score");
  return {
    modelVersion: "1.0.0",
    instrument: "EUR_USD",
    direction: "up",
    status: "resolved",
    result: "won",
    confidence,
    scoreKind,
    features,
    marketContext: { session: "London" },
    opportunityId: null,
    isShadow: overrides.modelName === BINARY_LOGISTIC_MODEL_NAME,
    startAt: "2026-01-01T12:00:00.000Z",
    entryPrice: 1.1,
    resolutionPrice: 1.1002,
    spreadPips: 1.0,
    regime: deriveRegimeDescriptor({
      instrument: overrides.instrument ?? "EUR_USD",
      features,
      marketContext: { session: "London" },
      confidence,
      scoreKind,
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Basic aggregation: 10W / 8L / 2T
// ---------------------------------------------------------------------------
const aggregateRows = [
  ...Array.from({ length: 10 }, (_, index) => makeRow({ id: `w${index}`, modelName: BINARY_MODEL_NAME, result: "won" })),
  ...Array.from({ length: 8 }, (_, index) => makeRow({ id: `l${index}`, modelName: BINARY_MODEL_NAME, result: "lost" })),
  ...Array.from({ length: 2 }, (_, index) => makeRow({ id: `t${index}`, modelName: BINARY_MODEL_NAME, result: "tie" })),
];
const baselineStats = buildBinaryAdaptiveStats(aggregateRows).models.find((model) => model.modelName === BINARY_MODEL_NAME)!;
assert.equal(baselineStats.won, 10);
assert.equal(baselineStats.lost, 8);
assert.equal(baselineStats.tie, 2);
assert.equal(baselineStats.decided, 18);
assert.equal(baselineStats.winRate, 10 / 18);

// ---------------------------------------------------------------------------
// Shadow count isolation — baseline user stats must not double-count
// ---------------------------------------------------------------------------
const withShadow = [
  ...aggregateRows,
  makeRow({ id: "shadow-1", modelName: BINARY_LOGISTIC_MODEL_NAME, opportunityId: "opp-1", isShadow: true, result: "lost" }),
  makeRow({ id: "shadow-2", modelName: BINARY_LOGISTIC_MODEL_NAME, opportunityId: "opp-2", isShadow: true, result: "won" }),
];
const allModels = buildBinaryAdaptiveStats(withShadow).models;
const baselineOnly = buildBaselineOnlyAdaptiveStats(withShadow).models[0]!;
assert.equal(allModels.length, 2, "adaptive stats include both models");
assert.equal(baselineOnly.decided, 18, "baseline-only stats ignore shadow rows");

const legacyStatRows: BinaryStatRow[] = withShadow
  .filter((row) => !row.isShadow)
  .map((row) => ({
    instrument: row.instrument,
    direction: row.direction,
    status: row.status,
    result: row.result,
    confidence: row.confidence,
    session: row.regime.session,
    model_version: row.modelVersion,
    start_at: row.startAt,
  }));
assert.equal(binaryStats(legacyStatRows).resolved, 20, "filtered baseline rows for legacy binaryStats");
assert.equal(binaryStats(withShadow.map((row) => ({
  instrument: row.instrument,
  direction: row.direction,
  status: row.status,
  result: row.result,
  confidence: row.confidence,
  session: row.regime.session,
  model_version: row.modelVersion,
  start_at: row.startAt,
}))).resolved, 22, "unfiltered rows inflate resolved count when shadow present");

// ---------------------------------------------------------------------------
// Head-to-head linkage
// ---------------------------------------------------------------------------
const headToHeadRows: AdaptivePredictionRow[] = [
  makeRow({ id: "b1", modelName: BINARY_MODEL_NAME, opportunityId: "opp-a", isShadow: false, direction: "up", result: "won" }),
  makeRow({ id: "l1", modelName: BINARY_LOGISTIC_MODEL_NAME, opportunityId: "opp-a", isShadow: true, direction: "down", result: "lost" }),
  makeRow({ id: "b2", modelName: BINARY_MODEL_NAME, opportunityId: "opp-b", isShadow: false, direction: "up", result: "lost" }),
  makeRow({ id: "l2", modelName: BINARY_LOGISTIC_MODEL_NAME, opportunityId: "opp-b", isShadow: true, direction: "down", result: "won" }),
  makeRow({ id: "b3", modelName: BINARY_MODEL_NAME, opportunityId: "opp-c", isShadow: false, direction: "up", result: "won" }),
  makeRow({ id: "l3", modelName: BINARY_LOGISTIC_MODEL_NAME, opportunityId: "opp-c", isShadow: true, direction: "up", result: "won" }),
  makeRow({ id: "b4", modelName: BINARY_MODEL_NAME, opportunityId: null, isShadow: false, result: "won" }),
];
const h2h = buildHeadToHeadStats(headToHeadRows);
assert.equal(h2h.sharedResolvedOpportunities, 3);
assert.equal(h2h.disagreementCount, 2);
assert.equal(h2h.agreementCount, 1);
assert.equal(h2h.baselineOnlyCorrect, 1);
assert.equal(h2h.logisticOnlyCorrect, 1);
assert.equal(h2h.logisticDisagreementWinRate, 0.5);
assert.equal(h2h.evidence, "INSUFFICIENT");

// No duplicate opportunity counting
assert.equal(h2h.baselineOnlyCorrect + h2h.logisticOnlyCorrect, h2h.disagreementCount);

// Historical compatibility: rows without opportunity_id excluded from head-to-head
assert.equal(buildHeadToHeadStats(headToHeadRows.filter((row) => row.opportunityId == null)).sharedResolvedOpportunities, 0);

// ---------------------------------------------------------------------------
// Rolling windows — chronological last-N per model
// ---------------------------------------------------------------------------
const rollingRows = Array.from({ length: 120 }, (_, index) => makeRow({
  id: `r${index}`,
  modelName: BINARY_MODEL_NAME,
  startAt: new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString(),
  result: index % 2 === 0 ? "won" : "lost",
}));
const rolling = buildRollingModelStats(rollingRows);
const last50 = rolling.find((entry) => entry.window === 50)!.models[0]!;
const last100 = rolling.find((entry) => entry.window === 100)!.models[0]!;
const allTime = rolling.find((entry) => entry.window === "all")!.models[0]!;
assert.equal(last50.decided, 50);
assert.equal(last100.decided, 100);
assert.equal(allTime.decided, 120);
assert.equal(last50.won + last50.lost, 50);

console.log("Binary-adaptive-stats checks passed.");

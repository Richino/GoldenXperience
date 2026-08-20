import assert from "node:assert/strict";

import { buildPairedDisagreementEvidence } from "../src/binary-adaptive-stats.js";
import {
  BINARY_ADAPTIVE_SELECTOR_CONFIG,
  determineSelectorState,
  selectBinaryModel,
  type SelectorDecision,
} from "../src/binary-adaptive-selector.js";
import { deriveRegimeDescriptor, wilsonInterval } from "../src/binary-regimes.js";
import { BINARY_MODEL_NAME } from "../src/binary-engine.js";
import { BINARY_LOGISTIC_MODEL_NAME } from "../src/binary-logistic-v1.js";
import type { AdaptivePredictionRow } from "../src/binary-adaptive-stats.js";

function regime(instrument = "EUR_USD") {
  return deriveRegimeDescriptor({
    instrument,
    features: {
      atrPips: 1.5,
      volatilityPips: 1.0,
      emaFast: 1.10010,
      emaSlow: 1.10000,
      referenceClose: 1.10005,
      session: "London",
      spreadPips: 1.0,
    },
    confidence: 0.62,
    scoreKind: "heuristic_score",
  });
}

function makePair(
  opportunityId: string,
  instrument: string,
  baselineResult: "won" | "lost",
  logisticResult: "won" | "lost",
  baselineDirection: "up" | "down" = "up",
  logisticDirection: "up" | "down" = "down",
  session = "London",
  atrPips = 1.5,
  volatilityPips = 1.0,
): AdaptivePredictionRow[] {
  const features = {
    atrPips,
    volatilityPips,
    emaFast: 1.10010,
    emaSlow: 1.10000,
    referenceClose: 1.10005,
    session,
    spreadPips: 1.0,
  };
  const baseRegime = deriveRegimeDescriptor({ instrument, features, confidence: 0.62, scoreKind: "heuristic_score" });
  return [
    {
      id: `b-${opportunityId}`,
      modelName: BINARY_MODEL_NAME,
      modelVersion: "1.0.0",
      instrument,
      direction: baselineDirection,
      status: "resolved",
      result: baselineResult,
      confidence: 0.62,
      scoreKind: "heuristic_score",
      features,
      marketContext: { session },
      opportunityId,
      isShadow: false,
      startAt: `2026-02-01T10:00:00.000Z`,
      entryPrice: 1.1,
      resolutionPrice: 1.1002,
      spreadPips: 1.0,
      regime: baseRegime,
    },
    {
      id: `l-${opportunityId}`,
      modelName: BINARY_LOGISTIC_MODEL_NAME,
      modelVersion: "1.0.0",
      instrument,
      direction: logisticDirection,
      status: "resolved",
      result: logisticResult,
      confidence: 0.55,
      scoreKind: "probability",
      features,
      marketContext: { session },
      opportunityId,
      isShadow: true,
      startAt: `2026-02-01T10:00:00.000Z`,
      entryPrice: 1.1,
      resolutionPrice: 1.1002,
      spreadPips: 1.0,
      regime: baseRegime,
    },
  ];
}

function pairedRows(count: number, logisticWins = 0.65, instrument = "EUR_USD"): AdaptivePredictionRow[] {
  const rows: AdaptivePredictionRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const logisticWinsPair = Math.random() < logisticWins;
    rows.push(...makePair(
      `opp-${index}`,
      instrument,
      logisticWinsPair ? "lost" : "won",
      logisticWinsPair ? "won" : "lost",
    ));
  }
  return rows;
}

function pairedRowsDeterministic(
  count: number,
  logisticOnlyCorrectCount: number,
  instrument = "EUR_USD",
  atrPips = 1.5,
): AdaptivePredictionRow[] {
  const rows: AdaptivePredictionRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const logisticWins = index < logisticOnlyCorrectCount;
    rows.push(...makePair(
      `opp-${index}`,
      instrument,
      logisticWins ? "lost" : "won",
      logisticWins ? "won" : "lost",
      "up",
      "down",
      "London",
      atrPips,
    ));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------
assert.equal(determineSelectorState(10), "COLLECTING");
assert.equal(determineSelectorState(49), "COLLECTING");
assert.equal(determineSelectorState(50), "LEARNING");
assert.equal(determineSelectorState(99), "LEARNING");
assert.equal(determineSelectorState(100), "ACTIVE_SELECTION");

const collecting = selectBinaryModel({ regime: regime(), pairedRows: pairedRows(10), state: "COLLECTING" });
assert.equal(collecting.authoritativeModel, BINARY_MODEL_NAME);
assert.equal(collecting.recommendationOnly, true);

// High paired count alone must NOT switch in LEARNING
const learningMany = selectBinaryModel({
  regime: regime(),
  pairedRows: pairedRowsDeterministic(120, 90),
  state: "LEARNING",
  liveSelectionEnabled: true,
});
assert.equal(learningMany.authoritativeModel, BINARY_MODEL_NAME, "LEARNING keeps baseline authoritative");

// ---------------------------------------------------------------------------
// Insufficient / inconclusive evidence → baseline fallback
// ---------------------------------------------------------------------------
const inconclusive = pairedRowsDeterministic(120, 62); // ~52% logistic wins on disagreements
const inconclusiveDecision = selectBinaryModel({
  regime: regime(),
  pairedRows: inconclusive,
  state: "ACTIVE_SELECTION",
  liveSelectionEnabled: true,
});
assert.equal(inconclusiveDecision.authoritativeModel, BINARY_MODEL_NAME);
assert.equal(inconclusiveDecision.reason, "no_credible_advantage");

// ---------------------------------------------------------------------------
// Credible logistic advantage
// ---------------------------------------------------------------------------
const logisticStrong = pairedRowsDeterministic(120, 95);
const logisticDecision = selectBinaryModel({
  regime: regime(),
  pairedRows: logisticStrong,
  state: "ACTIVE_SELECTION",
  liveSelectionEnabled: true,
});
assert.equal(logisticDecision.recommendedModel, BINARY_LOGISTIC_MODEL_NAME);
assert.equal(logisticDecision.authoritativeModel, BINARY_LOGISTIC_MODEL_NAME);
assert.ok(logisticDecision.evidence.ciLow != null && logisticDecision.evidence.ciLow > 0.5);

// ---------------------------------------------------------------------------
// Credible baseline advantage
// ---------------------------------------------------------------------------
const baselineStrong = pairedRowsDeterministic(120, 15);
const baselineDecision = selectBinaryModel({
  regime: regime(),
  pairedRows: baselineStrong,
  state: "ACTIVE_SELECTION",
  liveSelectionEnabled: true,
});
assert.equal(baselineDecision.recommendedModel, BINARY_MODEL_NAME);
assert.equal(baselineDecision.authoritativeModel, BINARY_MODEL_NAME);

// ---------------------------------------------------------------------------
// Tiny statistically-significant advantage blocked by practical edge
// ---------------------------------------------------------------------------
const tinyEdgeConfig = {
  ...BINARY_ADAPTIVE_SELECTOR_CONFIG,
  minimumPracticalEdge: 0.10,
  minOverallDecisiveDisagreements: 20,
};
const tinyEdgeRows = pairedRowsDeterministic(200, 110); // 55% — credible but small edge
const tinyEdge = selectBinaryModel({
  regime: regime(),
  pairedRows: tinyEdgeRows,
  state: "ACTIVE_SELECTION",
  liveSelectionEnabled: true,
  config: tinyEdgeConfig,
});
assert.equal(tinyEdge.authoritativeModel, BINARY_MODEL_NAME, "practical edge threshold prevents switch");

// ---------------------------------------------------------------------------
// Regime fallback hierarchy
// ---------------------------------------------------------------------------
const mixedInstrumentRows = [
  ...pairedRowsDeterministic(20, 18, "GBP_USD", 0.5),
  ...pairedRowsDeterministic(60, 45, "EUR_USD", 1.5),
];
const regimeSpecific = selectBinaryModel({
  regime: deriveRegimeDescriptor({
    instrument: "EUR_USD",
    features: { atrPips: 1.5, volatilityPips: 1.0, emaFast: 1.1, emaSlow: 1.09, referenceClose: 1.1, session: "London", spreadPips: 1 },
    confidence: 0.62,
    scoreKind: "heuristic_score",
  }),
  pairedRows: mixedInstrumentRows,
  state: "ACTIVE_SELECTION",
  liveSelectionEnabled: true,
});
assert.ok(
  regimeSpecific.evidence.scope === "instrument|atrRegime" || regimeSpecific.evidence.scope === "overall",
  "falls back through evidence hierarchy",
);

// ---------------------------------------------------------------------------
// LEARNING shadow mode
// ---------------------------------------------------------------------------
const learningRecommend = selectBinaryModel({
  regime: regime(),
  pairedRows: pairedRowsDeterministic(80, 60),
  state: "LEARNING",
  liveSelectionEnabled: true,
});
assert.equal(learningRecommend.authoritativeModel, BINARY_MODEL_NAME);
assert.equal(learningRecommend.recommendationOnly, true);

// ---------------------------------------------------------------------------
// Live-selection flag disabled
// ---------------------------------------------------------------------------
const liveDisabled = selectBinaryModel({
  regime: regime(),
  pairedRows: pairedRowsDeterministic(120, 95),
  state: "ACTIVE_SELECTION",
  liveSelectionEnabled: false,
});
assert.equal(liveDisabled.recommendedModel, BINARY_LOGISTIC_MODEL_NAME);
assert.equal(liveDisabled.authoritativeModel, BINARY_MODEL_NAME);
assert.equal(liveDisabled.recommendationOnly, true);

// ---------------------------------------------------------------------------
// Head-to-head no duplicate counting
// ---------------------------------------------------------------------------
const h2hRows = pairedRowsDeterministic(5, 3);
const evidence = buildPairedDisagreementEvidence(h2hRows, "overall");
assert.equal(evidence.baselineOnlyCorrect + evidence.logisticOnlyCorrect, evidence.disagreementCount);

// ---------------------------------------------------------------------------
// Wilson interval sanity
// ---------------------------------------------------------------------------
const wilson = wilsonInterval(70, 100);
assert.ok(wilson.ciLow != null && wilson.ciHigh != null && wilson.ciLow < 0.7 && wilson.ciHigh > 0.7);

console.log("Binary-adaptive-selector checks passed.");

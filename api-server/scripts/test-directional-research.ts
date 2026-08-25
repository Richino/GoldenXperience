import assert from "node:assert/strict";
import {
  EIGHT_DIRECTIONAL_FAMILIES,
  confirmDirectionAfterSetup,
  createDirectionalEvidenceStore,
  decideDirectionalAction,
  estimateMovementOpportunity,
  recordDirectionalEvidence,
  simulateResearchTrade,
  type ResearchQuote,
  type ResearchSetupCandidate,
} from "../src/directional-research.js";
import { LIVE_EXECUTABLE_FAMILIES, STRATEGY_FAMILIES } from "../../frontend/src/lib/strategy/strategies/index.js";
import type { Candle } from "../../frontend/src/types/forex.js";

function candle(index: number, open = 1, high = 1.0004, low = 0.9996, close = 1): Candle {
  return { time: new Date(Date.UTC(2024, 0, 1, 0, index * 15)).toISOString(), open, high, low, close, volume: 100, complete: true };
}

const candles = Array.from({ length: 60 }, (_, index) => candle(index));
candles[21] = candle(21, 1.0002, 1.002, 1.0001, 1.0015);
candles[22] = candle(22, 1.0014, 1.0022, 1.0012, 1.0016);
candles[23] = candle(23, 1.0016, 1.002, 1.0013, 1.0018);
const confirmation = confirmDirectionAfterSetup(candles, 20, 0.001, { rangeLookbackBars: 8, breakoutAtr: 0.1, maxDelayBars: 4, requireHold: true });
assert.equal(confirmation.direction, "long");
assert.equal(confirmation.knownAtIndex, 22);
assert.equal(confirmation.entryIndex, 23);
assert.ok(confirmation.entryIndex! > confirmation.knownAtIndex! && confirmation.knownAtIndex! > 20, "entry must be strictly after completed confirmation");

const movementBefore = estimateMovementOpportunity(candles, 20, 0.001, 1, 0.0001);
const futureMutated = candles.map((bar) => ({ ...bar }));
futureMutated[30] = candle(30, 1, 9, 0.1, 8);
assert.deepEqual(estimateMovementOpportunity(futureMutated, 20, 0.001, 1, 0.0001), movementBefore, "movement estimate must ignore future bars");

const store = createDirectionalEvidenceStore();
const context = { family: "ema", instrument: "EUR_USD", session: "London", regime: "trending", confirmationType: "range_close_hold", direction: "long" };
assert.equal(decideDirectionalAction(store, context).action, "follow", "cold start follows observed confirmation");
for (let index = 0; index < 99; index += 1) recordDirectionalEvidence(store, context, -0.5, 0.5);
assert.notEqual(decideDirectionalAction(store, context).action, "reverse", "reverse requires at least 100 resolved prior observations");
recordDirectionalEvidence(store, context, -0.5, 0.5);
assert.equal(decideDirectionalAction(store, context).action, "reverse", "supported positive reverse evidence may reverse after threshold");

const candidate: ResearchSetupCandidate = {
  family: "ema", version: "fixture", instrument: "EUR_USD", timeframe: "M15", setupIndex: 0,
  setupTime: candles[0]!.time, setupQualified: true, originalDirection: "long",
  originalPlan: { direction: "long", entry: 1.0002, stop: 0.9992, target: 1.0017 }, setupMetadata: {},
  regime: { regime: "mixed", trendDirection: "none", trendStrength: 0, volatility: "normal", atr: 0.001, atrPips: 10, momentumState: "steady", emaFast: null, emaMid: null, emaSlow: null, slopeAtrPerBar: null, rangeHigh: null, rangeLow: null, rangeWidthAtr: null, rangeAgeBars: null, lookbackBars: 20, evaluatedAt: candles[0]!.time },
  atr: 0.001, atrPips: 10, spreadPips: 2,
};
const quotes: ResearchQuote[] = Array.from({ length: 3 }, (_, index) => ({ closeTime: candles[index]!.time, bidOpen: 1, bidHigh: 1.0001, bidLow: 0.9999, bidClose: 1, askOpen: 1.0002, askHigh: 1.0003, askLow: 1.0001, askClose: 1.0002 }));
const spreadTrade = simulateResearchTrade({ family: "ema", control: "confirmed", candidate, quotes, direction: "long", entryIndex: 0, entry: 1.0002, stop: 0.9992, target: 1.01, maxBars: 3, session: "London" });
assert.ok(spreadTrade);
assert.ok(Math.abs(spreadTrade.resultR + 0.2) < 1e-9, "bid/ask timeout must charge spread in net R");
assert.ok(Math.abs(spreadTrade.grossR) < 1e-9, "grossR must add spread cost back exactly");

assert.deepEqual(STRATEGY_FAMILIES, ["ema", "breakout", "momentum", "meanrev"]);
assert.deepEqual(LIVE_EXECUTABLE_FAMILIES, ["ema", "breakout", "momentum", "meanrev"]);
assert.equal(EIGHT_DIRECTIONAL_FAMILIES.length, 8);
assert.ok(!LIVE_EXECUTABLE_FAMILIES.some((family) => (EIGHT_DIRECTIONAL_FAMILIES.slice(4) as readonly string[]).includes(family)), "research families must not enter the live allowlist");

console.log("directional research tests passed");


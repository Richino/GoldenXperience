import assert from "node:assert/strict";
import { evaluateEurjpy01To05RangeBreakV1, evaluateEurjpyStrategy } from "../src/lib/strategy/strategies/eurjpy-strategy.js";
import type { Candle } from "../src/types/forex.js";

const start = Date.parse("2026-01-01T00:00:00.000Z");
const candles: Candle[] = Array.from({ length: 55 }, (_, index) => {
  const open = 160 + index * .05, close = open + .02;
  return { time: new Date(start + index * 3_600_000).toISOString(), open, high: close + .02, low: open - .02, close, volume: 1, complete: true };
});
const prior = candles.at(-2)!;
const current = candles.at(-1)!;
const close = prior.high + .001;
// Jan 3 06:00: barely above high[1] and the exact 01:00-05:00 range high.
candles[candles.length - 1] = { ...current, open: close - .3, low: close - .5, high: close + .01, close };
const pine = evaluateEurjpy01To05RangeBreakV1(candles);
assert.equal(pine.originTime, "2026-01-03T06:00:00.000Z");
assert.equal(pine.preRangeBarCount, 5); assert.equal(pine.rangeReady, true); assert.equal(pine.emaSlopeUp, true); assert.equal(pine.previousHighBreak, true); assert.equal(pine.preRangeHighBreak, true); assert.equal(pine.strategySignalQualified, true);
const input = { instrument: "EUR_JPY" as const, accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda" as const, candles15m: [], candles1h: candles, candles4h: [], bid: 162, ask: 162.01, spreadPips: 999, marketOpen: false, calendarConnected: false, highImpactNewsWithinMinutes: 1, evaluationMode: "live" as const };
const candidate = evaluateEurjpyStrategy(input);
assert.equal(candidate.features.eurjpyStrategy?.strategySignalQualified, true);
assert.equal(candidate.features.eurjpyStrategy?.executionAllowed, true, "spread, session, and news are external policy, not Pine gates");
const duplicate = evaluateEurjpyStrategy(input, { duplicateSignal: true });
assert.equal(duplicate.features.eurjpyStrategy?.strategySignalQualified, true); assert.equal(duplicate.features.eurjpyStrategy?.executionAllowed, false); assert.equal(duplicate.features.eurjpyStrategy?.executionBlockReason, "DUPLICATE_SIGNAL");
console.log("eurjpy frozen Pine evaluator: PASS (exact 01-05 range and strict 06:00 breaks, no inherited gates)");

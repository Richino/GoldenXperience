import assert from "node:assert/strict";
import { evaluateCadjpyBullBreakExtremeV1, evaluateCadjpyStrategy } from "../src/lib/strategy/strategies/cadjpy-strategy.js";
import type { Candle } from "../src/types/forex.js";

const start = Date.parse("2026-01-01T00:00:00.000Z");
const candles: Candle[] = Array.from({ length: 61 }, (_, index) => {
  const open = 100 + index * .05, close = open + .01;
  return { time: new Date(start + index * 3_600_000).toISOString(), open, high: close + .02, low: open - .02, close, volume: 1, complete: true };
});
// Final candle is 12:00 UTC. It breaks high[1] strictly, but its clearance is
// intentionally less than 0.10 ATR: proving CADJPY does not inherit NZDJPY's rule.
const prior = candles.at(-2)!; const current = candles.at(-1)!; const close = prior.high + .002; const open = close - .1;
candles[candles.length - 1] = { ...current, open, low: open - .01, high: close + .0001, close };
const pine = evaluateCadjpyBullBreakExtremeV1(candles);
assert.equal(pine.originTime, "2026-01-03T12:00:00.000Z");
assert.equal(pine.consensus, 4); assert.equal(pine.previousHighBreak, true); assert.ok((pine.bodyR ?? 0) >= .5); assert.ok((pine.closeLocation ?? 0) >= .75); assert.equal(pine.strategySignalQualified, true);
const input = { instrument: "CAD_JPY" as const, accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda" as const, candles15m: [], candles1h: candles, candles4h: [], bid: 103, ask: 103.01, spreadPips: 999, marketOpen: false, calendarConnected: false, highImpactNewsWithinMinutes: 1, evaluationMode: "live" as const };
const candidate = evaluateCadjpyStrategy(input);
assert.equal(candidate.features.cadjpyStrategy?.strategySignalQualified, true);
assert.equal(candidate.features.cadjpyStrategy?.executionAllowed, true, "news, spread, and London/New York session are not Pine gates");
const duplicate = evaluateCadjpyStrategy(input, { duplicateSignal: true });
assert.equal(duplicate.features.cadjpyStrategy?.strategySignalQualified, true); assert.equal(duplicate.features.cadjpyStrategy?.executionAllowed, false); assert.equal(duplicate.features.cadjpyStrategy?.executionBlockReason, "DUPLICATE_SIGNAL");
console.log("cadjpy frozen Pine evaluator: PASS (strict previous-high break, no clearance/range/session filter)");

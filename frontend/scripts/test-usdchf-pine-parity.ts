import assert from "node:assert/strict";
import { evaluateUsdchfBearConsensusStructureV1, evaluateUsdchfStrategy } from "../src/lib/strategy/strategies/usdchf-strategy.js";
import type { Candle } from "../src/types/forex.js";

const start = Date.parse("2026-01-01T00:00:00.000Z");
const candles: Candle[] = Array.from({ length: 60 }, (_, index) => {
  const open = .95 - index * .0005, close = open - .0002;
  return { time: new Date(start + index * 3_600_000).toISOString(), open, high: open + .0002, low: close - .0002, close, volume: 1, complete: true };
});
const prior = candles.at(-2)!;
const current = candles.at(-1)!;
// Jan 3 11:00: LH + LL but close remains above low[1] and is a doji. This
// proves USDCHF has neither a previous-low-break nor bearish-body requirement.
const close = prior.low + .00001;
candles[candles.length - 1] = { ...current, open: close, high: close + .00002, low: prior.low - .00002, close };
const pine = evaluateUsdchfBearConsensusStructureV1(candles);
assert.equal(pine.originTime, "2026-01-03T11:00:00.000Z");
assert.equal(pine.consensus, -4); assert.equal(pine.currentHigh! < pine.previousHigh!, true); assert.equal(pine.currentLow! < pine.previousLow!, true); assert.ok(candles.at(-1)!.close > prior.low); assert.equal(pine.strategySignalQualified, true);
assert.equal(evaluateUsdchfBearConsensusStructureV1(candles.map((candle) => ({ ...candle, time: candle.time.replace("2026", "2022") }))).strategySignalQualified, false, "Pine start date is frozen at 2023-01-01 UTC");
const input = { instrument: "USD_CHF" as const, accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda" as const, candles15m: [], candles1h: candles, candles4h: [], bid: .92, ask: .921, spreadPips: 999, marketOpen: false, calendarConnected: false, highImpactNewsWithinMinutes: 1, evaluationMode: "live" as const };
const candidate = evaluateUsdchfStrategy(input);
assert.equal(candidate.features.usdchfStrategy?.strategySignalQualified, true); assert.equal(candidate.features.usdchfStrategy?.executionAllowed, true, "spread, news, and session are not Pine gates");
const duplicate = evaluateUsdchfStrategy(input, { duplicateSignal: true });
assert.equal(duplicate.features.usdchfStrategy?.strategySignalQualified, true); assert.equal(duplicate.features.usdchfStrategy?.executionAllowed, false); assert.equal(duplicate.features.usdchfStrategy?.executionBlockReason, "DUPLICATE_SIGNAL");
console.log("usdchf frozen Pine evaluator: PASS (consensus <= -3, LH+LL only, no Phase-4/body/session gate)");

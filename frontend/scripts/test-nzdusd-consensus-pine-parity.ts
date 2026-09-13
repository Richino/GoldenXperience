import assert from "node:assert/strict";
import { evaluateNzdusdBullConsensusStructureV1, evaluateNzdusdConsensusStrategy } from "../src/lib/strategy/strategies/nzdusd-consensus-strategy.js";
import type { Candle } from "../src/types/forex.js";
const start = Date.parse("2026-01-01T00:00:00.000Z");
const candles: Candle[] = Array.from({ length: 60 }, (_, i) => { const open = .60 + i * .001; const close = open + .0001; return { time: new Date(start + i * 3_600_000).toISOString(), open, high: close + .0002, low: open - .0002, close, volume: 1, complete: true }; });
const prior = candles.at(-2)!; const current = candles.at(-1)!;
// A tiny/doji body and a close still below high[1] are deliberately retained:
// both must qualify because this frozen strategy is consensus + HH/HL only.
const close = prior.high - .00001;
candles[candles.length - 1] = { ...current, open: close, high: prior.high + .00001, low: prior.low + .00001, close };
const pine = evaluateNzdusdBullConsensusStructureV1(candles);
assert.equal(pine.originTime, "2026-01-03T11:00:00.000Z"); assert.equal(pine.consensus, 4); assert.equal(pine.bullStructure, true); assert.ok(candles.at(-1)!.close < prior.high); assert.equal(pine.strategySignalQualified, true);
assert.equal(evaluateNzdusdBullConsensusStructureV1(candles.map(c => ({ ...c, time: c.time.replace("2026", "2022") }))).strategySignalQualified, false, "frozen start date is 2023-01-01 UTC");
const input = { instrument: "NZD_USD" as const, accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda" as const, candles15m: [], candles1h: candles, candles4h: [], bid: .66, ask: .661, spreadPips: 999, marketOpen: false, calendarConnected: false, highImpactNewsWithinMinutes: 1, evaluationMode: "live" as const };
const candidate = evaluateNzdusdConsensusStrategy(input); assert.equal(candidate.features.nzdusdConsensusStrategy?.strategySignalQualified, true); assert.equal(candidate.features.nzdusdConsensusStrategy?.executionAllowed, true, "session, news, and spread are not Pine gates");
const duplicate = evaluateNzdusdConsensusStrategy(input, { duplicateSignal: true }); assert.equal(duplicate.features.nzdusdConsensusStrategy?.strategySignalQualified, true); assert.equal(duplicate.features.nzdusdConsensusStrategy?.executionAllowed, false);
console.log("nzdusd frozen Pine evaluator: PASS (consensus + HH/HL only; no breakout/body/range gate)");

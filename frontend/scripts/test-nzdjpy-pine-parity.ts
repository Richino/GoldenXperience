import assert from "node:assert/strict";
import { evaluateNzdjpy23UtcBullBreakV1, evaluateNzdjpyStrategy } from "../src/lib/strategy/strategies/nzdjpy-strategy.js";
import type { Candle } from "../src/types/forex.js";

function fixture(): Candle[] {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  const candles: Candle[] = [];
  for (let index = 0; index < 72; index += 1) {
    const open = 80 + index * 0.05;
    const close = open + 0.01;
    candles.push({ time: new Date(start + index * 3_600_000).toISOString(), open, high: close + 0.02, low: open - 0.02, close, volume: 1, complete: true });
  }
  const previous = candles.at(-2)!;
  const current = candles.at(-1)!;
  // The final candle is exactly 23:00 UTC. Its close is deliberately above
  // high[1] by far more than 0.10 ATR, with a >=0.50 ATR bullish body and an
  // upper-25% close. The earlier steady rise makes all four Pine votes +1.
  const open = previous.close + 0.005;
  const close = previous.high + 0.08;
  candles[candles.length - 1] = { ...current, open, low: open - 0.01, high: close + 0.005, close };
  return candles;
}

const candles = fixture();
const pine = evaluateNzdjpy23UtcBullBreakV1(candles);
assert.equal(pine.originTime, "2026-01-03T23:00:00.000Z");
assert.equal(pine.voteTrend, 1);
assert.equal(pine.votePrice, 1);
assert.equal(pine.voteSlope, 1);
assert.equal(pine.voteMomentum, 1);
assert.equal(pine.consensus, 4, "+4 must qualify; the production evaluator also accepts +3");
assert.equal(pine.bullBody, true);
assert.ok((pine.bodyR ?? 0) >= 0.5);
assert.ok((pine.closeLocation ?? 0) >= 0.75);
assert.ok((pine.breakDistanceR ?? 0) >= 0.1);
assert.equal(pine.strategySignalQualified, true, "only frozen Pine rules qualify this signal");
assert.equal(pine.pineReferenceStop, pine.signalMidClose! - pine.atr14!);
assert.equal(pine.pineReferenceTarget, pine.signalMidClose! + 2 * pine.atr14!);

const input = {
  instrument: "NZD_JPY" as const,
  accountBalance: 10_000,
  accountCurrency: "USD",
  dataSource: "oanda" as const,
  candles15m: [],
  candles1h: candles,
  candles4h: [],
  bid: 83.54,
  ask: 83.55,
  // These intentionally failing generic gates must not change the Pine result.
  spreadPips: 999,
  marketOpen: false,
  calendarConnected: false,
  highImpactNewsWithinMinutes: 1,
  evaluationMode: "live" as const,
};
const candidate = evaluateNzdjpyStrategy(input);
assert.equal(candidate.features.nzdjpyStrategy?.strategySignalQualified, true);
assert.equal(candidate.features.nzdjpyStrategy?.executionAllowed, true, "session/news/spread are not NZDJPY Pine gates");
assert.equal(candidate.entry, input.ask, "practice long entry uses ASK");
assert.equal(candidate.features.nzdjpyStrategy?.pineReferenceStop, pine.pineReferenceStop, "midpoint Pine geometry stays frozen separately");
assert.equal(candidate.features.nzdjpyStrategy?.executableStop, input.ask - pine.atr14!, "executable geometry is explicit, not silently substituted for Pine geometry");

const duplicate = evaluateNzdjpyStrategy(input, { duplicateSignal: true });
assert.equal(duplicate.features.nzdjpyStrategy?.strategySignalQualified, true, "duplicate protection cannot rewrite the Pine signal");
assert.equal(duplicate.features.nzdjpyStrategy?.executionAllowed, false);
assert.equal(duplicate.features.nzdjpyStrategy?.executionBlockReason, "DUPLICATE_SIGNAL");
assert.equal(duplicate.status, "no_setup", "blocked signals cannot reach order submission");

const notOrigin = candles.map((candle) => ({ ...candle }));
notOrigin[notOrigin.length - 1] = { ...notOrigin.at(-1)!, time: "2026-01-03T22:00:00.000Z" };
assert.equal(evaluateNzdjpy23UtcBullBreakV1(notOrigin).strategySignalQualified, false, "the new 00:00 candle or any non-23:00 candle must not substitute for the completed 23:00 origin");

console.log("nzdjpy frozen Pine evaluator: PASS (signal and execution policy separated)");

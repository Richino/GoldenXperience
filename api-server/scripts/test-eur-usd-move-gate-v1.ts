import assert from "node:assert/strict";
import { evaluateEurUsdMoveGateV1 } from "../src/eur-usd-move-gate-v1.js";
import type { Candle } from "../../frontend/src/types/forex.js";

function candle(index: number, open: number, high: number, low: number, close: number, complete = true): Candle {
  return { time: new Date(Date.UTC(2024, 0, 1, 0, index * 15)).toISOString(), open, high, low, close, volume: 100, complete };
}
const quiet = Array.from({ length: 200 }, (_, index) => candle(index, 1.1, 1.1002, 1.0998, 1.1));

assert.equal(evaluateEurUsdMoveGateV1({ instrument: "GBP_USD", candles: quiet, bid: 1.1, ask: 1.10002 }).reason, "unsupported_instrument");
assert.equal(evaluateEurUsdMoveGateV1({ instrument: "EUR_USD", candles: quiet.slice(0, 199), bid: 1.1, ask: 1.10002 }).reason, "insufficient_completed_history");
assert.equal(evaluateEurUsdMoveGateV1({ instrument: "EUR_USD", candles: [...quiet, candle(200, 1.1, 1.1002, 1.0998, 1.1, false)], bid: 1.1, ask: 1.10002 }).reason, "latest_candle_incomplete");

const moveCandles = quiet.map((bar) => ({ ...bar }));
for (let index = 194; index < 200; index += 1) {
  const open = 1.1 + (index - 194) * 0.0007;
  moveCandles[index] = candle(index, open, open + 0.001, open - 0.00015, open + 0.0008);
}
const move = evaluateEurUsdMoveGateV1({ instrument: "EUR_USD", candles: moveCandles, bid: 1.10498, ask: 1.105 },);
assert.equal(move.action, "MOVE");
assert.equal(move.reason, "frozen_move_threshold_met");
assert.equal("direction" in move, false, "Stage 1 must never choose a direction");

const wait = evaluateEurUsdMoveGateV1({ instrument: "EUR_USD", candles: quiet, bid: 1.1, ask: 1.10002 });
assert.equal(wait.action, "WAIT");
assert.equal(wait.reason, "movement_threshold_not_met");
console.log("EUR/USD move gate v1 tests passed");

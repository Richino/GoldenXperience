import assert from "node:assert/strict";
import { simulate } from "./simulate-three-percent-risk";
import type { TradeAudit } from "./validate-executable-costs";
import type { ResearchCandle } from "../src/lib/oanda/client";
const stamp = (hour: number) => `2024-01-02T${String(hour).padStart(2, "0")}:00:00.000Z`;
const candle = (hour: number, close: number): ResearchCandle => {
  const price = { open: close, high: close, low: close, close };
  return { time: stamp(hour), volume: 1, complete: true, mid: price, bid: price, ask: price };
};
const trades = [
  { pair: "EUR_USD", direction: "long", signalTimestamp: stamp(0), decisionTime: stamp(1), exitTimestamp: stamp(2), executableEntry: 100, stop: 90, bid: 100, ask: 100, executableResultR: 2 },
  { pair: "EUR_USD", direction: "long", signalTimestamp: stamp(1), decisionTime: stamp(2), exitTimestamp: stamp(3), executableEntry: 120, stop: 110, bid: 120, ask: 120, executableResultR: -1 },
] as TradeAudit[];
const market = { EUR_USD: [candle(0, 100), candle(1, 120), candle(2, 110)], AUD_USD: [candle(0, 100), candle(1, 90)], USD_JPY: [], GBP_USD: [] };
const rates = { EUR_USD: { marginRate: 0.02, minimumTradeSize: 0.001, tradeUnitsPrecision: 3 }, AUD_USD: { marginRate: 0.02, minimumTradeSize: 0.001, tradeUnitsPrecision: 3 }, USD_JPY: { marginRate: 0.02, minimumTradeSize: 1, tradeUnitsPrecision: 0 }, GBP_USD: { marginRate: 0.02, minimumTradeSize: 1, tradeUnitsPrecision: 0 } };
const result = simulate(trades, Date.parse(stamp(0)), Date.parse(stamp(4)), false, market, rates);
assert.ok(Math.abs(result.endingBalance - 102.82) < 1e-9, "+6% then -3% compounds from current equity");
assert.ok(Math.abs(result.maxDrawdownPct - 3) < 1e-9);
assert.ok(Math.abs(Number(result.ledger.find(r => r.event === "ENTRY" && r.time === stamp(2))!.riskDollars) - 3.18) < 1e-9);
const simultaneous = simulate([{ ...trades[0]!, executableResultR: -1 }, { ...trades[0]!, pair: "AUD_USD", executableResultR: -1 }], Date.parse(stamp(0)), Date.parse(stamp(4)), false, market, rates);
assert.equal(simultaneous.endingBalance, 94);
assert.equal(simultaneous.maximumOpenPositions, 2);
const censored = simulate([{ ...trades[0]!, exitTimestamp: stamp(3) }], Date.parse(stamp(0)), Date.parse(stamp(2)), false,
  { ...market, EUR_USD: [candle(0, 100), candle(1, 105), candle(2, 120)] }, rates);
assert.equal(censored.endingBalance, 101.5, "Window ending uses available quote, never future recorded target");
assert.equal(censored.openPositionsAtEnd, 1);
const rejected = simulate([trades[0]!], Date.parse(stamp(0)), Date.parse(stamp(4)), true, market,
  { ...rates, EUR_USD: { ...rates.EUR_USD, marginRate: 5 } });
assert.equal(rejected.marginRejected, 1); assert.equal(rejected.filled, 0); assert.equal(rejected.endingBalance, 100);
console.log("Three-percent risk tests passed: compounding, drawdown, same-time risk, margin rejection, and no future exit leakage.");

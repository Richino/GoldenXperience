import assert from "node:assert/strict";
import {
  calculatePositionSize,
  deriveTradePermission,
} from "../src/lib/risk/engine";

const eurUsd = calculatePositionSize({
  instrument: "EUR_USD",
  accountBalance: 10_000,
  riskPercent: 1,
  entry: 1.1,
  stop: 1.095,
});

assert.ok(eurUsd);
assert.ok(Math.abs(eurUsd.stopDistancePips - 50) < 0.0001);
assert.equal(eurUsd.pipValuePerStandardLot, 10);
assert.equal(eurUsd.units, 20_000);
assert.ok(eurUsd.estimatedRisk <= 100);

const usdJpy = calculatePositionSize({
  instrument: "USD_JPY",
  accountBalance: 25_000,
  riskPercent: 1,
  entry: 156,
  stop: 155.5,
});

assert.ok(usdJpy);
assert.ok(Math.abs(usdJpy.stopDistancePips - 50) < 0.0001);
assert.ok(Math.abs(usdJpy.pipValuePerStandardLot - 6.410256) < 0.0001);
assert.ok(usdJpy.estimatedRisk <= 250);

const cappedPaperSize = calculatePositionSize({
  instrument: "EUR_USD",
  accountBalance: 100_000,
  riskPercent: 1,
  entry: 1.1,
  stop: 1.0996,
});

assert.ok(cappedPaperSize?.capped);
assert.equal(cappedPaperSize?.standardLots, cappedPaperSize?.capStandardLots);
assert.ok((cappedPaperSize?.calculatedStandardLots ?? 0) > (cappedPaperSize?.standardLots ?? 0));

const stopped = deriveTradePermission({
  restConnected: true,
  streamState: "connected",
  marketOpen: true,
  calendarConnected: true,
  dailyLossPercent: 2,
  tradesTaken: 1,
  consecutiveLosses: 0,
  setupValid: true,
  highImpactNewsWithinMinutes: null,
  spreadPips: 0.8,
});

assert.equal(stopped.permission, "blocked");

const allowed = deriveTradePermission({
  restConnected: true,
  streamState: "connected",
  marketOpen: true,
  calendarConnected: true,
  dailyLossPercent: 0.5,
  tradesTaken: 1,
  consecutiveLosses: 0,
  setupValid: true,
  highImpactNewsWithinMinutes: null,
  spreadPips: 0.8,
});

assert.equal(allowed.permission, "allowed");
console.log("Risk engine checks passed.");

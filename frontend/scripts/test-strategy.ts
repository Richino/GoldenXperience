import assert from "node:assert/strict";
import { evaluateStructure } from "../src/lib/strategy/market-structure";
import { evaluateStrategy, rankStrategySetups } from "../src/lib/strategy/strategy-engine";
import { calculatePositionSize, deriveTradePermission } from "../src/lib/risk/engine";
import type { Candle } from "../src/types/forex";

function candles(direction: "bull" | "bear" | "flat", count = 260): Candle[] {
  let close = direction === "bear" ? 1.25 : 1.05;
  return Array.from({ length: count }, (_, index) => {
    const drift = direction === "bull" ? 0.00022 : direction === "bear" ? -0.00022 : index % 2 ? 0.00003 : -0.00003;
    const open = close;
    close += drift;
    return {
      time: new Date(Date.UTC(2026, 0, 1, 0, index * 15)).toISOString(),
      open,
      high: Math.max(open, close) + 0.00014,
      low: Math.min(open, close) - 0.00014,
      close,
      volume: 100,
      complete: true,
    };
  });
}

const bullish = candles("bull");
const bearish = candles("bear");
const flat = candles("flat").map((candle) => ({ ...candle, open: 1.05, high: 1.0501, low: 1.0499, close: 1.05 }));

assert.equal(evaluateStrategy({
  instrument: "EUR_USD", accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda",
  candles15m: bullish, candles1h: bullish, candles4h: bullish, bid: 1.107, ask: 1.1071,
  spreadPips: 0.9, marketOpen: true, calendarConnected: true, highImpactNewsWithinMinutes: null,
}).direction, "long", "bull fixture should establish a bullish EMA direction");

assert.equal(evaluateStrategy({
  instrument: "EUR_USD", accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda",
  candles15m: bearish, candles1h: bearish, candles4h: bearish, bid: 1.193, ask: 1.1931,
  spreadPips: 0.9, marketOpen: true, calendarConnected: true, highImpactNewsWithinMinutes: null,
}).direction, "short", "bear fixture should establish a bearish EMA direction");

const spreadRejected = evaluateStrategy({
  instrument: "EUR_USD", accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda",
  candles15m: bullish, candles1h: bullish, candles4h: bullish, bid: 1.107, ask: 1.1075,
  spreadPips: 5, marketOpen: true, calendarConnected: true, highImpactNewsWithinMinutes: null,
});
assert.equal(spreadRejected.conditions.find((item) => item.name === "Spread")?.passed, false, "wide live spreads must reject the setup");

const mixed = evaluateStrategy({
  instrument: "EUR_USD", accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda",
  candles15m: flat, candles1h: flat, candles4h: flat, bid: 1.05, ask: 1.0501,
  spreadPips: 0.9, marketOpen: true, calendarConnected: true, highImpactNewsWithinMinutes: null,
});
assert.equal(mixed.status, "no_setup", "mixed EMA alignment must return no setup");

const noPullback = evaluateStrategy({
  instrument: "EUR_USD", accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda",
  candles15m: bullish, candles1h: bullish, candles4h: bullish, bid: 1.107, ask: 1.1071,
  spreadPips: 0.9, marketOpen: true, calendarConnected: true, highImpactNewsWithinMinutes: null,
});
assert.equal(noPullback.conditions.find((item) => item.name === "Pullback")?.passed, false, "a trend without an EMA pullback must not pass");

const limitedTargetCandles = candles("bull");
limitedTargetCandles[252] = { ...limitedTargetCandles[252]!, high: 1.108 };
limitedTargetCandles[250] = { ...limitedTargetCandles[250]!, high: 1.1074 };
limitedTargetCandles[254] = { ...limitedTargetCandles[254]!, high: 1.1075 };
const limitedTarget = evaluateStrategy({
  instrument: "EUR_USD", accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda",
  candles15m: limitedTargetCandles, candles1h: bullish, candles4h: bullish, bid: 1.107, ask: 1.1071,
  spreadPips: 0.9, marketOpen: true, calendarConnected: true, highImpactNewsWithinMinutes: null,
});
assert.equal(limitedTarget.conditions.find((item) => item.name === "Risk reward")?.passed, false, "a nearby opposing swing must reject sub-2R room");

const unavailable = evaluateStrategy({
  instrument: "EUR_USD", accountBalance: 10_000, accountCurrency: "USD", dataSource: "mock",
  candles15m: bullish, candles1h: bullish, candles4h: bullish, bid: 1.107, ask: 1.1071,
  spreadPips: 0.9, marketOpen: true, calendarConnected: true, highImpactNewsWithinMinutes: null,
});
assert.equal(unavailable.status, "invalid", "mock candle history cannot become an actionable setup");

const structureCandles = [
  [1.01, 1.00], [1.02, 1.01], [1.04, 1.02], [1.03, 1.015], [1.025, 1.005],
  [1.04, 1.02], [1.06, 1.03], [1.05, 1.025], [1.045, 1.015], [1.07, 1.04],
  [1.065, 1.035], [1.08, 1.05],
].map(([high, low], index) => ({ ...bullish[index]!, high, low, close: index === 11 ? 1.075 : (high + low) / 2 }));
const upStructure = evaluateStructure(structureCandles, "long");
assert.equal(upStructure.passed, true, "higher highs/higher lows should pass bullish structure");

const downStructure = evaluateStructure(structureCandles.map((candle) => ({
  ...candle,
  high: 2 - candle.low,
  low: 2 - candle.high,
  close: 2 - candle.close,
})), "short");
assert.equal(downStructure.passed, true, "lower highs/lower lows should pass bearish structure");

const eurSize = calculatePositionSize({ instrument: "EUR_USD", accountBalance: 10_000, riskPercent: 1, entry: 1.1, stop: 1.09 });
const jpySize = calculatePositionSize({ instrument: "USD_JPY", accountBalance: 10_000, riskPercent: 1, entry: 150, stop: 149 });
assert.ok(eurSize && eurSize.units > 0 && Math.abs(eurSize.stopDistancePips - 100) < 0.001, "EUR position size should use a 0.0001 pip");
assert.ok(jpySize && jpySize.units > 0 && Math.abs(jpySize.stopDistancePips - 100) < 0.001, "JPY position size should use a 0.01 pip");

const blockedByRisk = deriveTradePermission({ restConnected: true, streamState: "connected", marketOpen: true, calendarConnected: true, dailyLossPercent: 2, tradesTaken: 0, consecutiveLosses: 0, setupValid: true, highImpactNewsWithinMinutes: null, spreadPips: 0.5 });
const blockedByLosses = deriveTradePermission({ restConnected: true, streamState: "connected", marketOpen: true, calendarConnected: true, dailyLossPercent: 0, tradesTaken: 0, consecutiveLosses: 2, setupValid: true, highImpactNewsWithinMinutes: null, spreadPips: 0.5 });
assert.equal(blockedByRisk.permission, "blocked", "daily loss must block trading");
assert.equal(blockedByLosses.permission, "blocked", "consecutive losses must block trading");

const ranked = rankStrategySetups([spreadRejected, unavailable]);
assert.equal(ranked.bestSetup.status, "invalid", "ranking must be deterministic even when every setup is blocked");

console.log("Strategy fixture checks passed.");

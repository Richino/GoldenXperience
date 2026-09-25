import assert from "node:assert/strict";
import { analyzeTrendPullbackV1 } from "../src/lib/strategy/trend-pullback-v1";
import type { Candle } from "../src/types/forex";

function candlesFromTurns(turns: Array<[number, number]>): Candle[] {
  const closes: number[] = [];
  for (let segment = 0; segment < turns.length - 1; segment += 1) {
    const [startIndex, startPrice] = turns[segment]!;
    const [endIndex, endPrice] = turns[segment + 1]!;
    for (let index = startIndex; index < endIndex; index += 1) {
      closes[index] = startPrice + (endPrice - startPrice) * (index - startIndex) / (endIndex - startIndex);
    }
  }
  closes[turns.at(-1)![0]] = turns.at(-1)![1];
  return closes.map((close, index) => ({
    time: new Date(Date.UTC(2026, 8, 23, 0, index * 15)).toISOString(),
    open: closes[index - 1] ?? close,
    high: close + 0.00008,
    low: close - 0.00008,
    close,
    volume: 100,
    complete: true,
  }));
}

const candles = candlesFromTurns([
  [0, 1.1000], [8, 1.1040], [12, 1.1010], [20, 1.1080],
  [25, 1.1030], [33, 1.1110], [38, 1.1050], [46, 1.1210], [50, 1.1160],
]);
const plan = analyzeTrendPullbackV1({ instrument: "EUR_USD", candles, currentPrice: 1.1160 });
assert.equal(plan.strategy, "TrendPullbackV1");
assert.equal(plan.majorTrend, "BULLISH");
assert.equal(plan.currentTrend, "BULLISH");
assert.equal(plan.status, "TRADE_PLAN");
assert.equal(plan.orderType, "BUY_LIMIT");
assert.ok(plan.entry !== null && plan.entry < plan.currentPrice);
assert.ok(plan.stopLoss !== null && plan.entry !== null && plan.stopLoss < plan.entry);
assert.ok(plan.takeProfit !== null && plan.entry !== null && plan.takeProfit > plan.entry);
assert.ok(plan.debug.invalidationLevel !== null && plan.stopLoss !== null && plan.stopLoss < plan.debug.invalidationLevel, "long stop must sit beyond deeper structural support");
assert.ok((plan.riskReward ?? 0) >= 1.5, "plan must meet the minimum risk/reward");
const entryNow = analyzeTrendPullbackV1({ instrument: "EUR_USD", candles, currentPrice: plan.entry });
assert.equal(entryNow.status, "ENTRY_AVAILABLE_NOW");
assert.equal(entryNow.entry, plan.entry);

const noQuote = analyzeTrendPullbackV1({ instrument: "EUR_USD", candles });
assert.equal(noQuote.priceBasis, "LAST_M15_CLOSE");
assert.equal(noQuote.status, "TRADE_PLAN");
assert.ok(noQuote.entry !== null);

assert.equal(plan.debug.trendSource, "LEGACY_SWING_TREND_LINES");
assert.equal(plan.debug.pullbackLevelKind, "SWING_SUPPORT");
assert.ok(plan.debug.targetLevel !== null && plan.entry !== null && plan.debug.targetLevel > plan.entry);

const flatCandles = candlesFromTurns([[0, 1.1000], [30, 1.1000]]);
const noTrend = analyzeTrendPullbackV1({ instrument: "EUR_USD", candles: flatCandles, currentPrice: 1.1000 });
assert.equal(noTrend.status, "NO_VALID_ENTRY");
assert.match(noTrend.reasons[0] ?? "", /legacy swing trend/i);
const bearishCandles = candles.map((candle) => ({
  ...candle,
  open: 2.2 - candle.open,
  high: 2.2 - candle.low,
  low: 2.2 - candle.high,
  close: 2.2 - candle.close,
}));
const shortPlan = analyzeTrendPullbackV1({ instrument: "EUR_USD", candles: bearishCandles, currentPrice: 1.091 });
assert.equal(shortPlan.status, "TRADE_PLAN");
assert.equal(shortPlan.orderType, "SELL_LIMIT");
assert.ok(shortPlan.entry !== null && shortPlan.entry > shortPlan.currentPrice);
assert.ok(shortPlan.stopLoss !== null && shortPlan.entry !== null && shortPlan.stopLoss > shortPlan.entry);
assert.ok(shortPlan.takeProfit !== null && shortPlan.entry !== null && shortPlan.takeProfit < shortPlan.entry);
assert.ok(shortPlan.debug.invalidationLevel !== null && shortPlan.stopLoss !== null && shortPlan.stopLoss > shortPlan.debug.invalidationLevel, "short stop must sit beyond deeper structural resistance");

const ignoredIncomplete = analyzeTrendPullbackV1({ instrument: "EUR_USD", candles: [
  ...candles, { ...candles.at(-1)!, time: new Date(Date.UTC(2026, 8, 23, 12, 45)).toISOString(), close: 1.2, high: 1.2, complete: false },
], currentPrice: 1.116 });
assert.equal(ignoredIncomplete.entry, plan.entry);
console.log("TrendPullbackV1 fixtures passed.");

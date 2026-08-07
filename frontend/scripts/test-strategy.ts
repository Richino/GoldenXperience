import assert from "node:assert/strict";
import { evaluateStructure } from "../src/lib/strategy/market-structure";
import { dayTradingSession, evaluateStrategy, getPaperTradingAvailability, rankStrategySetups } from "../src/lib/strategy/strategy-engine";
import { calculatePositionSize, deriveTradePermission, spreadWithinLimit } from "../src/lib/risk/engine";
import { pipSizeFor } from "../src/lib/instruments/catalog";
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

// Both centres trade 08:00–17:00 on their own clock. Through a week where the
// UK and US are both on summer time that is 03:00–12:00 ET for London and
// 08:00–17:00 ET for New York.
assert.equal(dayTradingSession(new Date("2026-04-06T06:59:00.000Z")).open, false, "a minute before the London open must reject entries");
assert.equal(dayTradingSession(new Date("2026-04-06T07:00:00.000Z")).label, "London", "London alone must not be labelled as the overlap");
assert.equal(dayTradingSession(new Date("2026-04-06T12:00:00.000Z")).label, "London/New York overlap", "the New York open must start the overlap");
assert.equal(dayTradingSession(new Date("2026-04-06T15:59:00.000Z")).label, "London/New York overlap", "11:59 ET must still be the overlap");

// The New York session is tradeable once London closes, labelled apart from the
// morning so session analytics can separate the two. Entries stop at the forced
// exit: a later one is flattened at 16:45 ET before it can resolve.
assert.equal(dayTradingSession(new Date("2026-04-06T16:00:00.000Z")).label, "New York", "the afternoon must not be labelled as the overlap");
assert.equal(dayTradingSession(new Date("2026-04-06T20:44:00.000Z")).open, true, "16:44 ET must be the last eligible minute");
assert.equal(dayTradingSession(new Date("2026-04-06T20:45:00.000Z")).open, false, "the 16:45 ET forced exit must reject entries");
assert.equal(dayTradingSession(new Date("2026-11-02T21:45:00.000Z")).open, false, "16:45 ET after DST ends must reject entries");
assert.equal(dayTradingSession(new Date("2026-11-02T08:00:00.000Z")).label, "London", "03:00 ET after both zones leave DST must be the London open");

// The UK and US change daylight saving on different dates — in 2026 the US on
// 8 March and 1 November, the UK on 29 March and 25 October. Through the gap
// weeks an Eastern-anchored boundary sits an hour off the London session, so
// each centre is resolved against its own zone.
assert.equal(dayTradingSession(new Date("2026-03-16T07:00:00.000Z")).open, false, "03:00 ET is an hour before London opens while only the US is on DST");
assert.equal(dayTradingSession(new Date("2026-03-16T08:00:00.000Z")).label, "London", "the spring gap must open with London at 08:00 UK time");
assert.equal(dayTradingSession(new Date("2026-10-27T12:00:00.000Z")).label, "London/New York overlap", "08:00 ET in the autumn gap still overlaps a trading London");
assert.equal(dayTradingSession(new Date("2026-10-27T17:00:00.000Z")).label, "New York", "London must close on its own 17:00 rather than an ET offset");
assert.equal(getPaperTradingAvailability(new Date("2026-08-01T16:00:00.000Z")).state, "market_closed", "Saturday must be presented as a closed-market waiting state");
assert.equal(getPaperTradingAvailability(new Date("2026-08-02T22:00:00.000Z")).state, "waiting_for_entry_window", "Sunday evening must wait for the day entry window");
assert.equal(getPaperTradingAvailability(new Date("2026-08-03T11:00:00.000Z")).state, "entry_window_open", "Monday 07:00 ET must open the entry window");

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

// A spread derived from the quote lands a few ulps above an exact limit, so a
// bare `<=` rejected EUR_USD at precisely 1.5 pips.
const derivedSpread = (1.15612 - 1.15597) / pipSizeFor("EUR_USD");
assert.ok(derivedSpread > 1.5, "the derived EUR_USD spread must still carry the representation error this guards");
const spreadAtLimit = evaluateStrategy({
  instrument: "EUR_USD", accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda",
  candles15m: bullish, candles1h: bullish, candles4h: bullish, bid: 1.15597, ask: 1.15612,
  spreadPips: derivedSpread, marketOpen: true, calendarConnected: true, highImpactNewsWithinMinutes: null,
});
assert.equal(spreadAtLimit.conditions.find((item) => item.name === "Spread")?.passed, true, "a spread exactly at the pair limit must not be rejected by float representation error");
assert.equal(spreadWithinLimit(1.55, 1.5), false, "the tolerance must not widen the limit to the displayed 0.1-pip precision");
assert.equal(deriveTradePermission({ restConnected: true, streamState: "connected", marketOpen: true, calendarConnected: true, dailyLossPercent: 0, tradesTaken: 0, consecutiveLosses: 0, setupValid: true, highImpactNewsWithinMinutes: null, spreadPips: derivedSpread }).permission, "allowed", "the risk-engine spread gate must share the strategy tolerance");

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
const explorationReward = limitedTarget.conditions.find((item) => item.name === "Risk reward");
assert.equal(explorationReward?.required, false, "the active exploration strategy must not use reward-to-risk as a rejection gate");
assert.ok(limitedTarget.entry !== null && limitedTarget.stop !== null && limitedTarget.target !== null && Math.abs(limitedTarget.riskReward! - 1.5) < 0.001, "the exploration target must be fixed at 1.5R");
const legacyLimitedTarget = evaluateStrategy({
  instrument: "EUR_USD", accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda",
  candles15m: limitedTargetCandles, candles1h: bullish, candles4h: bullish, bid: 1.107, ask: 1.1071,
  spreadPips: 0.9, marketOpen: true, calendarConnected: true, highImpactNewsWithinMinutes: null,
}, { minimumRiskReward: 2 });
assert.equal(legacyLimitedTarget.conditions.find((item) => item.name === "Risk reward")?.passed, false, "retired explicit minimum-R experiments must remain reproducible");

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
const uncappedSize = calculatePositionSize({ instrument: "EUR_USD", accountBalance: 10_000, riskPercent: 1, entry: 1.1, stop: 1.0999, applyPaperCap: false });
assert.ok(eurSize && eurSize.units > 0 && Math.abs(eurSize.stopDistancePips - 100) < 0.001, "EUR position size should use a 0.0001 pip");
assert.ok(jpySize && jpySize.units > 0 && Math.abs(jpySize.stopDistancePips - 100) < 0.001, "JPY position size should use a 0.01 pip");
assert.ok(uncappedSize && uncappedSize.calculatedStandardLots > 2 && uncappedSize.standardLots === uncappedSize.calculatedStandardLots && !uncappedSize.capped, "automatic research sizing must retain the uncapped nominal 1% calculation");

const blockedByRisk = deriveTradePermission({ restConnected: true, streamState: "connected", marketOpen: true, calendarConnected: true, dailyLossPercent: 2, tradesTaken: 0, consecutiveLosses: 0, setupValid: true, highImpactNewsWithinMinutes: null, spreadPips: 0.5 });
const blockedByLosses = deriveTradePermission({ restConnected: true, streamState: "connected", marketOpen: true, calendarConnected: true, dailyLossPercent: 0, tradesTaken: 0, consecutiveLosses: 2, setupValid: true, highImpactNewsWithinMinutes: null, spreadPips: 0.5 });
assert.equal(blockedByRisk.permission, "blocked", "daily loss must block trading");
assert.equal(blockedByLosses.permission, "blocked", "consecutive losses must block trading");

const ranked = rankStrategySetups([spreadRejected, unavailable]);
assert.equal(ranked.bestSetup.status, "invalid", "ranking must be deterministic even when every setup is blocked");

console.log("Strategy fixture checks passed.");

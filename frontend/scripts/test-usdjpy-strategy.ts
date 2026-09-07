import assert from "node:assert/strict";

import {
  ATR_LENGTH, BODY_ATR_MIN, EMA_FAST, EMA_SLOW, ENTRY_WINDOW_END_UTC,
  ENTRY_WINDOW_START_UTC, EXTREME_CLOSE_PCT, MAX_HOLD_BARS,
  PRE_RANGE_END_UTC, PRE_RANGE_START_UTC, REWARD_R, STOP_ATR_MULTIPLIER,
  USDJPY_STRATEGY_VERSION, evaluateUsdjpyStrategy, evaluateUsdjpyStrategyTrace,
  resolveUsdjpyExit,
} from "../src/lib/strategy/strategies/usdjpy-strategy";
import { PAIR_STRATEGY_REGISTRY } from "../src/lib/strategy/strategies";
import type { StrategyEvaluationInput } from "../src/lib/strategy/types";
import type { Candle } from "../src/types/forex";

function candle(time: string, open: number, high: number, low: number, close: number, complete = true): Candle {
  return { time, open, high, low, close, volume: 100, complete };
}

function fixture(signalHour = 11, trend: "bullish" | "bearish" = "bullish", day = "2026-08-05"): Candle[] {
  const signalTime = `${day}T${String(signalHour).padStart(2, "0")}:00:00.000Z`;
  const signalMs = Date.parse(signalTime);
  const sign = trend === "bullish" ? 1 : -1;
  const bars = Array.from({ length: 180 }, (_, index) => {
    const time = new Date(signalMs - (180 - index) * 60 * 60_000).toISOString();
    const open = 145 + sign * index * 0.025;
    const close = open + sign * 0.01;
    return candle(time, open, Math.max(open, close) + 0.05, Math.min(open, close) - 0.05, close);
  });
  const range = bars.filter((bar) => bar.time.startsWith(day) && new Date(bar.time).getUTCHours() >= 8 && new Date(bar.time).getUTCHours() <= 10);
  const preHigh = Math.max(...range.map((bar) => bar.high));
  const signal = candle(signalTime, preHigh - 0.12, preHigh + 0.23, preHigh - 0.17, preHigh + 0.20);
  return [...bars, signal];
}

function input(candles1h: Candle[], instrument = "USD_JPY"): StrategyEvaluationInput {
  const last = candles1h.filter((bar) => bar.complete).at(-1)!;
  return {
    instrument,
    accountBalance: 10_000,
    accountCurrency: "USD",
    dataSource: "oanda",
    candles15m: [],
    candles1h,
    candles4h: [],
    bid: last.close - 0.01,
    ask: last.close + 0.01,
    spreadPips: 2,
    marketOpen: true,
    calendarConnected: true,
    highImpactNewsWithinMinutes: null,
    evaluatedAt: new Date(Date.parse(last.time) + 60 * 60_000).toISOString(),
    evaluationMode: "historical_replay",
  };
}

function trace(candles: Candle[]) {
  const result = evaluateUsdjpyStrategyTrace(candles);
  assert.equal(result.error, null);
  return result.rows;
}

function lastTrace(candles: Candle[]) {
  return trace(candles).at(-1)!;
}

assert.deepEqual(
  {
    EMA_FAST, EMA_SLOW, ATR_LENGTH, PRE_RANGE_START_UTC, PRE_RANGE_END_UTC,
    ENTRY_WINDOW_START_UTC, ENTRY_WINDOW_END_UTC, BODY_ATR_MIN,
    EXTREME_CLOSE_PCT, STOP_ATR_MULTIPLIER, REWARD_R, MAX_HOLD_BARS,
    USDJPY_STRATEGY_VERSION,
  },
  {
    EMA_FAST: 20, EMA_SLOW: 50, ATR_LENGTH: 14,
    PRE_RANGE_START_UTC: 8, PRE_RANGE_END_UTC: 10,
    ENTRY_WINDOW_START_UTC: 11, ENTRY_WINDOW_END_UTC: 14,
    BODY_ATR_MIN: 0.4, EXTREME_CLOSE_PCT: 0.4,
    STOP_ATR_MULTIPLIER: 1, REWARD_R: 2, MAX_HOLD_BARS: 3,
    USDJPY_STRATEGY_VERSION: 6,
  },
);

for (const hour of [11, 12, 13, 14]) {
  const result = evaluateUsdjpyStrategy(input(fixture(hour)));
  assert.equal(result.status, "valid", `${hour}:00 must qualify`);
  assert.equal(result.direction, "long");
  assert.equal(result.family, "usdjpy_strategy");
  assert.equal(result.version, "v6");
  assert.equal(result.features.usdjpyStrategy?.strategyVersion, 6);
  assert.equal(result.features.usdjpyStrategy?.signalKey, "usdjpy_strategy:USD_JPY:2026-08-05");
  assert.equal(result.evaluatedAt, `2026-08-05T${String(hour + 1).padStart(2, "0")}:00:00.000Z`);
  assert.equal(result.failedConditions.find((item) => item.name === "Spread")?.required, true,
    "the Pine signal and shared execution-gate verdict must remain separate");
}

assert.equal(evaluateUsdjpyStrategy(input(fixture(), "EUR_USD")).features.usdjpyStrategy?.waitReason, "WRONG_SYMBOL");
assert.equal(evaluateUsdjpyStrategy(input(fixture()), { timeframe: "M15" }).features.usdjpyStrategy?.waitReason, "WRONG_TIMEFRAME");
assert.equal(evaluateUsdjpyStrategy(input(fixture(10))).features.usdjpyStrategy?.waitReason, "OUTSIDE_ENTRY_WINDOW");
assert.equal(evaluateUsdjpyStrategy(input(fixture(15))).features.usdjpyStrategy?.waitReason, "OUTSIDE_ENTRY_WINDOW");

{
  const bars = fixture(11, "bearish");
  const base = lastTrace(bars);
  const signal = bars.at(-1)!;
  bars[bars.length - 1] = candle(signal.time, base.preLow! + 0.12, base.preLow! + 0.17, base.preLow! - 0.23, base.preLow! - 0.20);
  const result = evaluateUsdjpyStrategy(input(bars));
  assert.equal(result.direction, null);
  assert.equal(result.features.usdjpyStrategy?.finalShortSignal, false);
  assert.equal(result.features.usdjpyStrategy?.waitReason, "TREND_NOT_LONG");
}

{
  const bars = fixture();
  const base = lastTrace(bars);
  const signal = bars.at(-1)!;
  bars[bars.length - 1] = candle(signal.time, base.preHigh! - 0.12, base.preHigh! + 0.20, base.preHigh! - 0.17, base.preHigh! - 0.01);
  assert.equal(evaluateUsdjpyStrategy(input(bars)).features.usdjpyStrategy?.waitReason, "NO_CLOSE_BREAKOUT");
}

{
  const bars = fixture();
  const base = lastTrace(bars);
  bars[bars.length - 1] = candle(bars.at(-1)!.time, base.preHigh! + 0.001, base.preHigh! + 0.003, base.preHigh!, base.preHigh! + 0.002);
  assert.equal(evaluateUsdjpyStrategy(input(bars)).features.usdjpyStrategy?.waitReason, "BODY_TOO_SMALL");
}

{
  const bars = fixture();
  const base = lastTrace(bars);
  bars[bars.length - 1] = candle(bars.at(-1)!.time, base.preHigh! - 0.20, base.preHigh! + 0.80, base.preHigh! - 0.30, base.preHigh! + 0.20);
  assert.equal(evaluateUsdjpyStrategy(input(bars)).features.usdjpyStrategy?.waitReason, "BAD_CLOSE_LOCATION");
}

{
  const bars = fixture().filter((bar) => bar.time !== "2026-08-05T09:00:00.000Z");
  assert.equal(evaluateUsdjpyStrategy(input(bars)).features.usdjpyStrategy?.waitReason, "MISSING_RANGE");
}

{
  const bars = fixture(11);
  const first = bars.at(-1)!;
  bars.push(candle("2026-08-05T12:00:00.000Z", first.close - 0.12, first.close + 0.23, first.close - 0.17, first.close + 0.20));
  const result = evaluateUsdjpyStrategy(input(bars));
  assert.equal(result.direction, null);
  assert.equal(result.features.usdjpyStrategy?.waitReason, "DAILY_TRADE_ALREADY_TAKEN");
}

{
  const bars = fixture();
  const result = evaluateUsdjpyStrategy(input(bars));
  const atr = result.features.usdjpyStrategy!.entryATR!;
  assert.ok(Math.abs(result.entry! - result.stop! - atr) < 1e-12);
  assert.ok(Math.abs(result.target! - result.entry! - 2 * atr) < 1e-12);
  const signalRow = lastTrace(bars);
  const future = candle("2026-08-05T12:00:00.000Z", 150, 170, 130, 160);
  const preserved = trace([...bars, future]).find((row) => row.timestamp === signalRow.timestamp)!;
  assert.equal(preserved.atr14, signalRow.atr14);
  assert.equal(preserved.stop, signalRow.stop);
  assert.equal(preserved.target, signalRow.target);
}

{
  const decisionTime = "2026-08-05T12:00:00.000Z";
  const quotes = [1, 2, 3].map((hour) => ({
    closeTime: new Date(Date.parse(decisionTime) + hour * 60 * 60_000).toISOString(),
    bidHigh: 150.4, bidLow: 149.6, bidClose: 150.3,
    askHigh: 150.42, askLow: 149.62, askClose: 150.32,
  }));
  assert.equal(resolveUsdjpyExit({ direction: "long", entry: 150, stop: 149, target: 152, decisionTime, quotes, now: new Date("2026-08-05T14:59:59.000Z") }), null);
  const result = resolveUsdjpyExit({ direction: "long", entry: 150, stop: 149, target: 152, decisionTime, quotes, now: new Date("2026-08-05T15:00:00.000Z") });
  assert.equal(result?.exitReason, "TIME_EXIT");
  assert.equal(result?.barsHeld, 3);
  assert.ok(Math.abs(result!.resultR - 0.3) < 1e-12);
}

{
  const result = resolveUsdjpyExit({
    direction: "long", entry: 150, stop: 149, target: 152, decisionTime: "2026-08-05T12:00:00.000Z",
    quotes: [{ closeTime: "2026-08-05T13:00:00.000Z", bidHigh: 152.1, bidLow: 148.9, bidClose: 150, askHigh: 152.12, askLow: 148.92, askClose: 150.02 }],
    now: new Date("2026-08-05T13:00:00.000Z"),
  });
  assert.equal(result?.exitReason, "STOP_LOSS");
  assert.equal(result?.resultR, -1);
}

assert.equal(evaluateUsdjpyStrategy(input(fixture()), { hasActivePosition: true }).features.usdjpyStrategy?.waitReason, "POSITION_ALREADY_OPEN");

{
  const bars = fixture();
  bars.push(candle("2026-08-06T11:00:00.000Z", 151, 152, 150, 151.8));
  const nextDay = lastTrace(bars);
  assert.equal(nextDay.rangeReady, false);
  assert.equal(nextDay.tradedEarlierUtcDay, false);
}

assert.equal(PAIR_STRATEGY_REGISTRY.USD_JPY.id, "usdjpy_strategy");
assert.equal(PAIR_STRATEGY_REGISTRY.USD_JPY.version, "v6");
assert.equal(PAIR_STRATEGY_REGISTRY.USD_JPY.executionEnabled, true);
assert.equal(PAIR_STRATEGY_REGISTRY.EUR_USD.executionEnabled, false);

console.log("usdjpy_strategy V6 tests passed");

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  NZDUSD_ATR_LENGTH, NZDUSD_BODY_ATR_MIN, NZDUSD_EMA_FAST, NZDUSD_EMA_SLOW,
  NZDUSD_MAX_HOLD_BARS, NZDUSD_PRE_RANGE_END_UTC, NZDUSD_PRE_RANGE_START_UTC,
  NZDUSD_REWARD_R, NZDUSD_SIGNAL_ORIGIN_UTC, NZDUSD_STOP_ATR_MULTIPLIER,
  evaluateNzdusdStrategy, evaluateNzdusdStrategyTrace, nzdusdDirection,
  nzdusdTradeGeometry, resolveNzdusdExit,
} from "../src/lib/strategy/strategies/nzdusd-strategy";
import { ENABLED_PAIR_STRATEGY_IDS, PAIR_STRATEGY_REGISTRY } from "../src/lib/strategy/strategies";
import type { StrategyEvaluationInput } from "../src/lib/strategy/types";
import type { Candle } from "../src/types/forex";

const SIGNAL_START = "2026-08-05T11:00:00.000Z";
const SIGNAL_TIME = "2026-08-05T12:00:00.000Z";

function candle(time: string, open: number, high: number, low: number, close: number, complete = true): Candle {
  return { time, open, high, low, close, volume: 100, complete };
}

function fixture(direction: "long" | "short", tag: "base" | "body" = "body") {
  const signalMs = Date.parse(SIGNAL_START);
  const bars = Array.from({ length: 120 }, (_, index) => {
    const time = new Date(signalMs - (120 - index) * 60 * 60_000).toISOString();
    const close = direction === "long" ? 0.60 + index * 0.0002 : 0.64 - index * 0.0002;
    return candle(time, close - 0.00003, close + 0.0002, close - 0.0002, close);
  });
  const prior = bars.at(-1)!;
  if (direction === "long") {
    const preHigh = prior.high;
    const close = tag === "body" ? preHigh + 0.0007 : preHigh + 0.00001;
    const open = tag === "body" ? preHigh - 0.0002 : preHigh + 0.000005;
    bars.push(candle(SIGNAL_START, open, close + 0.0001, open - 0.0001, close));
  } else {
    const preLow = prior.low;
    const close = tag === "body" ? preLow - 0.0007 : preLow - 0.00001;
    const open = tag === "body" ? preLow + 0.0002 : preLow - 0.000005;
    bars.push(candle(SIGNAL_START, open, open + 0.0001, close - 0.0001, close));
  }
  return bars;
}

function input(candles1h: Candle[], instrument = "NZD_USD"): StrategyEvaluationInput {
  const close = candles1h.filter((bar) => bar.complete).at(-1)?.close ?? 0.62;
  return {
    instrument,
    accountBalance: 10_000,
    accountCurrency: "USD",
    dataSource: "oanda",
    candles15m: [],
    candles1h,
    candles4h: [],
    bid: close - 0.0001,
    ask: close + 0.0001,
    spreadPips: 2,
    marketOpen: true,
    calendarConnected: true,
    highImpactNewsWithinMinutes: null,
    evaluatedAt: SIGNAL_TIME,
    evaluationMode: "historical_replay",
  };
}

assert.deepEqual({
  NZDUSD_EMA_FAST, NZDUSD_EMA_SLOW, NZDUSD_ATR_LENGTH, NZDUSD_PRE_RANGE_START_UTC,
  NZDUSD_PRE_RANGE_END_UTC, NZDUSD_SIGNAL_ORIGIN_UTC, NZDUSD_BODY_ATR_MIN,
  NZDUSD_STOP_ATR_MULTIPLIER, NZDUSD_REWARD_R, NZDUSD_MAX_HOLD_BARS,
}, {
  NZDUSD_EMA_FAST: 20, NZDUSD_EMA_SLOW: 50, NZDUSD_ATR_LENGTH: 14,
  NZDUSD_PRE_RANGE_START_UTC: 6, NZDUSD_PRE_RANGE_END_UTC: 10,
  NZDUSD_SIGNAL_ORIGIN_UTC: 11, NZDUSD_BODY_ATR_MIN: 0.5,
  NZDUSD_STOP_ATR_MULTIPLIER: 1, NZDUSD_REWARD_R: 2, NZDUSD_MAX_HOLD_BARS: 3,
});

// Tests 1-3: EMA-only direction.
assert.equal(nzdusdDirection(2, 1), "LONG");
assert.equal(nzdusdDirection(1, 2), "SHORT");
assert.equal(nzdusdDirection(1, 1), "WAIT");

// Test 4: strict long breakout.
assert.equal(evaluateNzdusdStrategy(input(fixture("long"))).direction, "long");

// Test 5: equality with the pre-range high is not a breakout.
{
  const bars = fixture("long");
  const preHigh = evaluateNzdusdStrategyTrace(bars).rows.at(-1)!.preRangeHigh!;
  bars[bars.length - 1] = candle(SIGNAL_START, preHigh - 0.0001, preHigh + 0.0001, preHigh - 0.0002, preHigh);
  assert.equal(evaluateNzdusdStrategy(input(bars)).features.nzdusdStrategy?.waitReason, "LONG_BREAKOUT_FAILED");
}

// Test 6: strict short breakout.
assert.equal(evaluateNzdusdStrategy(input(fixture("short"))).direction, "short");

// Test 7: equality with the pre-range low is not a breakout.
{
  const bars = fixture("short");
  const preLow = evaluateNzdusdStrategyTrace(bars).rows.at(-1)!.preRangeLow!;
  bars[bars.length - 1] = candle(SIGNAL_START, preLow + 0.0001, preLow + 0.0002, preLow - 0.0001, preLow);
  assert.equal(evaluateNzdusdStrategy(input(bars)).features.nzdusdStrategy?.waitReason, "SHORT_BREAKOUT_FAILED");
}

// Test 8: every exact 06:00-10:00 candle is mandatory and named precisely.
for (const hour of [6, 7, 8, 9, 10]) {
  const timestamp = `2026-08-05T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const missing = fixture("long").filter((bar) => bar.time !== timestamp);
  assert.equal(evaluateNzdusdStrategy(input(missing)).features.nzdusdStrategy?.waitReason,
    `MISSING_${String(hour).padStart(2, "0")}00_CANDLE`);
}

// Tests 9-10: forming origin fails; completed origin evaluates.
{
  const forming = fixture("long");
  forming[forming.length - 1] = { ...forming.at(-1)!, complete: false };
  assert.equal(evaluateNzdusdStrategy(input(forming)).features.nzdusdStrategy?.waitReason, "ORIGIN_NOT_COMPLETE");
  assert.equal(evaluateNzdusdStrategy(input(fixture("long"))).status, "valid");
}

// Tests 11-12: exact long/short frozen geometry.
assert.deepEqual(nzdusdTradeGeometry(1, 0.002, "long"), { stopLoss: 0.998, takeProfit: 1.004 });
assert.deepEqual(nzdusdTradeGeometry(1, 0.002, "short"), { stopLoss: 1.002, takeProfit: 0.996 });

// Test 13: later ATR changes cannot mutate the stored origin row.
{
  const bars = fixture("long");
  const before = evaluateNzdusdStrategyTrace(bars).rows.at(-1)!;
  const after = evaluateNzdusdStrategyTrace([
    ...bars, candle("2026-08-05T12:00:00.000Z", 0.62, 0.70, 0.50, 0.65),
  ]).rows.find((row) => row.timestamp === SIGNAL_START)!;
  assert.equal(after.atr14, before.atr14);
  assert.equal(after.stopLoss, before.stopLoss);
  assert.equal(after.takeProfit, before.takeProfit);
}

const neutralQuotes = [1, 2, 3].map((hour) => ({
  closeTime: new Date(Date.parse(SIGNAL_TIME) + hour * 60 * 60_000).toISOString(),
  bidHigh: 1.001, bidLow: 0.999, bidClose: 1.0005,
  askHigh: 1.0012, askLow: 0.9992, askClose: 1.0007,
}));

// Tests 14-16: target, stop, and exact third-future-H1 TIME_EXIT.
assert.equal(resolveNzdusdExit({ direction: "long", entry: 1, stop: 0.998, target: 1.004, decisionTime: SIGNAL_TIME,
  now: new Date("2026-08-05T13:00:00.000Z"), quotes: [{ ...neutralQuotes[0]!, bidHigh: 1.0041 }] })?.exitReason, "TP");
assert.equal(resolveNzdusdExit({ direction: "short", entry: 1, stop: 1.002, target: 0.996, decisionTime: SIGNAL_TIME,
  now: new Date("2026-08-05T13:00:00.000Z"), quotes: [{ ...neutralQuotes[0]!, askHigh: 1.0021 }] })?.exitReason, "SL");
const timeExit = resolveNzdusdExit({ direction: "long", entry: 1, stop: 0.998, target: 1.004,
  decisionTime: SIGNAL_TIME, now: new Date("2026-08-05T15:00:00.000Z"), quotes: neutralQuotes });
assert.equal(timeExit?.exitReason, "TIME_EXIT");
assert.equal(timeExit?.barsHeld, 3);

// Same-bar historical ambiguity is conservatively a stop.
assert.equal(resolveNzdusdExit({ direction: "long", entry: 1, stop: 0.998, target: 1.004, decisionTime: SIGNAL_TIME,
  now: new Date("2026-08-05T13:00:00.000Z"), quotes: [{ ...neutralQuotes[0]!, bidHigh: 1.005, bidLow: 0.997 }] })?.exitReason, "SL");

// Tests 17-18: BODY is metadata only; both BASE and BODY enter.
const base = evaluateNzdusdStrategy(input(fixture("long", "base")));
assert.equal(base.status, "valid");
assert.equal(base.features.nzdusdStrategy?.confidenceTag, "NZDUSD_BASE");
const body = evaluateNzdusdStrategy(input(fixture("short", "body")));
assert.equal(body.status, "valid");
assert.equal(body.features.nzdusdStrategy?.confidenceTag, "NZDUSD_BODY");

// Test 19: a repeated daily signal is rejected deterministically.
const duplicate = evaluateNzdusdStrategy(input(fixture("long")), { duplicateSignal: true });
assert.equal(duplicate.direction, null);
assert.equal(duplicate.features.nzdusdStrategy?.waitReason, "DUPLICATE_SIGNAL");

// Test 20: 12:00 UTC is not an origin.
{
  const bars = fixture("long");
  bars.push(candle("2026-08-05T12:00:00.000Z", 0.63, 0.64, 0.62, 0.635));
  assert.equal(evaluateNzdusdStrategy(input(bars)).features.nzdusdStrategy?.waitReason, "NOT_1100_UTC");
}

// Test 21: serialized open state retains the frozen restart boundary.
const durable = JSON.parse(JSON.stringify(base.features.nzdusdStrategy)) as NonNullable<typeof base.features.nzdusdStrategy>;
assert.equal(durable.strategyId, "nzdusd_strategy");
assert.equal(durable.strategyVersion, "NZDUSD_PRE_RANGE_BREAKOUT_V1");
assert.equal(durable.signalKey, "NZDUSD-2026-08-05-1100");
assert.equal(durable.entryATR, base.features.nzdusdStrategy?.entryATR);
assert.equal(durable.stopLoss, base.stop);
assert.equal(durable.takeProfit, base.target);
assert.equal(durable.expirationTimeUtc, "2026-08-05T15:00:00.000Z");

assert.equal(PAIR_STRATEGY_REGISTRY.NZD_USD.id, "nzdusd_strategy");
assert.equal(PAIR_STRATEGY_REGISTRY.NZD_USD.timeframe, "H1");
assert.equal(PAIR_STRATEGY_REGISTRY.NZD_USD.executionEnabled, true);
assert.equal(PAIR_STRATEGY_REGISTRY.NZD_USD.adaptiveParametersMutable, false);
assert.ok(ENABLED_PAIR_STRATEGY_IDS.includes("nzdusd_strategy"));
assert.equal(evaluateNzdusdStrategy(input(fixture("long"), "AUD_USD")).features.nzdusdStrategy?.waitReason, "WRONG_SYMBOL");
assert.equal(evaluateNzdusdStrategy(input(fixture("long")), { timeframe: "M15" }).features.nzdusdStrategy?.waitReason, "WRONG_TIMEFRAME");

const migration = readFileSync(resolve(process.cwd(), "../api-server/migrations/043_register_nzdusd_strategy.sql"), "utf8");
assert.match(migration, /paper_strategy_nzdusd_signal_key_idx/, "the daily signal key has a durable unique index");
assert.match(migration, /'NZDUSD_PRE_RANGE_BREAKOUT_V1'/, "the frozen version is registered verbatim");
assert.doesNotMatch(migration, /signalOriginUtcHour"\s*:\s*12/, "the rejected 12:00 origin is not registered");

console.log("nzdusd_strategy deterministic tests passed");

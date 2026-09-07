import assert from "node:assert/strict";

import {
  GBPUSD_ATR_LENGTH, GBPUSD_EMA_FAST, GBPUSD_EMA_SLOW, GBPUSD_EXTREME_CLOSE_PCT,
  GBPUSD_MAX_HOLD_BARS, GBPUSD_PENETRATION_ATR, GBPUSD_REWARD_R, GBPUSD_STOP_ATR,
  GBPUSD_STRATEGY_CONFIG, evaluateGbpusdStrategy, evaluateGbpusdStrategyTrace, gbpusdOverlapDecision,
  resolveGbpusdExit,
} from "../src/lib/strategy/strategies/gbpusd-strategy";
import { PAIR_STRATEGY_REGISTRY } from "../src/lib/strategy/strategies";
import type { StrategyEvaluationInput } from "../src/lib/strategy/types";
import type { Candle } from "../src/types/forex";

const DAY = "2026-08-05";
type Origin = "1030" | "1100" | "1130";

function candle(time: string, open: number, high: number, low: number, close: number, complete = true): Candle {
  return { time, open, high, low, close, volume: 100, complete };
}

function baseUntil(origin: Origin, direction: "long" | "short") {
  const originTime = origin === "1030" ? "10:30" : origin === "1100" ? "11:00" : "11:30";
  const signalTime = `${DAY}T${originTime}:00.000Z`;
  const signalMs = Date.parse(signalTime);
  const sign = direction === "long" ? 1 : -1;
  return {
    signalTime,
    bars: Array.from({ length: 140 }, (_, index) => {
      const time = new Date(signalMs - (140 - index) * 30 * 60_000).toISOString();
      const open = 1.25 + sign * index * 0.00008;
      const close = open + sign * 0.00003;
      return candle(time, open, Math.max(open, close) + 0.00018, Math.min(open, close) - 0.00018, close);
    }),
  };
}

function rangeBefore(bars: Candle[], origin: Origin) {
  const end = origin === "1030" ? "10:00" : origin === "1100" ? "10:30" : "11:00";
  const range = bars.filter((bar) => bar.time >= `${DAY}T06:00:00.000Z` && bar.time <= `${DAY}T${end}:00.000Z`);
  return { high: Math.max(...range.map((bar) => bar.high)), low: Math.min(...range.map((bar) => bar.low)), count: range.length };
}

function fixture(origin: Origin, direction: "long" | "short", confidence: "BASE" | "PEN_EXTREME" = "PEN_EXTREME") {
  const { bars, signalTime } = baseUntil(origin, direction);
  const range = rangeBefore(bars, origin);
  const penetration = confidence === "PEN_EXTREME" ? 0.00040 : 0.00002;
  const signal = direction === "long"
    ? confidence === "PEN_EXTREME"
      ? candle(signalTime, range.high - 0.00010, range.high + penetration + 0.00002, range.high - 0.00025, range.high + penetration)
      : candle(signalTime, range.high - 0.00010, range.high + 0.00060, range.high - 0.00025, range.high + penetration)
    : confidence === "PEN_EXTREME"
      ? candle(signalTime, range.low + 0.00010, range.low + 0.00025, range.low - penetration - 0.00002, range.low - penetration)
      : candle(signalTime, range.low + 0.00010, range.low + 0.00025, range.low - 0.00060, range.low - penetration);
  return [...bars, signal];
}

function input(candles30m: Candle[], instrument = "GBP_USD"): StrategyEvaluationInput {
  const close = candles30m.filter((bar) => bar.complete).at(-1)?.close ?? 1.25;
  return {
    instrument,
    accountBalance: 10_000,
    accountCurrency: "USD",
    dataSource: "oanda",
    candles15m: [],
    candles30m,
    candles1h: [],
    candles4h: [],
    bid: close - 0.00005,
    ask: close + 0.00005,
    spreadPips: 1,
    marketOpen: true,
    calendarConnected: true,
    highImpactNewsWithinMinutes: null,
    evaluatedAt: new Date(Date.parse(candles30m.at(-1)!.time) + 30 * 60_000).toISOString(),
    evaluationMode: "historical_replay",
  };
}

function trace(bars: Candle[]) {
  const result = evaluateGbpusdStrategyTrace(bars);
  assert.equal(result.error, null);
  return result.rows;
}

function latest(bars: Candle[]) {
  return trace(bars).at(-1)!;
}

assert.deepEqual(
  { GBPUSD_EMA_FAST, GBPUSD_EMA_SLOW, GBPUSD_ATR_LENGTH, GBPUSD_STOP_ATR, GBPUSD_REWARD_R, GBPUSD_MAX_HOLD_BARS, GBPUSD_PENETRATION_ATR, GBPUSD_EXTREME_CLOSE_PCT },
  { GBPUSD_EMA_FAST: 20, GBPUSD_EMA_SLOW: 50, GBPUSD_ATR_LENGTH: 14, GBPUSD_STOP_ATR: 1, GBPUSD_REWARD_R: 2, GBPUSD_MAX_HOLD_BARS: 6, GBPUSD_PENETRATION_ATR: 0.25, GBPUSD_EXTREME_CLOSE_PCT: 0.25 },
);
assert.deepEqual(GBPUSD_STRATEGY_CONFIG.origins["1030"].directions, ["LONG", "SHORT"]);
assert.deepEqual(GBPUSD_STRATEGY_CONFIG.origins["1100"].directions, ["LONG", "SHORT"]);
assert.deepEqual(GBPUSD_STRATEGY_CONFIG.origins["1130"].directions, ["LONG"]);

// All five enabled legs signal; the sixth potential leg is explicitly disabled.
assert.equal(evaluateGbpusdStrategy(input(fixture("1030", "long"))).direction, "long");
assert.equal(evaluateGbpusdStrategy(input(fixture("1030", "short"))).direction, "short");
assert.equal(evaluateGbpusdStrategy(input(fixture("1100", "long"))).direction, "long");
assert.equal(evaluateGbpusdStrategy(input(fixture("1100", "short"))).direction, "short");
assert.equal(evaluateGbpusdStrategy(input(fixture("1130", "long"))).direction, "long");
{
  const result = evaluateGbpusdStrategy(input(fixture("1130", "short")));
  assert.equal(result.direction, null);
  assert.equal(result.features.gbpusdStrategy?.waitReason, "DISABLED_LEG");
  assert.equal(latest(fixture("1130", "short")).disabledShortSignal, true);
}

for (const [origin, direction] of [
  ["1030", "long"], ["1030", "short"], ["1100", "long"], ["1100", "short"], ["1130", "long"],
] as const) {
  const result = evaluateGbpusdStrategy(input(fixture(origin, direction)));
  const risk = Math.abs(result.entry! - result.stop!);
  assert.ok(Math.abs(risk - result.features.gbpusdStrategy!.entryATR!) < 1e-12, `${origin} ${direction} must freeze a 1 ATR stop`);
  assert.ok(Math.abs(Math.abs(result.target! - result.entry!) - 2 * risk) < 1e-12, `${origin} ${direction} must use a 2R target`);
}

// 3: a wick outside with a close inside is not a breakout.
{
  const bars = fixture("1030", "long");
  const row = latest(bars);
  const signal = bars.at(-1)!;
  bars[bars.length - 1] = candle(signal.time, row.preRangeHigh! - 0.0002, row.preRangeHigh! + 0.0004, signal.low, row.preRangeHigh! - 0.00001);
  const result = evaluateGbpusdStrategy(input(bars));
  assert.equal(result.direction, null);
  assert.equal(result.features.gbpusdStrategy?.waitReason, "NO_BREAKOUT");
}

// Exact causal range membership for each origin.
{
  const bars1030 = fixture("1030", "long");
  const row1030 = latest(bars1030);
  assert.equal(row1030.rangeBars, 9);
  assert.equal(row1030.preRangeHigh, Math.max(...bars1030.slice(0, -1).filter((bar) => bar.time >= `${DAY}T06:00:00.000Z`).map((bar) => bar.high)));
  assert.ok(row1030.preRangeHigh! < bars1030.at(-1)!.high, "10:30 origin must not enter its own range");

  const bars1100 = fixture("1100", "long");
  const row1100 = latest(bars1100);
  const at1030 = bars1100.find((bar) => bar.time === `${DAY}T10:30:00.000Z`)!;
  assert.equal(row1100.rangeBars, 10);
  assert.ok(row1100.preRangeHigh! >= at1030.high, "11:00 range must include 10:30");
  assert.ok(row1100.preRangeHigh! < bars1100.at(-1)!.high, "11:00 origin must not enter its own range");

  const bars1130 = fixture("1130", "long");
  const row1130 = latest(bars1130);
  const at1100 = bars1130.find((bar) => bar.time === `${DAY}T11:00:00.000Z`)!;
  assert.equal(row1130.rangeBars, 11);
  assert.ok(row1130.preRangeHigh! >= at1100.high, "11:30 range must include 11:00");
  assert.ok(row1130.preRangeHigh! < bars1130.at(-1)!.high, "11:30 origin must not enter its own range");
}

// 7: one missing required slot fails closed.
{
  const bars = fixture("1030", "long").filter((bar) => bar.time !== `${DAY}T08:30:00.000Z`);
  const result = evaluateGbpusdStrategy(input(bars));
  assert.equal(result.direction, null);
  assert.equal(result.features.gbpusdStrategy?.waitReason, "MISSING_RANGE_BAR");
}

// 8: EMA equality is WAIT.
{
  const signalMs = Date.parse(`${DAY}T10:30:00.000Z`);
  const bars = Array.from({ length: 141 }, (_, index) => candle(
    new Date(signalMs - (140 - index) * 30 * 60_000).toISOString(), 1.25, 1.2501, 1.2499, 1.25,
  ));
  assert.equal(evaluateGbpusdStrategy(input(bars)).features.gbpusdStrategy?.waitReason, "EMA_NEUTRAL");
}

// Same-direction 10:30 + 11:00 + 11:30 legs are independent and allowed.
assert.deepEqual(gbpusdOverlapDecision({
  originCode: "1100", direction: "long", hedgingEnabled: false,
  openLegs: [{ strategyId: "gbpusd_strategy", originCode: "1030", direction: "long" }],
}), { allowed: true, blockReason: null });
assert.deepEqual(gbpusdOverlapDecision({
  originCode: "1130", direction: "long", hedgingEnabled: false,
  openLegs: [
    { strategyId: "gbpusd_strategy", originCode: "1030", direction: "long" },
    { strategyId: "gbpusd_strategy", originCode: "1100", direction: "long" },
  ],
}), { allowed: true, blockReason: null });

// 10: each origin keeps its own ATR and geometry.
{
  const bars = fixture("1030", "long");
  const first = latest(bars);
  const pre1100 = rangeBefore(bars, "1100");
  bars.push(candle(`${DAY}T11:00:00.000Z`, pre1100.high - 0.0001, pre1100.high + 0.00122, pre1100.high - 0.001, pre1100.high + 0.0012));
  const rows = trace(bars);
  const original = rows.find((row) => row.timestamp === `${DAY}T10:30:00.000Z`)!;
  const second = rows.find((row) => row.timestamp === `${DAY}T11:00:00.000Z`)!;
  assert.equal(original.atr14, first.atr14);
  assert.notEqual(second.atr14, original.atr14);
  assert.ok(Math.abs(Math.abs(original.stop! - bars.at(-2)!.close) - original.atr14!) < 1e-12);
  assert.ok(Math.abs(Math.abs(second.stop! - bars.at(-1)!.close) - second.atr14!) < 1e-12);
}

const decisionTime = `${DAY}T11:00:00.000Z`;
const quote = (bar: number, values: Partial<{ bidHigh: number; bidLow: number; bidClose: number; askHigh: number; askLow: number; askClose: number }> = {}) => ({
  closeTime: new Date(Date.parse(decisionTime) + bar * 30 * 60_000).toISOString(),
  bidHigh: 1.2505, bidLow: 1.2495, bidClose: 1.2501,
  askHigh: 1.2506, askLow: 1.2496, askClose: 1.2502,
  ...values,
});

// 11-12: TP and SL close only the supplied leg.
assert.equal(resolveGbpusdExit({ direction: "long", entry: 1.25, stop: 1.249, target: 1.252, decisionTime, quotes: [quote(1, { bidHigh: 1.2521 })], now: new Date(`${DAY}T11:30:00.000Z`) })?.exitReason, "TP");
assert.equal(resolveGbpusdExit({ direction: "long", entry: 1.25, stop: 1.249, target: 1.252, decisionTime, quotes: [quote(1, { bidLow: 1.2489 })], now: new Date(`${DAY}T11:30:00.000Z`) })?.exitReason, "SL");

// 13: six complete future M30 bars are required for TIME_EXIT.
{
  const quotes = Array.from({ length: 6 }, (_, index) => quote(index + 1));
  assert.equal(resolveGbpusdExit({ direction: "long", entry: 1.25, stop: 1.249, target: 1.252, decisionTime, quotes, now: new Date(`${DAY}T13:59:59.000Z`) }), null);
  const result = resolveGbpusdExit({ direction: "long", entry: 1.25, stop: 1.249, target: 1.252, decisionTime, quotes, now: new Date(`${DAY}T14:00:00.000Z`) });
  assert.equal(result?.exitReason, "TIME_EXIT");
  assert.equal(result?.barsHeld, 6);
  assert.equal(resolveGbpusdExit({ direction: "long", entry: 1.25, stop: 1.249, target: 1.252, decisionTime, quotes: quotes.filter((_, index) => index !== 2), now: new Date(`${DAY}T14:00:00.000Z`) }), null);
}

// 14: PEN_EXTREME is metadata only; BASE still enters.
for (const confidence of ["BASE", "PEN_EXTREME"] as const) {
  const result = evaluateGbpusdStrategy(input(fixture("1030", "long", confidence)));
  assert.equal(result.direction, "long");
  assert.equal(result.features.gbpusdStrategy?.confidenceTag, confidence);
}

// 15: a non-hedging account blocks the opposite leg without touching the first.
const existingShort = [{ strategyId: "gbpusd_strategy", originCode: "1030", direction: "short" as const }];
assert.deepEqual(gbpusdOverlapDecision({ originCode: "1100", direction: "long", hedgingEnabled: false, openLegs: existingShort }), {
  allowed: false, blockReason: "BLOCKED_OPPOSITE_POSITION",
});
assert.deepEqual(gbpusdOverlapDecision({ originCode: "1100", direction: "long", hedgingEnabled: true, openLegs: existingShort }), {
  allowed: true, blockReason: null,
});

// Identity, registration, signal labels, and one-per-day origin key.
{
  const result = evaluateGbpusdStrategy(input(fixture("1030", "long")));
  assert.equal(result.family, "gbpusd_strategy");
  assert.equal(result.version, "v3");
  assert.equal(result.configVersion, "gbpusd-frequency-v3");
  assert.equal(result.timeframe, "30m");
  assert.equal(result.features.gbpusdStrategy?.signalLabel, "GBPUSD_1030_LONG");
  assert.equal(result.features.gbpusdStrategy?.signalKey, `GBPUSD-${DAY}-1030`);
  assert.equal(PAIR_STRATEGY_REGISTRY.GBP_USD.id, "gbpusd_strategy");
  assert.equal(PAIR_STRATEGY_REGISTRY.GBP_USD.name, "GBPUSD 30M Frequency V3");
  assert.equal(PAIR_STRATEGY_REGISTRY.GBP_USD.version, "v3");
  assert.equal(PAIR_STRATEGY_REGISTRY.GBP_USD.timeframe, "M30");
  assert.equal(PAIR_STRATEGY_REGISTRY.GBP_USD.executionEnabled, true);
  assert.equal(PAIR_STRATEGY_REGISTRY.GBP_USD.adaptiveParametersMutable, false);
}

console.log("gbpusd_strategy parity tests passed");

import assert from "node:assert/strict";

import {
  EURUSD_STRATEGY_CONFIG,
  evaluateEurusdStrategy,
  evaluateEurusdStrategyTrace,
  isEurusdStrategyEvent,
} from "../src/lib/strategy/strategies/eurusd-strategy";
import { PAIR_STRATEGY_REGISTRY } from "../src/lib/strategy/strategies";
import type { StrategyEvaluationInput } from "../src/lib/strategy/types";
import type { Candle } from "../src/types/forex";

const SIGNAL_DAY = "2026-08-05";

function candle(time: string, open: number, high: number, low: number, close: number, complete = true): Candle {
  return { time, open, high, low, close, volume: 100, complete };
}

function at(hour: number, day = SIGNAL_DAY) {
  return `${day}T${String(hour).padStart(2, "0")}:00:00.000Z`;
}

function trendHistory(direction: "up" | "down", signalHour = 6): Candle[] {
  const signalTime = Date.parse(at(signalHour));
  const count = 73;
  return Array.from({ length: count }, (_, index) => {
    const time = new Date(signalTime - (count - 1 - index) * 60 * 60_000).toISOString();
    const sign = direction === "up" ? 1 : -1;
    const base = direction === "up" ? 1.08 : 1.12;
    const open = base + sign * index * 0.00018;
    const close = open + sign * 0.00008;
    return candle(time, open, Math.max(open, close) + 0.00018, Math.min(open, close) - 0.00018, close);
  });
}

function asiaBars(direction: "long" | "short") {
  return Array.from({ length: 6 }, (_, hour) => {
    if (direction === "long") {
      const open = 1.1000 + hour * 0.00008;
      const close = open + 0.00004;
      return candle(at(hour), open, 1.10055 + hour * 0.00009, 1.09970 + hour * 0.00008, close);
    }
    const open = 1.1008 - hour * 0.00008;
    const close = open - 0.00004;
    return candle(at(hour), open, 1.10110 - hour * 0.00008, 1.10025 - hour * 0.00009, close);
  });
}

function signalFixture(direction: "long" | "short", signalHour = 6): Candle[] {
  const history = trendHistory(direction === "long" ? "up" : "down", signalHour)
    .filter((bar) => Date.parse(bar.time) < Date.parse(at(0)));
  const asia = asiaBars(direction);
  if (signalHour > 6) {
    for (let hour = 6; hour < signalHour; hour += 1) {
      history.push(direction === "long"
        ? candle(at(hour), 1.1008, 1.1014, 1.1005, 1.1012)
        : candle(at(hour), 1.1002, 1.1005, 1.0986, 1.0988));
    }
  }
  const previous = (signalHour === 6 ? asia : history).at(-1)!;
  const signal = direction === "long"
    ? candle(at(signalHour), 1.1007, Math.max(1.1024, previous.high + 0.0002), previous.low + 0.0001, 1.1020)
    : candle(at(signalHour), 1.1001, previous.high - 0.0001, Math.min(1.0976, previous.low - 0.0002), 1.0980);
  return [...history.filter((bar) => Date.parse(bar.time) < Date.parse(at(0))), ...asia, ...history.filter((bar) => Date.parse(bar.time) >= Date.parse(at(6))), signal]
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
}

function input(candles1h: Candle[], instrument = "EUR_USD"): StrategyEvaluationInput {
  return {
    instrument,
    accountBalance: 10_000,
    accountCurrency: "USD",
    dataSource: "oanda",
    candles15m: [],
    candles1h,
    candles4h: [],
    bid: null,
    ask: null,
    spreadPips: null,
    marketOpen: true,
    calendarConnected: true,
    highImpactNewsWithinMinutes: null,
    evaluatedAt: at(7),
    evaluationMode: "historical_replay",
  };
}

function traceOf(candles: Candle[]) {
  const result = evaluateEurusdStrategyTrace(candles);
  assert.equal(result.error, null);
  return result.rows;
}

function lastTrace(candles: Candle[]) {
  return traceOf(candles).at(-1)!;
}

function featureOf(candles: Candle[], options: Parameters<typeof evaluateEurusdStrategy>[1] = {}) {
  return evaluateEurusdStrategy(input(candles), options).features.eurusdStrategy!;
}

// 1. Reject non-EURUSD symbol.
assert.equal(evaluateEurusdStrategy(input(signalFixture("long"), "GBP_USD")).features.eurusdStrategy?.waitReason, "WRONG_SYMBOL");

// 2. Reject non-H1 timeframe.
assert.equal(evaluateEurusdStrategy(input(signalFixture("long")), { timeframe: "M15" }).features.eurusdStrategy?.waitReason, "WRONG_TIMEFRAME");

// 3-5. Asia high/low include only 00:00-05:59 UTC and freeze at 06:00.
{
  const bars = signalFixture("long");
  const rows = traceOf(bars);
  const atFive = rows.find((row) => row.timestamp === at(5))!;
  const atSix = rows.find((row) => row.timestamp === at(6))!;
  assert.equal(atFive.asiaHigh, Math.max(...asiaBars("long").map((bar) => bar.high)));
  assert.equal(atFive.asiaLow, Math.min(...asiaBars("long").map((bar) => bar.low)));
  assert.equal(atSix.asiaHigh, atFive.asiaHigh, "London high must not expand the Asia range");
  assert.equal(atSix.asiaLow, atFive.asiaLow, "London low must not expand the Asia range");
}

// 6 and 24. The UTC calendar day resets the range, independent of local time.
{
  const bars = [...signalFixture("long"), candle(at(0, "2026-08-06"), 1.2, 1.201, 1.199, 1.2)];
  const nextDay = lastTrace(bars);
  assert.equal(nextDay.asiaHigh, 1.201);
  assert.equal(nextDay.asiaLow, 1.199);
}

// 7. Exact qualifying LONG.
{
  const result = evaluateEurusdStrategy(input(signalFixture("long")));
  assert.equal(result.status, "valid");
  assert.equal(result.direction, "long");
  assert.equal(result.features.eurusdStrategy?.longSetup, true);
}

// 8. No long when the previous London close was already above the frozen Asia high.
{
  const bars = signalFixture("long", 7);
  assert.equal(lastTrace(bars).longSetup, false);
}

// 9. A long breakout is blocked when EMA20 <= EMA50.
{
  const bars = signalFixture("long");
  const downHistory = trendHistory("down").filter((bar) => Date.parse(bar.time) < Date.parse(at(0)));
  assert.equal(lastTrace([...downHistory, ...bars.filter((bar) => Date.parse(bar.time) >= Date.parse(at(0)))]).longSetup, false);
}

// 10. A long requires the literal higher-high and higher-low comparison.
{
  const bars = signalFixture("long");
  const prior = bars.at(-2)!;
  bars[bars.length - 1] = { ...bars.at(-1)!, low: prior.low - 0.0001 };
  assert.equal(lastTrace(bars).bullStructure, false);
  assert.equal(lastTrace(bars).longSetup, false);
}

// 11. Body below 0.35 ATR is blocked.
{
  const bars = signalFixture("long");
  const prior = bars.at(-2)!;
  const asiaHigh = Math.max(...asiaBars("long").map((bar) => bar.high));
  bars[bars.length - 1] = candle(at(6), asiaHigh + 0.00001, prior.high + 0.0002, prior.low + 0.00001, asiaHigh + 0.00002);
  const trace = lastTrace(bars);
  assert.ok(trace.atr14 !== null && trace.body < trace.atr14 * EURUSD_STRATEGY_CONFIG.minimumBodyAtr);
  assert.equal(trace.longSetup, false);
}

// 12. Exact qualifying SHORT mirror.
{
  const result = evaluateEurusdStrategy(input(signalFixture("short")));
  assert.equal(result.status, "valid");
  assert.equal(result.direction, "short");
  assert.equal(result.features.eurusdStrategy?.shortSetup, true);
}

// 13. No short when the previous London close was already below the frozen Asia low.
assert.equal(lastTrace(signalFixture("short", 7)).shortSetup, false);

// 14. No signal at or after 11:00 UTC.
assert.equal(evaluateEurusdStrategy(input(signalFixture("long", 11))).features.eurusdStrategy?.waitReason, "OUTSIDE_LONDON");

// 15. No signal when the current UTC day has no Asia observations.
{
  const bars = trendHistory("up").filter((bar) => Date.parse(bar.time) < Date.parse(at(0)));
  bars.push(candle(at(6), 1.1, 1.103, 1.099, 1.102));
  assert.equal(evaluateEurusdStrategy(input(bars)).features.eurusdStrategy?.waitReason, "ASIA_NOT_READY");
}

// 16-19. Stop/target are exactly 1 ATR / 2 ATR for long and short.
for (const direction of ["long", "short"] as const) {
  const result = evaluateEurusdStrategy(input(signalFixture(direction)));
  const atr = result.features.eurusdStrategy!.atr14!;
  const risk = Math.abs(result.entry! - result.stop!);
  const reward = Math.abs(result.target! - result.entry!);
  assert.ok(Math.abs(risk - atr) < 1e-12);
  assert.ok(Math.abs(reward - 2 * atr) < 1e-12);
  assert.ok(Math.abs(reward / risk - 2) < 1e-12);
}

// 20. A later candle cannot alter the ATR or geometry frozen on the signal row.
{
  const bars = signalFixture("long");
  const signal = lastTrace(bars);
  const future = candle(at(7), 1.102, 1.2, 1.0, 1.15);
  const preserved = traceOf([...bars, future]).find((row) => row.timestamp === signal.timestamp)!;
  assert.equal(preserved.atr14, signal.atr14);
  assert.equal(preserved.stop, signal.stop);
  assert.equal(preserved.target, signal.target);
}

// 21. evtA emits only after zero; consecutive non-zero sigA is suppressed.
assert.equal(isEurusdStrategyEvent(1, 0), true);
assert.equal(isEurusdStrategyEvent(1, 1), false);
assert.equal(isEurusdStrategyEvent(-1, 1), false);

// 22. The strategy cannot pyramid while its own EUR_USD position is active.
assert.equal(evaluateEurusdStrategy(input(signalFixture("long")), { hasActivePosition: true }).features.eurusdStrategy?.waitReason, "POSITION_ALREADY_OPEN");

// 23. Appending future history cannot change any already-computed trace row.
{
  const bars = signalFixture("long");
  const before = traceOf(bars);
  const after = traceOf([...bars, candle(at(7), 1.102, 1.5, 0.5, 1.4)]).slice(0, before.length);
  assert.deepEqual(after, before);
}

// 25. Invalid/NaN candle data fails closed.
{
  const bars = signalFixture("long");
  bars[10] = { ...bars[10]!, high: Number.NaN };
  const result = evaluateEurusdStrategy(input(bars));
  assert.equal(result.status, "invalid");
  assert.equal(result.features.eurusdStrategy?.waitReason, "MALFORMED_CANDLES");
}

// 26. Stable identity and complete decision metadata are present.
{
  const result = evaluateEurusdStrategy(input(signalFixture("long")));
  const feature = result.features.eurusdStrategy!;
  assert.equal(result.family, "eurusd_strategy");
  assert.equal(result.version, "v1");
  assert.equal(result.instrument, "EUR_USD");
  assert.equal(result.timeframe, "1h");
  assert.equal(feature.strategyId, "eurusd_strategy");
  assert.equal(feature.setup, "A_LONDON_BO");
  assert.equal(feature.timeframe, "H1");
  assert.ok(feature.asiaHigh !== null && feature.asiaLow !== null);
  assert.ok(feature.ema20 !== null && feature.ema50 !== null && feature.atr14 !== null);
  assert.ok(feature.signalKey?.startsWith("eurusd_strategy:EUR_USD:"));
}

// Completed bars are sorted; identical duplicate timestamps do not double-count.
{
  const bars = signalFixture("long");
  const shuffled = [bars.at(-1)!, ...bars.slice(0, -1).reverse(), { ...bars[5]! }];
  assert.deepEqual(lastTrace(shuffled), lastTrace(bars));
}

// Incomplete bars are ignored and cannot leak into indicators or range state.
{
  const bars = signalFixture("long");
  const baseline = lastTrace(bars);
  const forming = candle(at(7), 1, 9, 0.1, 8, false);
  assert.deepEqual(lastTrace([...bars, forming]), baseline);
}

// Registration is pair-specific, frozen, and explicitly dormant.
assert.equal(PAIR_STRATEGY_REGISTRY.EUR_USD.id, "eurusd_strategy");
assert.equal(PAIR_STRATEGY_REGISTRY.EUR_USD.timeframe, "H1");
assert.equal(PAIR_STRATEGY_REGISTRY.EUR_USD.executionEnabled, false);
assert.equal(PAIR_STRATEGY_REGISTRY.EUR_USD.adaptiveParametersMutable, false);

// Keep the helper referenced so a future refactor cannot silently drop metadata access.
assert.equal(featureOf(signalFixture("short")).signalDirection, "SHORT");

console.log("eurusd_strategy tests passed");

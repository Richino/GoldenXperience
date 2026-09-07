import assert from "node:assert/strict";

import {
  AUDUSD_ATR_LENGTH, AUDUSD_BODY_ATR_MIN, AUDUSD_EMA_FAST, AUDUSD_EMA_SLOW,
  AUDUSD_EXTREME_CLOSE_PCT, AUDUSD_MAX_HOLD_BARS, AUDUSD_MIN_VOTE_SUM,
  AUDUSD_PRE_RANGE_END_UTC, AUDUSD_PRE_RANGE_START_UTC, AUDUSD_REWARD_R,
  AUDUSD_SIGNAL_ORIGIN_UTC, AUDUSD_STOP_ATR_MULTIPLIER,
  audusdLongSignal, audusdTradeGeometry, evaluateAudusdStrategy, evaluateAudusdStrategyTrace,
  evaluateAudusdVotes, resolveAudusdExit,
} from "../src/lib/strategy/strategies/audusd-strategy";
import { ENABLED_PAIR_STRATEGY_IDS, PAIR_STRATEGY_REGISTRY } from "../src/lib/strategy/strategies";
import type { StrategyEvaluationInput } from "../src/lib/strategy/types";
import type { Candle } from "../src/types/forex";

const SIGNAL_START = "2026-08-05T11:00:00.000Z";
const SIGNAL_CLOSE = "2026-08-05T12:00:00.000Z";

function candle(time: string, open: number, high: number, low: number, close: number, complete = true): Candle {
  return { time, open, high, low, close, volume: 100, complete };
}

function fixture(tag: "base" | "body_extreme" = "body_extreme") {
  const signalMs = Date.parse(SIGNAL_START);
  const bars = Array.from({ length: 120 }, (_, index) => {
    const time = new Date(signalMs - (120 - index) * 60 * 60_000).toISOString();
    const close = 0.98 + index * 0.0002;
    return candle(time, close - 0.00005, close + 0.0002, close - 0.0002, close);
  });
  const prior = bars.at(-1)!;
  const low = prior.low + 0.00005;
  if (tag === "base") {
    bars.push(candle(SIGNAL_START, prior.close + 0.00005, prior.high + 0.001, low, prior.close + 0.00015));
  } else {
    const high = prior.high + 0.0012;
    bars.push(candle(SIGNAL_START, prior.close + 0.00005, high, low, high - 0.00005));
  }
  return bars;
}

function input(candles1h: Candle[], instrument = "AUD_USD"): StrategyEvaluationInput {
  const lastComplete = candles1h.filter((bar) => bar.complete).at(-1);
  const close = lastComplete?.close ?? 1;
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
    evaluatedAt: SIGNAL_CLOSE,
    evaluationMode: "historical_replay",
  };
}

// Frozen identity and thresholds.
assert.deepEqual({
  AUDUSD_EMA_FAST, AUDUSD_EMA_SLOW, AUDUSD_ATR_LENGTH,
  AUDUSD_PRE_RANGE_START_UTC, AUDUSD_PRE_RANGE_END_UTC, AUDUSD_SIGNAL_ORIGIN_UTC,
  AUDUSD_MIN_VOTE_SUM, AUDUSD_BODY_ATR_MIN, AUDUSD_EXTREME_CLOSE_PCT,
  AUDUSD_STOP_ATR_MULTIPLIER, AUDUSD_REWARD_R, AUDUSD_MAX_HOLD_BARS,
}, {
  AUDUSD_EMA_FAST: 20, AUDUSD_EMA_SLOW: 50, AUDUSD_ATR_LENGTH: 14,
  AUDUSD_PRE_RANGE_START_UTC: 6, AUDUSD_PRE_RANGE_END_UTC: 10, AUDUSD_SIGNAL_ORIGIN_UTC: 11,
  AUDUSD_MIN_VOTE_SUM: 4, AUDUSD_BODY_ATR_MIN: 0.5, AUDUSD_EXTREME_CLOSE_PCT: 0.25,
  AUDUSD_STOP_ATR_MULTIPLIER: 1, AUDUSD_REWARD_R: 2, AUDUSD_MAX_HOLD_BARS: 3,
});

// Tests 1-7: each exact vote and bullish structure.
const allBullish = evaluateAudusdVotes({
  ema20: 2, ema50: 1, close: 3, ema20At0800: 1.5, preRangeMid: 2.5,
  signalHigh: 4, signalLow: 2, priorHigh: 3.5, priorLow: 1.5, close0800: 2.75,
});
assert.equal(allBullish.emaVote, 1);
assert.equal(evaluateAudusdVotes({ ...allBullishInput(), ema20: 1, ema50: 2 }).emaVote, -1);
assert.equal(allBullish.priceEmaVote, 1);
assert.equal(allBullish.emaSlopeVote, 1);
assert.equal(allBullish.rangeVote, 1);
assert.equal(allBullish.structureVote, 1);
assert.equal(allBullish.bullStructure, true);
assert.equal(allBullish.momentumVote, 1);

function allBullishInput() {
  return {
    ema20: 2, ema50: 1, close: 3, ema20At0800: 1.5, preRangeMid: 2.5,
    signalHigh: 4, signalLow: 2, priorHigh: 3.5, priorLow: 1.5, close0800: 2.75,
  };
}

// Tests 8-12: threshold, long-only behavior, and mandatory structure.
const sum3 = evaluateAudusdVotes({
  ema20: 2, ema50: 1, close: 3, ema20At0800: 1.5, preRangeMid: 3,
  signalHigh: 4, signalLow: 1, priorHigh: 4, priorLow: 1, close0800: 3,
});
assert.equal(sum3.voteSum, 3);
assert.equal(audusdLongSignal(sum3), false);
const sum4 = evaluateAudusdVotes({ ...allBullishInput(), close: 2.5, close0800: 2.5 });
assert.equal(sum4.voteSum, 4);
assert.equal(sum4.bullStructure, true);
assert.equal(audusdLongSignal(sum4), true);
assert.equal(allBullish.voteSum, 6);
assert.equal(audusdLongSignal(allBullish), true);
const allBearish = evaluateAudusdVotes({
  ema20: 1, ema50: 2, close: 0, ema20At0800: 1.5, preRangeMid: 0.5,
  signalHigh: 1, signalLow: -1, priorHigh: 2, priorLow: 0, close0800: 0.5,
});
assert.equal(allBearish.voteSum, -6);
assert.equal(audusdLongSignal(allBearish), false, "bearish consensus cannot create a short");
const sum5NoStructure = evaluateAudusdVotes({
  ...allBullishInput(), signalHigh: 3.5, signalLow: 1.5,
});
assert.equal(sum5NoStructure.voteSum, 5);
assert.equal(sum5NoStructure.bullStructure, false);
assert.equal(audusdLongSignal(sum5NoStructure), false);
const hlOnly = evaluateAudusdVotes({
  ...allBullishInput(), signalHigh: 3.5, signalLow: 2,
});
assert.equal(hlOnly.voteSum, 5, "HL-only test must otherwise satisfy the +4 consensus threshold");
assert.equal(hlOnly.bullStructure, false, "a higher low without a higher high is not V1 structure");
assert.equal(audusdLongSignal(hlOnly), false, "rejected V2 HL-only structure must never enter the active V1 strategy");

// Tests 13-16: exact missing-bar and completed-origin fail-closed behavior.
{
  const missing0800 = fixture().filter((bar) => bar.time !== "2026-08-05T08:00:00.000Z");
  assert.equal(evaluateAudusdStrategy(input(missing0800)).features.audusdStrategy?.waitReason, "MISSING_0800_CANDLE");
  const missing0700 = fixture().filter((bar) => bar.time !== "2026-08-05T07:00:00.000Z");
  assert.equal(evaluateAudusdStrategy(input(missing0700)).features.audusdStrategy?.waitReason, "MISSING_0700_CANDLE");
  const forming = fixture();
  forming[forming.length - 1] = { ...forming.at(-1)!, complete: false };
  assert.equal(evaluateAudusdStrategy(input(forming)).features.audusdStrategy?.waitReason, "ORIGIN_NOT_COMPLETE");
  assert.equal(evaluateAudusdStrategy(input(fixture())).status, "valid");
}

// Test 17: future ATR changes cannot mutate the frozen signal trace.
{
  const bars = fixture();
  const before = evaluateAudusdStrategyTrace(bars).rows.at(-1)!;
  const after = evaluateAudusdStrategyTrace([
    ...bars,
    candle("2026-08-05T12:00:00.000Z", 1, 2, 0.5, 1.5),
  ]).rows.find((row) => row.timestamp === SIGNAL_START)!;
  assert.equal(after.atr14, before.atr14);
  assert.equal(after.stop, before.stop);
  assert.equal(after.target, before.target);
}

// Test 18: exact frozen geometry.
assert.deepEqual(audusdTradeGeometry(1, 0.002), { stopLoss: 0.998, takeProfit: 1.004 });

const neutralQuotes = [1, 2, 3].map((hour) => ({
  closeTime: new Date(Date.parse(SIGNAL_CLOSE) + hour * 60 * 60_000).toISOString(),
  bidHigh: 1.001, bidLow: 0.999, bidClose: 1.0005,
}));

// Tests 19-21: TP, SL, and exactly three future completed H1 bars.
assert.equal(resolveAudusdExit({
  entry: 1, stop: 0.998, target: 1.004, decisionTime: SIGNAL_CLOSE, now: new Date("2026-08-05T13:00:00.000Z"),
  quotes: [{ closeTime: "2026-08-05T13:00:00.000Z", bidHigh: 1.0041, bidLow: 0.999, bidClose: 1.004 }],
})?.exitReason, "TP");
assert.equal(resolveAudusdExit({
  entry: 1, stop: 0.998, target: 1.004, decisionTime: SIGNAL_CLOSE, now: new Date("2026-08-05T13:00:00.000Z"),
  quotes: [{ closeTime: "2026-08-05T13:00:00.000Z", bidHigh: 1.001, bidLow: 0.9979, bidClose: 0.998 }],
})?.exitReason, "SL");
assert.equal(resolveAudusdExit({
  entry: 1, stop: 0.998, target: 1.004, decisionTime: SIGNAL_CLOSE,
  now: new Date("2026-08-05T14:59:59.000Z"), quotes: neutralQuotes,
}), null);
const timeExit = resolveAudusdExit({
  entry: 1, stop: 0.998, target: 1.004, decisionTime: SIGNAL_CLOSE,
  now: new Date("2026-08-05T15:00:00.000Z"), quotes: neutralQuotes,
});
assert.equal(timeExit?.exitReason, "TIME_EXIT");
assert.equal(timeExit?.barsHeld, 3);
assert.equal(timeExit?.horizonEndsAt, "2026-08-05T15:00:00.000Z");

// Same-bar historical ambiguity is conservatively a stop.
assert.equal(resolveAudusdExit({
  entry: 1, stop: 0.998, target: 1.004, decisionTime: SIGNAL_CLOSE, now: new Date("2026-08-05T13:00:00.000Z"),
  quotes: [{ closeTime: "2026-08-05T13:00:00.000Z", bidHigh: 1.005, bidLow: 0.997, bidClose: 1 }],
})?.exitReason, "SL");

// Tests 22-23: BODY+EXTREME changes metadata only, never baseline admission.
const base = evaluateAudusdStrategy(input(fixture("base")));
assert.equal(base.status, "valid");
assert.equal(base.direction, "long");
assert.equal(base.features.audusdStrategy?.bodyConfirm, false);
assert.equal(base.features.audusdStrategy?.extremeClose, false);
assert.equal(base.features.audusdStrategy?.confidenceTag, "AUDUSD_BASE");
const tagged = evaluateAudusdStrategy(input(fixture("body_extreme")));
assert.equal(tagged.status, "valid");
assert.equal(tagged.features.audusdStrategy?.bodyConfirm, true);
assert.equal(tagged.features.audusdStrategy?.extremeClose, true);
assert.equal(tagged.features.audusdStrategy?.confidenceTag, "AUDUSD_BODY_EXTREME");

// Test 24: deterministic duplicate state suppresses a second trade.
const duplicate = evaluateAudusdStrategy(input(fixture()), { duplicateSignal: true });
assert.equal(duplicate.status, "no_setup");
assert.equal(duplicate.direction, null);
assert.equal(duplicate.features.audusdStrategy?.waitReason, "DUPLICATE_SIGNAL");

// Test 25: restart-safe metadata preserves frozen state and the real 3-bar close.
const durable = JSON.parse(JSON.stringify(tagged.features.audusdStrategy)) as NonNullable<typeof tagged.features.audusdStrategy>;
assert.equal(durable.strategyId, "audusd_strategy");
assert.equal(durable.strategyVersion, "AUDUSD_STRONG_CONS_STRUCTURE_V1");
assert.equal(durable.signalKey, "AUDUSD-2026-08-05-1100");
assert.equal(durable.entryATR, tagged.features.audusdStrategy?.entryATR);
assert.equal(durable.stopLoss, tagged.stop);
assert.equal(durable.takeProfit, tagged.target);
assert.equal(durable.expirationTimeUtc, "2026-08-05T15:00:00.000Z");

// Pair registration is enabled, isolated, and outside adaptive tuning.
assert.equal(PAIR_STRATEGY_REGISTRY.AUD_USD.id, "audusd_strategy");
assert.equal(PAIR_STRATEGY_REGISTRY.AUD_USD.timeframe, "H1");
assert.equal(PAIR_STRATEGY_REGISTRY.AUD_USD.executionEnabled, true);
assert.equal(PAIR_STRATEGY_REGISTRY.AUD_USD.adaptiveParametersMutable, false);
assert.ok(ENABLED_PAIR_STRATEGY_IDS.includes("audusd_strategy"));
assert.equal(evaluateAudusdStrategy(input(fixture(), "USD_JPY")).features.audusdStrategy?.waitReason, "WRONG_SYMBOL");
assert.equal(evaluateAudusdStrategy(input(fixture()), { timeframe: "M15" }).features.audusdStrategy?.waitReason, "WRONG_TIMEFRAME");

console.log("audusd_strategy deterministic tests passed");

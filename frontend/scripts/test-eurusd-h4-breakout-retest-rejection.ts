import assert from "node:assert/strict";

import type { ResearchCandle } from "../src/lib/oanda/client";
import type { Candle } from "../src/types/forex";

import {
  BAR_MS,
  CONFIG,
  evaluateTrace,
  freezeCohort,
  resolveTrade,
  signalsFromTrace,
  validLongRetest,
  type FrozenSignal,
} from "./eurusd-h4-breakout-retest-rejection";

function candle(time: string, open: number, high: number, low: number, close: number): Candle {
  return { time, open, high, low, close, volume: 100, complete: true };
}

function mba(bar: Candle, spread = 0.00012): ResearchCandle {
  const half = spread / 2;
  const side = (delta: number) => ({
    open: bar.open + delta, high: bar.high + delta, low: bar.low + delta, close: bar.close + delta,
  });
  return {
    time: bar.time, volume: bar.volume, complete: bar.complete,
    mid: { open: bar.open, high: bar.high, low: bar.low, close: bar.close },
    bid: side(-half), ask: side(half),
  };
}

function risingDaily(count: number, start = "2023-01-02T21:00:00.000Z"): Candle[] {
  const origin = Date.parse(start);
  return Array.from({ length: count }, (_, index) => {
    const time = new Date(origin + index * 24 * 60 * 60_000).toISOString();
    const open = 1.0500 + index * 0.0010;
    const close = open + 0.0007;
    return candle(time, open, close + 0.0004, open - 0.0002, close);
  });
}

function grind(count: number, lastOpen: string, startPrice: number, drift: number, cap: number): Candle[] {
  const last = Date.parse(lastOpen);
  return Array.from({ length: count }, (_, index) => {
    const time = new Date(last - (count - 1 - index) * BAR_MS).toISOString();
    const open = Math.min(cap - 0.0008, startPrice + index * drift);
    const close = Math.min(cap - 0.0004, open + Math.abs(drift) * 0.5);
    return candle(time, open, Math.max(open, close) + 0.00008, Math.min(open, close) - 0.00008, close);
  });
}

function overlay(base: ResearchCandle, mid: ResearchCandle["mid"]): ResearchCandle {
  return { ...base, mid, bid: mid, ask: mid };
}

function longFixture() {
  const daily = risingDaily(81);
  const lastDaily = daily.at(-2)!;
  const level = lastDaily.high;
  const breakoutOpen = "2023-03-24T09:00:00.000Z";
  const history = grind(80, new Date(Date.parse(breakoutOpen) - BAR_MS).toISOString(), 1.0700, 0.00028, level);
  const prior = history.at(-1)!;
  assert.ok(prior.close <= level, "history must stay at or below the frozen D1 high");
  const breakout = candle(breakoutOpen, level - 0.0002, level + 0.00035, level - 0.00035, level + 0.00025);
  const wait = candle(new Date(Date.parse(breakoutOpen) + BAR_MS).toISOString(), breakout.close, breakout.close + 0.0002, level + 0.00005, breakout.close + 0.0001);
  const retestTime = new Date(Date.parse(breakoutOpen) + 2 * BAR_MS).toISOString();
  const retest = candle(retestTime, level + 0.00005, level + 0.00120, level - 0.00015, level + 0.00100);
  assert.ok(retest.low <= level && retest.close > level && retest.close > retest.open);
  return { daily: daily.map((bar) => mba(bar)), h4: [...history, breakout, wait, retest].map((bar) => mba(bar)), breakoutOpen, retestTime, level };
}

function quietFollowThrough(signal: FrozenSignal, start: string): ResearchCandle[] {
  return Array.from({ length: CONFIG.maxHoldBars }, (_, index) => {
    const time = new Date(Date.parse(start) + (index + 1) * BAR_MS).toISOString();
    const mid = {
      open: signal.midEntry,
      high: signal.midEntry + (signal.midTarget - signal.midEntry) * 0.2,
      low: signal.midEntry - (signal.midEntry - signal.midStop) * 0.2,
      close: signal.midEntry,
    };
    return { time, volume: 10, complete: true, mid, bid: mid, ask: mid };
  });
}

assert.equal(validLongRetest(candle("t", 1, 1.0012, 0.9998, 1.0010), 1, 0.0020), true);
assert.equal(validLongRetest(candle("t", 1.0001, 1.0004, 0.9998, 1.0003), 1, 0.0020), false, "weak body must reject");
assert.equal(validLongRetest(candle("t", 1.00005, 1.0025, 0.9998, 1.00080), 1, 0.0020), false, "close not in top 30% must reject");
assert.equal(validLongRetest(candle("t", 1.0000, 1.0012, 0.9998, 1.00005), 1, 0.0020), false, "close must reclaim 0.10 ATR above the frozen level");

const longSetup = longFixture();
const longTrace = evaluateTrace(longSetup.h4, longSetup.daily);
assert.equal(longTrace.error, null, longTrace.error ?? undefined);
const breakoutRow = longTrace.rows.find((row) => row.timestamp === longSetup.breakoutOpen);
assert.equal(breakoutRow?.longBreakout, true);
assert.equal(breakoutRow?.longRetest, false, "direct breakout is not an entry");
const longSignals = signalsFromTrace(longSetup.h4, longTrace.rows);
const longSignal = longSignals.at(-1)!;
assert.equal(longSignal.direction, "long");
assert.equal(longSignal.signalTimestamp, longSetup.retestTime);
assert.equal(longSignal.retestOffset, 2);
assert.ok(Math.abs(longSignal.frozenLevel - longSetup.level) < 1e-9);

const weak = mba(candle(longSetup.retestTime, longSetup.level + 0.00005, longSetup.level + 0.00020, longSetup.level - 0.00010, longSetup.level + 0.00012));
const weakTrace = evaluateTrace([...longSetup.h4.slice(0, -1), weak], longSetup.daily);
assert.equal(weakTrace.rows.at(-1)!.longRetest, false, "weak rejection candle must not enter");

const fillers = [1, 2, 3].map((offset) => mba(candle(
  new Date(Date.parse(longSetup.breakoutOpen) + offset * BAR_MS).toISOString(),
  longSetup.level + 0.0004,
  longSetup.level + 0.0006,
  longSetup.level + 0.00005,
  longSetup.level + 0.0005,
)));
const lateRetest = mba(candle(
  new Date(Date.parse(longSetup.breakoutOpen) + 4 * BAR_MS).toISOString(),
  longSetup.level + 0.00005,
  longSetup.level + 0.00120,
  longSetup.level - 0.00015,
  longSetup.level + 0.00100,
));
const expired = evaluateTrace([...longSetup.h4.filter((bar) => Date.parse(bar.time) <= Date.parse(longSetup.breakoutOpen)), ...fillers, lateRetest], longSetup.daily);
assert.equal(expired.rows.at(-1)!.longRetest, false, "retest after 3 bars must expire");

const after = quietFollowThrough(longSignal, longSetup.retestTime);
const timed = resolveTrade(longSignal, [...longSetup.h4, ...after], "midpoint");
assert.equal(timed?.exitReason, "TIME_EXIT");

const tp = overlay(after[0]!, { open: longSignal.midEntry, high: longSignal.midTarget + 0.0002, low: longSignal.midEntry - 0.00005, close: longSignal.midTarget });
assert.equal(resolveTrade(longSignal, [...longSetup.h4, tp, ...after.slice(1)], "midpoint")?.exitReason, "TP");
const both = overlay(after[0]!, { open: longSignal.midEntry, high: longSignal.midTarget + 0.0002, low: longSignal.midStop - 0.0002, close: longSignal.midEntry });
const stopFirst = resolveTrade(longSignal, [...longSetup.h4, both, ...after.slice(1)], "midpoint");
assert.equal(stopFirst?.exitReason, "SL");
assert.equal(stopFirst?.ambiguousSameBar, true);
const gap = overlay(after[0]!, { open: longSignal.midStop - 0.0008, high: longSignal.midStop - 0.0001, low: longSignal.midStop - 0.001, close: longSignal.midStop - 0.0004 });
assert.ok((resolveTrade(longSignal, [...longSetup.h4, gap, ...after.slice(1)], "midpoint")?.resultR ?? 0) < -1);

const second = { ...longSignal, signalTimestamp: after[0]!.time, decisionTime: new Date(Date.parse(after[0]!.time) + BAR_MS).toISOString() };
const pyramid = freezeCohort([longSignal, second], [...longSetup.h4, ...after]);
assert.equal(pyramid.accepted.length, 1);
assert.equal(pyramid.skipped.length, 1);

console.log("eurusd_h4_breakout_retest_rejection_v1 frozen-rule tests passed.");

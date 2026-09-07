import assert from "node:assert/strict";

import { calculateAtrValues, calculateEmaValues } from "../src/lib/strategy/indicators";
import type { ResearchCandle } from "../src/lib/oanda/client";
import type { Candle } from "../src/types/forex";

import {
  BAR_MS,
  CONFIG,
  evaluateTrace,
  freezeCohort,
  resolveTrade,
  signalsFromTrace,
  type FrozenSignal,
} from "./eurusd-h4-bull-trend-breakout";

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
    const open = 1.0500 + index * 0.0012;
    const close = open + 0.0009;
    return candle(time, open, close + 0.0002, open - 0.0002, close);
  });
}

function risingH4(count: number, lastOpen: string, startPrice = 1.0800, drift = 0.00035): Candle[] {
  const last = Date.parse(lastOpen);
  return Array.from({ length: count }, (_, index) => {
    const time = new Date(last - (count - 1 - index) * BAR_MS).toISOString();
    const open = startPrice + index * drift;
    const close = open + drift * 0.55;
    return candle(time, open, close + 0.00008, open - 0.00008, close);
  });
}

function longFixture() {
  const daily = risingDaily(80);
  const signalOpen = "2023-03-24T13:00:00.000Z";
  const history = risingH4(80, new Date(Date.parse(signalOpen) - BAR_MS).toISOString());
  const ema20 = calculateEmaValues(history.map((bar) => bar.close), CONFIG.emaFastPeriod);
  const ema50 = calculateEmaValues(history.map((bar) => bar.close), CONFIG.emaSlowPeriod);
  assert.ok(ema20.at(-1)! > ema50.at(-1)!, "fixture needs local uptrend");
  assert.ok(ema20.at(-1)! > ema20.at(-1 - CONFIG.emaSlopeBars)!, "fixture needs rising EMA20");
  const rangeHigh = Math.max(...history.slice(-CONFIG.rangeBars).map((bar) => bar.high));
  const atr = calculateAtrValues(history, CONFIG.atrPeriod).at(-1)!;
  const prior = history.at(-1)!;
  const body = 0.35 * atr + 0.00005;
  const close = Math.max(rangeHigh + 0.00025, prior.low + 0.0002 + body);
  const open = close - body;
  const reclaim = candle(
    signalOpen,
    open,
    Math.max(prior.high + 0.00015, close + 0.00005),
    Math.min(open, close) - 0.00002,
    close,
  );
  assert.ok(reclaim.low > prior.low, "structure needs a higher low");
  assert.ok(reclaim.close > rangeHigh, "breakout close must clear the prior 12-bar high");
  assert.ok(prior.close <= rangeHigh, "previous close must not already be through that high");
  return { daily: daily.map((bar) => mba(bar)), h4: [...history, reclaim].map((bar) => mba(bar)), signalOpen, rangeHigh };
}

function quietBars(signal: FrozenSignal, start: string, count: number, spread = 0): ResearchCandle[] {
  return Array.from({ length: count }, (_, index) => {
    const time = new Date(Date.parse(start) + (index + 1) * BAR_MS).toISOString();
    const mid = {
      open: signal.midEntry,
      high: signal.midEntry + (signal.midTarget - signal.midEntry) * 0.2,
      low: signal.midEntry - (signal.midEntry - signal.midStop) * 0.2,
      close: signal.midEntry,
    };
    const side = (delta: number) => ({ open: mid.open + delta, high: mid.high + delta, low: mid.low + delta, close: mid.close + delta });
    return { time, volume: 10, complete: true, mid, bid: side(-spread / 2), ask: side(spread / 2) };
  });
}

const fixture = longFixture();
const traced = evaluateTrace(fixture.h4, fixture.daily);
assert.equal(traced.error, null, traced.error ?? undefined);
const last = traced.rows.at(-1)!;
assert.equal(last.longSetup, true, "last bar must be a frozen long breakout");
assert.equal(last.rangeHigh, fixture.rangeHigh);
const signals = signalsFromTrace(fixture.h4, traced.rows);
const lastSignal = signals.at(-1)!;
assert.equal(lastSignal.direction, "long");
assert.equal(lastSignal.signalTimestamp, fixture.signalOpen);
assert.equal(lastSignal.midEntry, fixture.h4.at(-1)!.mid.close);
assert.ok(Math.abs((lastSignal.midTarget - lastSignal.midEntry) / (lastSignal.midEntry - lastSignal.midStop) - 2) < 1e-9);

const blocked = structuredClone(fixture);
const lastBar = blocked.h4.at(-1)!;
lastBar.mid = { ...lastBar.mid, open: lastBar.mid.close - 0.00002, high: lastBar.mid.close + 0.00003, low: lastBar.mid.low };
lastBar.bid = { ...lastBar.mid, open: lastBar.mid.open - 0.00006, high: lastBar.mid.high - 0.00006, low: lastBar.mid.low - 0.00006, close: lastBar.mid.close - 0.00006 };
lastBar.ask = { ...lastBar.mid, open: lastBar.mid.open + 0.00006, high: lastBar.mid.high + 0.00006, low: lastBar.mid.low + 0.00006, close: lastBar.mid.close + 0.00006 };
assert.equal(evaluateTrace(blocked.h4, blocked.daily).rows.at(-1)!.longSetup, false, "body below 0.35 ATR must not fire");

const noCurrentHigh = structuredClone(fixture);
const current = noCurrentHigh.h4.at(-1)!;
const below = fixture.rangeHigh - 0.0002;
current.mid = { open: below - 0.0001, high: fixture.rangeHigh + 0.05, low: below - 0.0003, close: below };
current.bid = current.mid;
current.ask = current.mid;
const noBreak = evaluateTrace(noCurrentHigh.h4, noCurrentHigh.daily);
assert.equal(noBreak.error, null, noBreak.error ?? undefined);
assert.equal(noBreak.rows.at(-1)!.breakout, false, "current high is excluded from the 12-bar range");

const after = quietBars(lastSignal, fixture.signalOpen, CONFIG.maxHoldBars);
const timed = resolveTrade(lastSignal, [...fixture.h4, ...after], "midpoint");
assert.equal(timed?.exitReason, "TIME_EXIT");
assert.equal(timed?.holdBars, 30);

function overlay(base: ResearchCandle, mid: ResearchCandle["mid"]): ResearchCandle {
  return { ...base, mid, bid: mid, ask: mid };
}
const tpBar = overlay(after[0]!, { open: lastSignal.midEntry, high: lastSignal.midTarget + 0.0002, low: lastSignal.midEntry - 0.00005, close: lastSignal.midTarget });
const tp = resolveTrade(lastSignal, [...fixture.h4, tpBar, ...after.slice(1)], "midpoint");
assert.equal(tp?.exitReason, "TP");
assert.ok(Math.abs((tp?.resultR ?? 0) - 2) < 1e-9);

const slBar = overlay(after[0]!, { open: lastSignal.midEntry, high: lastSignal.midEntry + 0.00005, low: lastSignal.midStop - 0.0002, close: lastSignal.midStop });
const sl = resolveTrade(lastSignal, [...fixture.h4, slBar, ...after.slice(1)], "midpoint");
assert.equal(sl?.exitReason, "SL");
assert.ok((sl?.resultR ?? 0) <= -1);

const both = overlay(after[0]!, { open: lastSignal.midEntry, high: lastSignal.midTarget + 0.0002, low: lastSignal.midStop - 0.0002, close: lastSignal.midEntry });
const stopFirst = resolveTrade(lastSignal, [...fixture.h4, both, ...after.slice(1)], "midpoint");
assert.equal(stopFirst?.exitReason, "SL");
assert.equal(stopFirst?.ambiguousSameBar, true);

const gap = overlay(after[0]!, { open: lastSignal.midStop - 0.0008, high: lastSignal.midStop - 0.0001, low: lastSignal.midStop - 0.001, close: lastSignal.midStop - 0.0004 });
const gapped = resolveTrade(lastSignal, [...fixture.h4, gap, ...after.slice(1)], "midpoint");
assert.equal(gapped?.exitReason, "SL");
assert.ok((gapped?.resultR ?? 0) < -1);

const held = freezeCohort(signals.slice(-1), [...fixture.h4, ...after]);
assert.equal(held.accepted.length, 1);
const resolvedFirst = resolveTrade(lastSignal, [...fixture.h4, ...after], "midpoint");
assert.ok(resolvedFirst, "first trade must resolve");
const second = {
  ...lastSignal,
  signalTimestamp: after[0]!.time,
  decisionTime: new Date(Date.parse(after[0]!.time) + BAR_MS).toISOString(),
};
const pyramid = freezeCohort([lastSignal, second], [...fixture.h4, ...after]);
assert.equal(pyramid.accepted.length, 1, "no pyramiding while a trade is open");
assert.equal(pyramid.skipped.length, 1);

assert.equal(signals.every((signal) => signal.direction === "long"), true);
console.log("eurusd_h4_bull_trend_breakout_v1 frozen-rule tests passed.");

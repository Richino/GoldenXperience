import assert from "node:assert/strict";

import type { ResearchCandle } from "../src/lib/oanda/client";
import type { Candle } from "../src/types/forex";

import {
  BAR_MS,
  CONFIG,
  HTF_BAR_MS,
  computePoc,
  evaluateTrace,
  freezeCohort,
  previousCompletedHtfIndex,
  resolveTrade,
  signalsFromTrace,
} from "./usdjpy-poc-swing-long";

function candle(time: string, open: number, high: number, low: number, close: number, volume = 100): Candle {
  return { time, open, high, low, close, volume, complete: true };
}

function mba(bar: Candle, spread = 0.02): ResearchCandle {
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

{
  const bars = [
    candle("2023-01-01T00:00:00.000Z", 100, 106, 105, 105.5, 10),
    candle("2023-01-01T01:00:00.000Z", 105, 106.5, 105.2, 105.7, 400),
    candle("2023-01-01T02:00:00.000Z", 110, 111, 109, 110, 10),
  ];
  const poc = computePoc(bars, 100, 124, 24);
  assert.equal(poc, 105.5, "POC is the center of the highest-volume HLC3 bin");
}

{
  const times = [
    Date.parse("2023-03-24T05:00:00.000Z"),
    Date.parse("2023-03-24T09:00:00.000Z"),
    Date.parse("2023-03-24T13:00:00.000Z"),
  ];
  assert.equal(previousCompletedHtfIndex(times, Date.parse("2023-03-24T10:00:00.000Z")), 0);
  assert.equal(previousCompletedHtfIndex(times, Date.parse("2023-03-24T13:00:00.000Z")), 1);
}

function risingH4(count: number, lastOpen = "2023-03-24T13:00:00.000Z"): Candle[] {
  const last = Date.parse(lastOpen);
  return Array.from({ length: count }, (_, index) => {
    const time = new Date(last - (count - 1 - index) * HTF_BAR_MS).toISOString();
    const open = 130 + index * 0.08;
    const close = open + 0.05;
    return candle(time, open, close + 0.02, open - 0.02, close, 50);
  });
}

function h1Series(count: number, lastOpen: string, price: (index: number) => Candle): Candle[] {
  const last = Date.parse(lastOpen);
  return Array.from({ length: count }, (_, index) => {
    const time = new Date(last - (count - 1 - index) * BAR_MS).toISOString();
    return { ...price(index), time };
  });
}

function overlay(base: ResearchCandle, mid: ResearchCandle["mid"], volume = base.volume): ResearchCandle {
  return { ...base, volume, mid, bid: mid, ask: mid };
}

function longFixture() {
  const h4 = risingH4(220);
  const breakoutOpen = "2023-03-24T13:00:00.000Z";
  const history = h1Series(40, new Date(Date.parse(breakoutOpen) - BAR_MS).toISOString(), (index) => {
    const base = 150 + (index % 5) * 0.02;
    const open = base;
    const close = base + 0.01;
    return candle("", open, close + 0.01, open - 0.01, close, index === 20 ? 800 : 40);
  });
  const rangeHigh = Math.max(...history.slice(-24).map((bar) => bar.high));
  const rangeLow = Math.min(...history.slice(-24).map((bar) => bar.low));
  const breakout = candle(breakoutOpen, rangeHigh - 0.02, rangeHigh + 0.45, rangeHigh - 0.04, rangeHigh + 0.40, 40);
  const wait = candle(
    new Date(Date.parse(breakoutOpen) + BAR_MS).toISOString(),
    breakout.close,
    breakout.close + 0.05,
    rangeLow + (rangeHigh - rangeLow) * 0.4,
    breakout.close - 0.02,
    40,
  );
  const pocGuess = rangeLow + (rangeHigh - rangeLow) * (20 + 0.5) / 24;
  const retestTime = new Date(Date.parse(breakoutOpen) + 2 * BAR_MS).toISOString();
  const retest = candle(retestTime, pocGuess - 0.02, pocGuess + 0.20, pocGuess - 0.08, pocGuess + 0.12, 40);
  return {
    h4: h4.map((bar) => mba(bar)),
    h1: [...history, breakout, wait, retest].map((bar) => mba(bar)),
    breakoutOpen,
    retestTime,
    rangeHigh,
    rangeLow,
  };
}

const fixture = longFixture();
const traced = evaluateTrace(fixture.h1, fixture.h4);
assert.equal(traced.error, null);
const breakoutRow = traced.rows.find((row) => row.timestamp === fixture.breakoutOpen);
assert.ok(breakoutRow, "breakout bar exists");
assert.equal(breakoutRow!.longSignal, false, "Pine cannot enter on the breakout bar");
assert.equal(breakoutRow!.bullBreakout, true, "qualifying H1 displacement creates a setup");
assert.ok(breakoutRow!.inConsolidation, "previous 24 bars, not the breakout bar, form the range");

const signals = signalsFromTrace(fixture.h1, traced.rows);
assert.equal(signals.length, 1, "one long after retest confirmation");
assert.equal(signals[0]!.signalTimestamp, fixture.retestTime);
assert.ok(signals[0]!.barsSinceBreakout > 0);
assert.ok(signals[0]!.midStop < signals[0]!.midEntry);
assert.ok(signals[0]!.midTarget > signals[0]!.midEntry);
assert.equal(Number((signals[0]!.midEntry - signals[0]!.midStop).toFixed(8)), Number((CONFIG.stopAtr * signals[0]!.atr).toFixed(8)));
assert.equal(Number((signals[0]!.midTarget - signals[0]!.midEntry).toFixed(8)), Number((CONFIG.targetAtr * signals[0]!.atr).toFixed(8)));

{
  const bearishRetest = overlay(fixture.h1.at(-1)!, {
    open: fixture.h1.at(-1)!.mid.close + 0.05,
    high: fixture.h1.at(-1)!.mid.high,
    low: fixture.h1.at(-1)!.mid.low,
    close: fixture.h1.at(-1)!.mid.low + 0.01,
  });
  const bearish = evaluateTrace([...fixture.h1.slice(0, -1), bearishRetest], fixture.h4);
  assert.equal(signalsFromTrace([...fixture.h1.slice(0, -1), bearishRetest], bearish.rows).length, 0);
}

{
  const wickThrough = overlay(fixture.h1.at(-1)!, {
    ...fixture.h1.at(-1)!.mid,
  });
  const invalidatedHistory = fixture.h1.map((bar, index) => {
    if (index !== fixture.h1.length - 2) return bar;
    return overlay(bar, {
      open: bar.mid.open,
      high: bar.mid.high,
      low: breakoutRow!.lockedRangeLow! - 0.30,
      close: bar.mid.close,
    });
  });
  const wickOnly = evaluateTrace(invalidatedHistory, fixture.h4);
  const wickRow = wickOnly.rows.find((row) => row.timestamp === fixture.h1[fixture.h1.length - 2]!.time);
  assert.equal(wickRow?.lockedPoc != null, true, "a wick through rangeLow does not invalidate");
}

{
  const closeInvalidate = fixture.h1.map((bar, index) => {
    if (index !== fixture.h1.length - 2) return bar;
    const low = breakoutRow!.lockedRangeLow! - 0.30;
    return overlay(bar, {
      open: bar.mid.open,
      high: bar.mid.high,
      low,
      close: low + 0.01,
    });
  });
  const gone = evaluateTrace(closeInvalidate, fixture.h4);
  assert.equal(signalsFromTrace(closeInvalidate, gone.rows).length, 0, "close below lockedRangeLow deletes the setup");
}

{
  const stretched: ResearchCandle[] = [...fixture.h1.slice(0, -2)];
  const last = fixture.h1[fixture.h1.length - 3]!;
  for (let offset = 1; offset <= 50; offset += 1) {
    const time = new Date(Date.parse(last.time) + offset * BAR_MS).toISOString();
    stretched.push(overlay(last, { ...last.mid, open: last.mid.close, close: last.mid.close + 0.01, high: last.mid.close + 0.02, low: last.mid.close - 0.01 }, 10));
    stretched[stretched.length - 1] = { ...stretched[stretched.length - 1]!, time };
  }
  const expired = evaluateTrace(stretched, fixture.h4);
  const at48 = expired.rows.find((row) => row.timestamp === stretched[fixture.h1.length - 3 + 48]!.time);
  const at49 = expired.rows.find((row) => row.timestamp === stretched[fixture.h1.length - 3 + 49]!.time);
  assert.ok((at48?.barsSinceBreakout ?? 0) <= CONFIG.maxRetestBars || at48?.barsSinceBreakout === CONFIG.maxRetestBars);
  assert.equal(at49?.barsSinceBreakout ?? null, null, "setup expires when barsSinceBreakout > 48");
}

{
  const formingCrash = [...fixture.h4];
  const lastH4 = formingCrash.at(-1)!;
  formingCrash[formingCrash.length - 1] = overlay(lastH4, {
    open: lastH4.mid.open,
    high: lastH4.mid.high,
    low: 80,
    close: 81,
  });
  const leaked = evaluateTrace(fixture.h1, formingCrash);
  const during = leaked.rows.find((row) => row.timestamp === fixture.breakoutOpen);
  assert.equal(during?.h4Bull, true, "forming H4 close must not leak into earlier H1 bias");
}

{
  const tpFollow = Array.from({ length: 8 }, (_, index) => {
    const time = new Date(Date.parse(fixture.retestTime) + (index + 1) * BAR_MS).toISOString();
    const target = signals[0]!.midTarget;
    const mid = { open: target - 0.05, high: target + 0.02, low: target - 0.08, close: target };
    return { time, volume: 10, complete: true as const, mid, bid: mid, ask: mid };
  });
  const resolved = resolveTrade(signals[0]!, [...fixture.h1, ...tpFollow], "midpoint");
  assert.equal(resolved?.exitReason, "TP");
  assert.ok(Math.abs((resolved?.resultR ?? 0) - CONFIG.rewardR) < 1e-9);
}

{
  const both = {
    time: new Date(Date.parse(fixture.retestTime) + BAR_MS).toISOString(),
    volume: 10,
    complete: true as const,
    mid: { open: signals[0]!.midEntry, high: signals[0]!.midTarget + 0.01, low: signals[0]!.midStop - 0.01, close: signals[0]!.midEntry },
    bid: { open: signals[0]!.midEntry, high: signals[0]!.midTarget + 0.01, low: signals[0]!.midStop - 0.01, close: signals[0]!.midEntry },
    ask: { open: signals[0]!.midEntry, high: signals[0]!.midTarget + 0.01, low: signals[0]!.midStop - 0.01, close: signals[0]!.midEntry },
  };
  const resolved = resolveTrade(signals[0]!, [...fixture.h1, both], "midpoint");
  assert.equal(resolved?.exitReason, "SL");
  assert.equal(resolved?.ambiguousSameBar, true);
}

{
  const cohort = freezeCohort(signals, fixture.h1, "midpoint");
  assert.equal(cohort.accepted.length, 1);
}

console.log("usdjpy poc swing long frozen engine ok");

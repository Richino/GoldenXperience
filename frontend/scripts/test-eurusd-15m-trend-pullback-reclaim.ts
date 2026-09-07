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
} from "./eurusd-15m-trend-pullback-reclaim";

function candle(time: string, open: number, high: number, low: number, close: number): Candle {
  return { time, open, high, low, close, volume: 100, complete: true };
}

function mba(bar: Candle, spread = 0.00012): ResearchCandle {
  const half = spread / 2;
  const shift = (value: number, delta: number) => value + delta;
  const side = (delta: number) => ({
    open: shift(bar.open, delta),
    high: shift(bar.high, delta),
    low: shift(bar.low, delta),
    close: shift(bar.close, delta),
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

function fallingDaily(count: number, start = "2023-01-02T21:00:00.000Z"): Candle[] {
  const origin = Date.parse(start);
  return Array.from({ length: count }, (_, index) => {
    const time = new Date(origin + index * 24 * 60 * 60_000).toISOString();
    const open = 1.1200 - index * 0.0012;
    const close = open - 0.0009;
    return candle(time, open, open + 0.0002, close - 0.0002, close);
  });
}

function risingM15(count: number, lastOpen: string, startPrice = 1.0800, drift = 0.00008): Candle[] {
  const last = Date.parse(lastOpen);
  return Array.from({ length: count }, (_, index) => {
    const time = new Date(last - (count - 1 - index) * BAR_MS).toISOString();
    const open = startPrice + index * drift;
    const close = open + drift * 0.6;
    return candle(time, open, close + 0.00004, open - 0.00004, close);
  });
}

function fallingM15(count: number, lastOpen: string, startPrice = 1.1000, drift = 0.00008): Candle[] {
  const last = Date.parse(lastOpen);
  return Array.from({ length: count }, (_, index) => {
    const time = new Date(last - (count - 1 - index) * BAR_MS).toISOString();
    const open = startPrice - index * drift;
    const close = open - drift * 0.6;
    return candle(time, open, open + 0.00004, close - 0.00004, close);
  });
}

function longFixture() {
  const daily = risingDaily(80);
  const signalOpen = "2023-03-24T12:00:00.000Z";
  const history = risingM15(80, new Date(Date.parse(signalOpen) - BAR_MS).toISOString());
  const ema20 = calculateEmaValues(history.map((bar) => bar.close), CONFIG.emaFastPeriod).at(-1)!;
  const ema50 = calculateEmaValues(history.map((bar) => bar.close), CONFIG.emaSlowPeriod).at(-1)!;
  assert.ok(ema20 > ema50 + 0.0004, "fixture needs EMA separation");
  const prior = history.at(-1)!;
  const pullbackClose = ema20 - 0.00012;
  const pullback = candle(
    new Date(Date.parse(signalOpen) - BAR_MS).toISOString(),
    ema20 + 0.00005,
    Math.max(prior.high - 0.00002, ema20 + 0.00008),
    ema20 - 0.00035,
    pullbackClose,
  );
  const withPullback = [...history.slice(0, -1), pullback];
  const emaAfter = calculateEmaValues(withPullback.map((bar) => bar.close), CONFIG.emaFastPeriod).at(-1)!;
  const atr = calculateAtrValues(withPullback, CONFIG.atrPeriod).at(-1)!;
  const body = Math.max(0.35 * atr + 0.00005, 0.0004);
  const reclaimClose = Math.max(emaAfter + 0.00025, pullbackClose + body);
  const reclaimOpen = reclaimClose - body;
  const reclaim = candle(
    signalOpen,
    reclaimOpen,
    Math.max(pullback.high + 0.0002, reclaimClose + 0.00005),
    pullback.low + 0.00008,
    reclaimClose,
  );
  const m15 = [...withPullback, reclaim].map((bar) => mba(bar));
  return { daily: daily.map((bar) => mba(bar)), m15, signalOpen };
}

function shortFixture() {
  const daily = fallingDaily(80);
  const signalOpen = "2023-03-24T12:00:00.000Z";
  const history = fallingM15(80, new Date(Date.parse(signalOpen) - BAR_MS).toISOString());
  const ema20 = calculateEmaValues(history.map((bar) => bar.close), CONFIG.emaFastPeriod).at(-1)!;
  const ema50 = calculateEmaValues(history.map((bar) => bar.close), CONFIG.emaSlowPeriod).at(-1)!;
  assert.ok(ema20 < ema50 - 0.0004, "fixture needs EMA separation");
  const prior = history.at(-1)!;
  const pullbackClose = ema20 + 0.00012;
  const pullback = candle(
    new Date(Date.parse(signalOpen) - BAR_MS).toISOString(),
    ema20 - 0.00005,
    ema20 + 0.00035,
    Math.min(prior.low + 0.00002, ema20 - 0.00008),
    pullbackClose,
  );
  const withPullback = [...history.slice(0, -1), pullback];
  const emaAfter = calculateEmaValues(withPullback.map((bar) => bar.close), CONFIG.emaFastPeriod).at(-1)!;
  const atr = calculateAtrValues(withPullback, CONFIG.atrPeriod).at(-1)!;
  const body = Math.max(0.35 * atr + 0.00005, 0.0004);
  const reclaimClose = Math.min(emaAfter - 0.00025, pullbackClose - body);
  const reclaimOpen = reclaimClose + body;
  const reclaim = candle(
    signalOpen,
    reclaimOpen,
    pullback.high - 0.00008,
    Math.min(pullback.low - 0.0002, reclaimClose - 0.00005),
    reclaimClose,
  );
  return { daily: daily.map((bar) => mba(bar)), m15: [...withPullback, reclaim].map((bar) => mba(bar)), signalOpen };
}

function followThrough(signal: FrozenSignal, bars: ResearchCandle[], direction: "tp" | "sl"): ResearchCandle[] {
  const last = bars.at(-1)!;
  const t1 = new Date(Date.parse(last.time) + BAR_MS).toISOString();
  const t2 = new Date(Date.parse(last.time) + 2 * BAR_MS).toISOString();
  const quiet = (time: string): ResearchCandle => {
    const mid = { open: signal.midEntry, high: signal.midEntry + 0.00005, low: signal.midEntry - 0.00005, close: signal.midEntry };
    return { time, volume: 10, complete: true, mid, bid: mid, ask: mid };
  };
  if (direction === "tp") {
    const hit = signal.direction === "long"
      ? { open: signal.midEntry, high: signal.midTarget + 0.0001, low: signal.midEntry - 0.00005, close: signal.midTarget }
      : { open: signal.midEntry, high: signal.midEntry + 0.00005, low: signal.midTarget - 0.0001, close: signal.midTarget };
    return [...bars, quiet(t1), { time: t2, volume: 10, complete: true, mid: hit, bid: hit, ask: hit }];
  }
  const hit = signal.direction === "long"
    ? { open: signal.midEntry, high: signal.midEntry + 0.00005, low: signal.midStop - 0.0001, close: signal.midStop }
    : { open: signal.midEntry, high: signal.midStop + 0.0001, low: signal.midEntry - 0.00005, close: signal.midStop };
  return [...bars, quiet(t1), { time: t2, volume: 10, complete: true, mid: hit, bid: hit, ask: hit }];
}

const longSetup = longFixture();
const longTrace = evaluateTrace(longSetup.m15, longSetup.daily);
assert.equal(longTrace.error, null, longTrace.error ?? undefined);
const longSignals = signalsFromTrace(longSetup.m15, longTrace.rows);
assert.equal(longSignals.length, 1, `expected one long signal, got ${longSignals.length}`);
assert.equal(longSignals[0]!.direction, "long");
assert.equal(longSignals[0]!.signalTimestamp, longSetup.signalOpen);
assert.equal(longSignals[0]!.midEntry, longSetup.m15.at(-1)!.mid.close);

const tinyBody = structuredClone(longSetup);
const last = tinyBody.m15.at(-1)!;
last.mid = { ...last.mid, open: last.mid.close - 0.00001, high: last.mid.close + 0.00002, low: last.mid.close - 0.00003 };
last.bid = { ...last.mid, open: last.mid.open - 0.00006, high: last.mid.high - 0.00006, low: last.mid.low - 0.00006, close: last.mid.close - 0.00006 };
last.ask = { ...last.mid, open: last.mid.open + 0.00006, high: last.mid.high + 0.00006, low: last.mid.low + 0.00006, close: last.mid.close + 0.00006 };
const tinyTrace = evaluateTrace(tinyBody.m15, tinyBody.daily);
assert.equal(signalsFromTrace(tinyBody.m15, tinyTrace.rows).length, 0, "body below 0.35 ATR must not fire");

const shortSetup = shortFixture();
const shortTrace = evaluateTrace(shortSetup.m15, shortSetup.daily);
assert.equal(shortTrace.error, null, shortTrace.error ?? undefined);
const shortSignals = signalsFromTrace(shortSetup.m15, shortTrace.rows);
assert.equal(shortSignals.length, 1, `expected one short signal, got ${shortSignals.length}`);
assert.equal(shortSignals[0]!.direction, "short");

const longTpPath = followThrough(longSignals[0]!, longSetup.m15, "tp");
const longTp = resolveTrade(longSignals[0]!, longTpPath, "midpoint");
assert.equal(longTp?.exitReason, "TP");
assert.ok(Math.abs((longTp?.resultR ?? 0) - 2) < 1e-9);

const longSlPath = followThrough(longSignals[0]!, longSetup.m15, "sl");
const longSl = resolveTrade(longSignals[0]!, longSlPath, "midpoint");
assert.equal(longSl?.exitReason, "SL");
assert.ok(Math.abs((longSl?.resultR ?? 0) + 1) < 1e-9);

const ambiguous = structuredClone(longTpPath);
const hit = ambiguous.at(-1)!;
hit.mid = { open: longSignals[0]!.midEntry, high: longSignals[0]!.midTarget + 0.0002, low: longSignals[0]!.midStop - 0.0002, close: longSignals[0]!.midEntry };
hit.bid = hit.mid;
hit.ask = hit.mid;
const stopFirst = resolveTrade(longSignals[0]!, ambiguous, "midpoint", { ambiguityPolicy: "stop_first" });
assert.equal(stopFirst?.exitReason, "SL");
assert.equal(stopFirst?.ambiguousSameBar, true);

const gapStop = structuredClone(longTpPath);
const gapBar = gapStop.at(-1)!;
gapBar.mid = { open: longSignals[0]!.midStop - 0.0004, high: longSignals[0]!.midStop - 0.0001, low: longSignals[0]!.midStop - 0.0005, close: longSignals[0]!.midStop - 0.0002 };
gapBar.bid = gapBar.mid;
gapBar.ask = gapBar.mid;
const gapped = resolveTrade(longSignals[0]!, gapStop, "midpoint");
assert.equal(gapped?.exitReason, "SL");
assert.ok((gapped?.resultR ?? 0) < -1, "adverse gap must fill worse than the frozen stop");

const occupied = freezeCohort(longSignals, longTpPath);
assert.equal(occupied.accepted.length, 1);
const second = { ...longSignals[0]!, signalTimestamp: gapStop.at(-2)!.time, decisionTime: new Date(Date.parse(gapStop.at(-2)!.time) + BAR_MS).toISOString() };
const pyramid = freezeCohort([longSignals[0]!, second], longTpPath);
assert.equal(pyramid.accepted.length, 1, "no pyramiding while a trade is open");
assert.equal(pyramid.skipped.length, 1);

const exec = resolveTrade(longSignals[0]!, longTpPath, "executable");
assert.equal(exec?.exitReason, "TP");
assert.ok(Math.abs((exec?.resultR ?? 0) - 2) < 1e-9, "frozen 1 ATR / 2 ATR geometry remains +2R on a clean executable target");
assert.ok(longSetup.m15.at(-1)!.ask.close > longSignals[0]!.midEntry, "long executable entry is the ask");

console.log("eurusd_15m_trend_pullback_reclaim_v1 frozen-rule tests passed.");

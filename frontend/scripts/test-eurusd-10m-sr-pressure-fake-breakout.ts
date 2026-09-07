import assert from "node:assert/strict";

import type { ResearchCandle } from "../src/lib/oanda/client";
import type { Candle } from "../src/types/forex";

import {
  BAR_MS,
  CONFIG,
  breakoutStats,
  countResistanceTouches,
  evaluateTrace,
  freezeCohort,
  inAsiaSession,
  inLondonWindow,
  resolveTrade,
  signalsFromTrace,
  type FrozenSignal,
} from "./eurusd-10m-sr-pressure-fake-breakout";

function candle(time: string, open: number, high: number, low: number, close: number): Candle {
  return { time, open, high, low, close, volume: 10, complete: true };
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

assert.equal(inAsiaSession("2026-02-02T05:50:00.000Z"), true);
assert.equal(inAsiaSession("2026-02-02T06:00:00.000Z"), false);
assert.equal(inLondonWindow("2026-02-02T06:00:00.000Z"), true);
assert.equal(inLondonWindow("2026-02-02T11:00:00.000Z"), false);

const level = 1.1000;
const atr = 0.0010;
const touchBars = [
  candle("a", 1.0990, 1.0999, 1.0988, 1.0995),
  candle("b", 1.0994, 1.1000, 1.0990, 1.0996),
  candle("c", 1.0980, 1.0985, 1.0975, 1.0982),
];
assert.equal(countResistanceTouches(touchBars, 3, level, atr), 2);

function stamp(start: string, offset: number) {
  return new Date(Date.parse(start) + offset * BAR_MS).toISOString();
}

function risingSeries(start: string, count: number, price: number) {
  return Array.from({ length: count }, (_, index) => {
    const time = stamp(start, index);
    const open = price + index * 0.00002;
    const close = open + 0.00003;
    return candle(time, open, close + 0.00002, open - 0.00002, close);
  });
}

function fixture(kind: "real" | "fake" | "weak-body") {
  const warmupStart = "2026-02-01T10:40:00.000Z";
  const warmup = risingSeries(warmupStart, 80, 1.0850);
  const asiaStart = "2026-02-02T00:00:00.000Z";
  const asiaHigh = 1.1000;
  const asia = Array.from({ length: 36 }, (_, index) => {
    const time = stamp(asiaStart, index);
    if (index === 20 || index === 28 || index === 34) {
      return candle(time, asiaHigh - 0.00040, asiaHigh, asiaHigh - 0.00050, asiaHigh - 0.00010);
    }
    const open = 1.0960 + index * 0.00002;
    const close = open + 0.00004;
    return candle(time, open, Math.min(asiaHigh - 0.00020, close + 0.00006), open - 0.00006, close);
  });
  const londonLead = Array.from({ length: 6 }, (_, index) => {
    const time = stamp("2026-02-02T06:00:00.000Z", index);
    const open = 1.0982 + index * 0.00008;
    const close = open + 0.00010;
    return candle(time, open, close + 0.00004, open - 0.00004, close);
  });
  const breakoutTime = "2026-02-02T07:00:00.000Z";
  const confirmTime = "2026-02-02T07:10:00.000Z";
  const breakout = kind === "weak-body"
    ? candle(breakoutTime, 1.10000, 1.10003, 1.09998, 1.10001)
    : candle(breakoutTime, 1.0994, 1.1012, 1.0990, 1.1009);
  const confirm = kind === "fake"
    ? candle(confirmTime, 1.1006, 1.1008, 1.0994, 1.0997)
    : candle(confirmTime, 1.1008, 1.1018, 1.1005, 1.1014);
  return { bars: [...warmup, ...asia, ...londonLead, breakout, confirm].map((bar) => mba(bar)), breakoutTime, confirmTime, asiaHigh };
}

const realSetup = fixture("real");
const realTrace = evaluateTrace(realSetup.bars);
assert.equal(realTrace.error, null, realTrace.error ?? undefined);
const breakoutRow = realTrace.rows.find((row) => row.timestamp === realSetup.breakoutTime);
assert.equal(breakoutRow?.longBreakout, true, "London close through Asia high should arm");
assert.equal(breakoutRow?.realBreakout, false, "do not enter on the breakout candle");
const confirmRow = realTrace.rows.find((row) => row.timestamp === realSetup.confirmTime);
assert.equal(confirmRow?.realBreakout, true);
assert.equal(confirmRow?.fakeBreakout, false);
const realSignals = signalsFromTrace(realSetup.bars, realTrace.rows);
assert.equal(realSignals.length, 1);
assert.equal(realSignals[0]!.signalTimestamp, realSetup.confirmTime);
assert.equal(realSignals[0]!.breakoutTimestamp, realSetup.breakoutTime);
assert.ok(Math.abs(realSignals[0]!.frozenResistance - realSetup.asiaHigh) < 1e-9);

const fakeSetup = fixture("fake");
const fakeTrace = evaluateTrace(fakeSetup.bars);
assert.equal(fakeTrace.rows.find((row) => row.timestamp === fakeSetup.confirmTime)?.fakeBreakout, true);
assert.equal(signalsFromTrace(fakeSetup.bars, fakeTrace.rows).length, 0);
assert.ok((breakoutStats(fakeTrace.rows).fakeBreakoutRate ?? 0) > 0);

const weak = fixture("weak-body");
assert.equal(evaluateTrace(weak.bars).rows.find((row) => row.timestamp === weak.breakoutTime)?.longBreakout, false);

const signal = realSignals[0]!;
function followThrough(entry: FrozenSignal, start: string, kind: "tp" | "sl" | "both"): ResearchCandle[] {
  const time = new Date(Date.parse(start) + BAR_MS).toISOString();
  const mid = kind === "tp"
    ? { open: entry.midEntry, high: entry.midTarget + 0.0002, low: entry.midEntry - 0.00005, close: entry.midTarget }
    : kind === "sl"
      ? { open: entry.midEntry, high: entry.midEntry + 0.00005, low: entry.midStop - 0.0002, close: entry.midStop }
      : { open: entry.midEntry, high: entry.midTarget + 0.0002, low: entry.midStop - 0.0002, close: entry.midEntry };
  return [{ time, volume: 10, complete: true, mid, bid: mid, ask: mid }];
}

assert.equal(resolveTrade(signal, [...realSetup.bars, ...followThrough(signal, realSetup.confirmTime, "tp")], "midpoint")?.exitReason, "TP");
assert.equal(resolveTrade(signal, [...realSetup.bars, ...followThrough(signal, realSetup.confirmTime, "sl")], "midpoint")?.exitReason, "SL");
const both = resolveTrade(signal, [...realSetup.bars, ...followThrough(signal, realSetup.confirmTime, "both")], "midpoint");
assert.equal(both?.exitReason, "SL");
assert.equal(both?.ambiguousSameBar, true);

const later = { ...signal, signalTimestamp: stamp(realSetup.confirmTime, 1), decisionTime: stamp(realSetup.confirmTime, 2) };
const pyramid = freezeCohort([signal, later], [...realSetup.bars, ...followThrough(signal, realSetup.confirmTime, "tp")]);
assert.equal(pyramid.accepted.length, 1);
assert.equal(pyramid.skipped.length, 1);

console.log("eurusd_10m_sr_pressure_fake_breakout_v2_long_only frozen-rule tests passed.");

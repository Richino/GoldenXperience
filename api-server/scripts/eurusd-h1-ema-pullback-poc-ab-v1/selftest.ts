import assert from "node:assert/strict";

import {
  calculateEmaValues,
  detectSignals,
  isWeekendCloseBar,
  normalizeMba,
  resolvePath,
  resultR,
  sizePosition,
  STARTING_BALANCE,
  type MbaBar,
  type Side,
} from "./engine.js";
import { computePoc, pocByUtcDay, previousUtcDayKey, yesterdayPocForSignalDay } from "./poc.js";

function side(open: number, high: number, low: number, close: number): Side {
  return { open, high, low, close };
}

function mba(
  time: string,
  periodMs: number,
  mid: Side,
  volume = 10,
  spread = 0.0001,
): MbaBar {
  const openMs = Date.parse(time);
  const half = spread / 2;
  const shift = (s: Side, delta: number): Side => ({
    open: s.open + delta, high: s.high + delta, low: s.low + delta, close: s.close + delta,
  });
  return {
    time,
    openMs,
    closeMs: openMs + periodMs,
    volume,
    mid,
    bid: shift(mid, -half),
    ask: shift(mid, half),
  };
}

{
  const bars = [
    { high: 106, low: 105, close: 105.5, volume: 10 },
    { high: 106.5, low: 105.2, close: 105.7, volume: 400 },
    { high: 111, low: 109, close: 110, volume: 10 },
  ];
  const poc = computePoc(bars, 100, 124, 24);
  assert.equal(poc, 105.5, "POC is the center of the highest-volume HLC3 bin (GX computePoc math)");
}

{
  const m5 = [
    mba("2026-09-04T12:00:00.000Z", 300_000, side(1.10, 1.11, 1.09, 1.105), 50),
    mba("2026-09-04T23:55:00.000Z", 300_000, side(1.105, 1.106, 1.104, 1.105), 500),
    mba("2026-09-05T00:00:00.000Z", 300_000, side(1.20, 1.21, 1.19, 1.20), 9999),
  ];
  const byDay = pocByUtcDay(m5.map((bar) => ({
    openMs: bar.openMs, high: bar.mid.high, low: bar.mid.low, close: bar.mid.close, volume: bar.volume,
  })));
  const y = yesterdayPocForSignalDay(byDay, "2026-09-05");
  assert.ok(y != null, "yesterday POC exists");
  assert.ok(y! < 1.15, "current-day high-volume bar must not leak into yesterday POC");
  assert.equal(previousUtcDayKey("2026-09-05"), "2026-09-04");
}

{
  const closes = [1, 1, 1, 1, 1, 2, 2, 2, 2, 2];
  const values = calculateEmaValues(closes, 5);
  assert.equal(values[3], null);
  assert.ok(values[4] != null);
  assert.ok(values[9]! > values[4]!, "EMA rises after higher closes");
}

{
  const h1: MbaBar[] = [];
  let price = 1.1000;
  for (let i = 0; i < 80; i += 1) {
    price += 0.0004;
    const open = price - 0.0002;
    const close = price + 0.0003;
    const time = new Date(Date.parse("2026-01-05T00:00:00.000Z") + i * 3_600_000).toISOString();
    h1.push(mba(time, 3_600_000, side(open, close + 0.0001, open - 0.0001, close), 20, 0.00012));
  }
  const t = 70;
  const e20 = calculateEmaValues(h1.map((bar) => bar.mid.close), 20)[t];
  assert.ok(e20 != null);
  const prevHigh = h1[t - 1]!.mid.high;
  const close = prevHigh + 0.0004;
  const low = e20 - 0.0004;
  h1[t] = mba(h1[t]!.time, 3_600_000, side(e20 + 0.0001, close + 0.0001, low, close), 20, 0.00012);
  const signalDay = h1[t]!.time.slice(0, 10);
  const yDay = previousUtcDayKey(signalDay);
  const poc = new Map<string, number | null>([[yDay, 1.1200], [signalDay, 1.9999]]);
  const opps = detectSignals(h1, poc);
  const longs = opps.filter((row) => row.h1Index === t && row.direction === "long");
  assert.equal(longs.length, 1, "constructed long pullback must fire");
  const sample = longs[0]!;
  assert.equal(sample.yesterdayPoc, 1.1200);
  assert.notEqual(sample.yesterdayPoc, 1.9999);
  assert.equal(sample.entryMs, sample.signalCloseMs);
  assert.ok(sample.stop < sample.threeBarLow);
  assert.ok(sample.executableEntry != null && sample.target != null);
  assert.ok(Math.abs((sample.target! - sample.executableEntry!) / (sample.executableEntry! - sample.stop) - 2) < 1e-9);
  assert.equal(sample.bReject, null);
  assert.equal(sample.aReject, null);
}

{
  const sized = sizePosition(100, 1.1000, 1.0980, 0.02);
  assert.equal(sized.units, Math.floor(sized.riskDollars / Math.abs(1.1000 - 1.0980)));
  assert.ok(sized.actualModeledRisk <= sized.riskDollars + 1e-12);
  const tiny = sizePosition(100, 1.1, 1.1 - 2, 0.02);
  assert.equal(tiny.reject, "UNITS_TOO_SMALL");
  const margin = sizePosition(100, 1.1, 1.0999, 5);
  assert.equal(margin.reject, "INSUFFICIENT_MARGIN");
}

{
  assert.equal(resultR("long", 1.10, 1.09, 1.12), 2);
  assert.equal(resultR("long", 1.10, 1.09, 1.09), -1);
  assert.equal(resultR("short", 1.10, 1.12, 1.06), 2);
}

{
  const bars = [
    { openMs: 0, closeMs: 3_600_000 },
    { openMs: 3_600_000, closeMs: 7_200_000 },
    { openMs: 7_200_000 + 48 * 3600_000, closeMs: 7_200_000 + 48 * 3600_000 + 3_600_000 },
  ];
  assert.equal(isWeekendCloseBar(bars, 0), false);
  assert.equal(isWeekendCloseBar(bars, 1), true);
}

{
  const m5: MbaBar[] = [];
  const start = Date.parse("2026-03-02T10:00:00.000Z");
  for (let i = 0; i < 80; i += 1) {
    const time = new Date(start + i * 300_000).toISOString();
    m5.push(mba(time, 300_000, side(1.1000, 1.1005, 1.0995, 1.1002), 10, 0.0001));
  }
  m5[6] = mba(m5[6]!.time, 300_000, side(1.1000, 1.1040, 1.0980, 1.1000), 10, 0.0001);
  const path = await resolvePath(
    "long",
    m5[0]!.openMs,
    1.0990,
    1.1030,
    0,
    m5,
    [m5[0]!.openMs, m5[12]!.openMs],
    async () => [
      { openMs: m5[6]!.openMs, closeMs: m5[6]!.openMs + 60_000, time: m5[6]!.time, bid: side(1.1000, 1.1002, 1.0980, 1.0985), ask: side(1.1001, 1.1003, 1.0981, 1.0986) },
      { openMs: m5[6]!.openMs + 60_000, closeMs: m5[6]!.openMs + 120_000, time: m5[6]!.time, bid: side(1.1010, 1.1040, 1.1008, 1.1035), ask: side(1.1011, 1.1041, 1.1009, 1.1036) },
    ],
  );
  assert.ok(path);
  assert.equal(path!.exitReason, "STOP");
  assert.equal(path!.ambiguousIntrabar, true);
  assert.equal(path!.resolutionMethod, "m1_path");
}

{
  const parsed = normalizeMba([
    { time: "2026-01-01T00:00:00.000Z", volume: 1, complete: true, mid: side(1, 1.1, 0.9, 1), bid: side(0.999, 1.099, 0.899, 0.999), ask: side(1.001, 1.101, 0.901, 1.001) },
    { time: "2026-01-01T00:00:00.000Z", volume: 1, complete: true, mid: side(1, 1.1, 0.9, 1), bid: side(0.999, 1.099, 0.899, 0.999), ask: side(1.001, 1.101, 0.901, 1.001) },
  ], 3_600_000);
  assert.equal(parsed.bars.length, 1);
  assert.equal(parsed.duplicates, 1);
}

assert.equal(STARTING_BALANCE, 100);
console.log("eurusd-h1-ema-pullback-poc-ab-v1 selftest: PASS");

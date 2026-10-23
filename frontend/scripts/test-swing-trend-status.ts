import assert from "node:assert/strict";
import { swingTrendStatus, weeklySwingStatus } from "../src/lib/swing-trend-status";
import { candleAligned, candleEnd } from "../src/lib/strategy/candle-clock";
import { checkTimeframe } from "../src/lib/strategy/analyze-v2/data-quality";
import { ANALYZE_V2 } from "../src/lib/strategy/analyze-v2/config";
import type { Candle } from "../src/types/forex";
import type { TrendDirection } from "../src/lib/strategy/analyze-v2/structure";

assert.equal(swingTrendStatus("UPTREND", "UPTREND").tone, "up");
assert.equal(swingTrendStatus("DOWNTREND", "DOWNTREND").tone, "down");
assert.match(swingTrendStatus("UPTREND", "DOWNTREND").label, /pullback/);
assert.match(swingTrendStatus("DOWNTREND", "UPTREND").label, /rebound/);
assert.match(swingTrendStatus("DOWNTREND", "RANGE").label, /Consolidating/);
assert.match(swingTrendStatus("UPTREND", "TRANSITION").label, /4H changing/);
assert.match(swingTrendStatus("TRANSITION", "UPTREND").label, /Daily structure changing/);
assert.equal(swingTrendStatus("RANGE", "UPTREND").tone, "neutral", "a local rally does not establish a Daily uptrend");
assert.equal(swingTrendStatus("UNCLEAR", "DOWNTREND").tone, "neutral");
const directions: (TrendDirection | null)[] = ["UPTREND", "DOWNTREND", "RANGE", "TRANSITION", "UNCLEAR", null];
for (const daily of directions) for (const h4 of directions) {
  const status = swingTrendStatus(daily, h4);
  if (!daily || !h4) {
    assert.match(status.label, /unavailable/);
    assert.equal(status.tone, "neutral", "missing data cannot imply an actionable direction");
  }
  if (status.tone === "up" || status.tone === "down") assert.equal(daily, h4, "directional tone requires alignment");
  if (daily && h4 && daily !== h4 && ["UPTREND", "DOWNTREND"].includes(daily) && ["UPTREND", "DOWNTREND"].includes(h4)) {
    assert.match(status.detail, /neither outcome is confirmed/, "opposing structure must not claim a confirmed reversal or pullback");
  }
}
console.log("Swing trend status checks passed (36 timeframe combinations).");

for (const weekly of directions) for (const daily of directions) {
  const status = weeklySwingStatus(weekly, daily);
  assert.ok(!status.label.includes("4H"), "weekly context must describe the Daily setup, not 4H timing");
  if (!weekly || !daily) assert.equal(status.rank, 7);
  if (status.rank === 0) assert.ok(weekly === daily && ["UPTREND", "DOWNTREND"].includes(weekly!));
}
const ranked = [
  weeklySwingStatus(null, "UPTREND"), weeklySwingStatus("UNCLEAR", "UPTREND"),
  weeklySwingStatus("RANGE", "DOWNTREND"), weeklySwingStatus("TRANSITION", "UPTREND"),
  weeklySwingStatus("UPTREND", "UNCLEAR"), weeklySwingStatus("DOWNTREND", "RANGE"),
  weeklySwingStatus("UPTREND", "DOWNTREND"), weeklySwingStatus("DOWNTREND", "DOWNTREND"),
].sort((a, b) => a.rank - b.rank);
assert.deepEqual(ranked.map(s => s.rank), [0, 1, 2, 3, 4, 5, 6, 7], "alignment first, missing data last");

for (const [open, expectedEnd] of [
  ["2026-03-06T22:00:00Z", "2026-03-13T21:00:00Z"],
  ["2026-10-30T21:00:00Z", "2026-11-06T22:00:00Z"],
  ["2026-10-09T21:00:00Z", "2026-10-16T21:00:00Z"],
]) {
  assert.equal(candleAligned(Date.parse(open!), "W"), true);
  assert.equal(candleEnd(Date.parse(open!), "W"), Date.parse(expectedEnd!));
}
assert.equal(candleAligned(Date.parse("2026-10-16T20:00:00Z"), "W"), false);
assert.equal(candleAligned(Date.parse("2026-10-15T21:00:00Z"), "W"), false);

let at = Date.parse("2025-07-04T21:00:00Z");
const candles: Candle[] = Array.from({ length: 69 }, () => {
  const candle = { time: new Date(at).toISOString(), open: 1, high: 1.1, low: 0.9, close: 1, volume: 100, complete: true };
  at = candleEnd(at, "W");
  return candle;
});
const now = Date.parse("2026-10-22T20:00:00Z");
const checked = checkTimeframe("Weekly", candles, "W", now, ANALYZE_V2.SWING, true);
assert.equal(checked.checks.some(c => c.status === "FAIL" || c.status === "UNKNOWN"), false, JSON.stringify(checked.checks));
assert.ok(checked.normalized.closed.every(c => candleEnd(Date.parse(c.time), "W") <= now), "current incomplete week must never decide structure");
const stale = checkTimeframe("Weekly", candles.slice(0, -4), "W", now, ANALYZE_V2.SWING, true);
assert.equal(stale.checks.find(c => c.id.endsWith("freshness"))?.status, "FAIL");
const malformed = checkTimeframe("Weekly", candles.map((c, i) => i === 10 ? { ...c, low: 2 } : c), "W", now, ANALYZE_V2.SWING, true);
assert.equal(malformed.checks.find(c => c.id.endsWith("integrity"))?.status, "FAIL");
console.log("Weekly ranking, DST boundaries, incomplete weeks, stale and malformed data checks passed.");

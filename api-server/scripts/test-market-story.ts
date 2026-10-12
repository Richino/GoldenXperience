import assert from "node:assert/strict";
import type { Candle } from "../../frontend/src/types/forex.js";
import { marketStory } from "../src/market-story.js";
const start = Date.parse("2026-09-01T00:00:00Z");
const intervals = { H4: 14_400_000, H1: 3_600_000, M15: 900_000 };
const series = (tf: keyof typeof intervals, slope: number): Candle[] => Array.from({ length: 100 }, (_, i) => {
  const close = 1.1 + slope * i + Math.sin(i * Math.PI / 4) * 0.001;
  return { time: new Date(start + intervals[tf] * i).toISOString(), open: close, close, high: close + 0.0001, low: close - 0.0001, complete: true, volume: 1 };
});
const history = { H4: series("H4", 0.00006), H1: series("H1", -0.00006), M15: series("M15", -0.00002) };
const end = new Date(start + intervals.H4 * 100).toISOString();
const story = marketStory("EUR_USD", history, end);
assert.equal(story.broader.direction, "up");
assert.equal(story.recent.direction, "down");
assert.match(story.recent.summary, /pullback/);
assert.equal(story.current.levels.length, 2);
assert.equal(story.broader.bars, 100);
assert.equal(story.current.bars, 64);
assert.equal(marketStory("EUR_USD", {}, end).broader.direction, "unknown");
// Every replay step must equal an independently truncated prefix; future bars
// and a wildly moving open candle must never change the historical read.
let replaySteps = 0;
for (const interval of Object.values(intervals)) for (let i = 20; i <= 100; i++) {
  const asOf = new Date(start + interval * i).toISOString();
  const prefix = Object.fromEntries(Object.entries(history).map(([tf, bars]) => [tf, bars.filter(c => Date.parse(c.time) + intervals[tf as keyof typeof intervals] <= Date.parse(asOf))]));
  assert.deepEqual(marketStory("EUR_USD", history, asOf), marketStory("EUR_USD", prefix, asOf));
  const forming = { ...history.M15[0], time: asOf, high: 8, low: 0.1, close: 7, complete: false };
  assert.deepEqual(marketStory("EUR_USD", { ...history, M15: [...history.M15, forming] }, asOf), marketStory("EUR_USD", history, asOf));
  for (const level of marketStory("EUR_USD", history, asOf).current.levels) assert.ok(Date.parse(level.knownAt) <= Date.parse(asOf));
  replaySteps++;
}
// Freeze an established pivot and append a break, then a reclaim. Wicks do
// not count, and the new bars have not yet supplied two future confirmation bars.
const m15 = series("M15", 0).slice(0, 40);
const at = (count: number) => new Date(start + intervals.M15 * count).toISOString();
const initial = marketStory("EUR_USD", { M15: m15 }, at(40));
const support = initial.current.levels.find(l => l.role === "support")!;
const candle = (i: number, close: number, low = close - 0.00005): Candle => ({ time: at(i), open: close, close, low, high: close + 0.00005, complete: true, volume: 1 });
const wick = candle(40, support.high + 0.0001, support.low - 0.0002);
assert.equal(marketStory("EUR_USD", { M15: [...m15, wick] }, at(41)).current.levels.find(l => l.role === "support")!.state, "testing");
const broken = candle(40, support.low - 0.0002);
assert.equal(marketStory("EUR_USD", { M15: [...m15, broken] }, at(41)).current.levels.find(l => l.role === "support")!.state, "broken");
const reclaim = candle(41, support.high + 0.0002);
assert.equal(marketStory("EUR_USD", { M15: [...m15, broken, reclaim] }, at(42)).current.levels.find(l => l.role === "support")!.state, "reclaimed");
console.log(`Market story passed: ${replaySteps} causal replay steps, multi-timeframe pullback, missing context, forming-candle exclusion, wick/break/reclaim.`);

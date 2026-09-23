import assert from "node:assert/strict";
import { analyzeAdaptiveSwingTrendlines, confirmedSwings } from "../src/lib/adaptive-swing-trendlines";
import type { Candle } from "../src/types/forex";

const M15 = (index: number) => new Date(Date.UTC(2026, 8, 21, 0, index * 15)).toISOString();
const candles = (values: number[]): Candle[] => values.map((value, index) => ({ time: M15(index), open: value, high: value + 0.1, low: value - 0.1, close: value, volume: 1, complete: true }));

const source = candles([12, 11, 10, 9, 8, 9, 10, 11, 12, 11, 10, 11, 12, 13, 14, 15, 14, 13, 12, 13, 14, 15, 16, 17, 16, 15, 14, 15, 16, 17, 18, 17, 16, 17, 18, 19, 20]);
const swings = confirmedSwings(source);
const low = swings.find((swing) => swing.type === "low" && swing.index === 4);
assert.ok(low);
assert.equal(low.confirmationIndex, 7, "a pivot must wait for three completed right-side candles");
assert.equal(low.confirmationTime, source[7]!.time);

const beforeConfirmation = analyzeAdaptiveSwingTrendlines(source.slice(0, 7), "EUR_USD");
assert.equal(beforeConfirmation.swings.some((swing) => swing.index === 4), false, "the future confirmation bars cannot leak into candle T");
const afterConfirmation = analyzeAdaptiveSwingTrendlines(source.slice(0, 8), "EUR_USD");
assert.equal(afterConfirmation.swings.some((swing) => swing.index === 4), true);

const read = analyzeAdaptiveSwingTrendlines(source, "EUR_USD");
assert.equal(read.majorDirection, "bullish");
assert.ok(read.major && read.major.pointA.price < read.major.pointB.price, "major line uses higher lows");
assert.ok(read.current && read.current.pointA.price < read.current.pointB.price, "current line uses a newer higher-low pair");
assert.ok(read.current!.pointB.index >= read.major!.pointB.index, "current structure is at least as recent as broad structure");

const broken = analyzeAdaptiveSwingTrendlines(candles([...source.map((candle) => candle.close), 17, 16, 15, 14, 13]), "EUR_USD");
assert.equal(broken.currentDirection, null, "a completed close through the current bullish line retires it instead of manufacturing a bearish reversal");
console.log("adaptive swing trendline checks passed");

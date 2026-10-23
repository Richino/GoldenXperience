import assert from "node:assert/strict";
import { compareWeeklyTrends, rankWeeklyTrends, weeklyTiming, type PairTrendRow } from "../src/lib/home/weekly-trends";
import { readSwingTrend } from "../src/lib/swing-trend-read";
import type { CandleSeries } from "../src/types/forex";

const row = (instrument: string, w1: PairTrendRow["w1"], d1: PairTrendRow["d1"], h4: PairTrendRow["h4"]): PairTrendRow => ({ instrument, w1, d1, h4 });
const up = "UPTREND", down = "DOWNTREND";
const candidates = [
  row("EUR_USD", down, up, up), // Old Daily/H4 alignment is insufficient.
  row("GBP_USD", "RANGE", up, up),
  row("USD_JPY", "UNCLEAR", down, down),
  row("EUR_GBP", up, up, down),
  row("USD_CAD", up, up, "RANGE"),
  row("GBP_ZAR", up, up, up),
  row("AUD_USD", down, down, down),
  row("NZD_USD", up, up, "TRANSITION"),
];
const ranked = rankWeeklyTrends(candidates);
assert.deepEqual(ranked.map(r => r.instrument), ["AUD_USD", "GBP_ZAR", "USD_CAD", "NZD_USD", "EUR_GBP"]);
assert.equal(candidates[0]!.instrument, "EUR_USD", "ranking must not mutate its snapshot");
assert.equal(rankWeeklyTrends([row("EUR_USD", up, "TRANSITION", up)]).length, 0);
assert.equal(rankWeeklyTrends([row("EUR_USD", up, "RANGE", up)]).length, 0);
assert.match(weeklyTiming(ranked.at(-1)!).label, /opposing/, "countertrend timing must stay explicit");
assert.deepEqual(rankWeeklyTrends([]), []);
const markets = [...candidates].sort(compareWeeklyTrends);
assert.deepEqual(markets.slice(0, ranked.length), ranked, "Markets must show scanner candidates in exactly the scanner order");
assert.equal(markets.length, candidates.length, "Markets must retain unqualified pairs for browsing");
assert.deepEqual(markets.slice(ranked.length).map(r => r.instrument), ["EUR_USD", "GBP_USD", "USD_JPY"], "opposing Daily moves precede Weekly ranges and unclear structure");

const series: CandleSeries = { instrument: "EUR_USD", granularity: "W", source: "oanda", candles: [] };
assert.equal(readSwingTrend("EUR_USD", "W", undefined), null);
assert.equal(readSwingTrend("EUR_USD", "W", { ...series, source: "mock" }), null);
assert.equal(readSwingTrend("EUR_USD", "W", { ...series, granularity: "M15" }), null);
assert.equal(readSwingTrend("GBP_USD", "W", series), null);
assert.equal(readSwingTrend("EUR_USD", "W", series), null, "no history cannot qualify a pair");
console.log("Weekly discovery passed: Weekly/Daily qualification, 4H priority, deterministic ties, no mutation and invalid-source rejection.");

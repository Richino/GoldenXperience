import { getCandles } from "../../frontend/src/lib/oanda/client.js";
import { INSTRUMENT_CATALOG } from "../../frontend/src/lib/instruments/catalog.js";
import { ANALYZE_V2 } from "../../frontend/src/lib/strategy/analyze-v2/config.js";
import { readTrend, type TrendDirection } from "../../frontend/src/lib/strategy/analyze-v2/structure.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";

/**
 * The 4H and daily structure read (the chart's trend label) for every pair, in
 * one shared snapshot. Structure moves as 4H bars close, so it is rebuilt at
 * most every 15 minutes. Pairs whose candles fell back to generated data are
 * left out rather than read on fake prices.
 */

const CACHE_MS = 15 * 60_000;
const CONCURRENCY = 6;

export type PairTrendRow = { instrument: string; h4: TrendDirection; d1: TrendDirection };
export type PairTrendsSnapshot = { checkedAt: string; pairs: PairTrendRow[] };

let cache: { expiresAt: number; result: Promise<PairTrendsSnapshot> } | null = null;

async function readDirection(instrument: string, granularity: "H4" | "D", label: string): Promise<TrendDirection | null> {
  const series = await getCandles(instrument as MajorInstrument, granularity, 250);
  if (series.status.state !== "connected" || series.data.source !== "oanda") return null;
  return readTrend(instrument, label, series.data.candles, ANALYZE_V2.SWING.regime).direction;
}

async function build(): Promise<PairTrendsSnapshot> {
  const queue = INSTRUMENT_CATALOG.map((item) => item.name);
  const pairs: PairTrendRow[] = [];
  const worker = async () => {
    for (let instrument = queue.shift(); instrument; instrument = queue.shift()) {
      try {
        const [h4, d1] = await Promise.all([readDirection(instrument, "H4", "4H"), readDirection(instrument, "D", "Daily")]);
        if (h4 && d1) pairs.push({ instrument, h4, d1 });
      } catch {
        // One pair failing leaves it out of the snapshot; the rest still read.
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  pairs.sort((a, b) => a.instrument.localeCompare(b.instrument));
  return { checkedAt: new Date().toISOString(), pairs };
}

export function pairTrends() {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.result;
  const result = build();
  cache = { expiresAt: now + CACHE_MS, result };
  result.then((value) => { if (!value.pairs.length) cache = null; }, () => { cache = null; });
  return result;
}

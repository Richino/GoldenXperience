import { apiUrl } from "@/lib/api/url";
import { createWatchlistDailyCache } from "@/lib/watchlist-daily-cache";
import type { CandleSeries } from "@/types/forex";

/**
 * Today's move, range and last 24 hourly closes per pair, from public candles.
 * One cache shared by Markets and the Chart page's watchlist, so a pair read on
 * one page is reused on the other (and across reloads, via sessionStorage).
 */
export const marketDailyCache = createWatchlistDailyCache(async (instrument) => {
  const readCandles = async (granularity: string, count: number) => {
    const response = await fetch(apiUrl(`/api/oanda/candles?instrument=${instrument}&granularity=${granularity}&count=${count}`), {
      credentials: "include", cache: "no-store",
    });
    if (!response.ok) throw new Error("Market candles are unavailable.");
    const payload = await response.json() as { data?: CandleSeries };
    if (!payload.data?.candles.length) throw new Error("Market candles are unavailable.");
    return payload.data.candles;
  };
  const [candles, hourly] = await Promise.all([
    readCandles("D", 2),
    readCandles("H1", 24).catch(() => null),
  ]);
  const current = candles.at(-1), previous = candles.at(-2);
  return {
    change: current && previous && previous.close > 0 ? ((current.close - previous.close) / previous.close) * 100 : null,
    high: current?.high ?? null,
    low: current?.low ?? null,
    close: current?.close ?? null,
    spark: hourly?.map(candle => candle.close) ?? null,
  };
}, { storage: () => window.sessionStorage });

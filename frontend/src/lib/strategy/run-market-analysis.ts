import { apiUrl } from "@/lib/api/url";
import { pipSizeFor } from "@/lib/instruments/catalog";
import type { EconomicCalendarSnapshot } from "@/lib/oanda/calendar";
import { analyzeMarket, type MarketAnalysis } from "@/lib/strategy/market-analysis";
import type { CandleSeries, MajorInstrument, PriceQuote } from "@/types/forex";

/**
 * Fetches what Analyze reads and runs both reads of one structure: Normal and
 * (when H4 is available) Swing. Read-only GETs; it never places anything.
 * Shared by the chart's Analyze and the Markets list.
 */
export async function runMarketAnalysis({
  instrument,
  signal,
  exposure = [],
}: {
  instrument: MajorInstrument;
  signal?: AbortSignal;
  /** Open trades and resting orders on every pair, for the same-currency warning. */
  exposure?: Array<{ instrument: string; direction: "long" | "short" }>;
}): Promise<{ normal: MarketAnalysis; swing: MarketAnalysis | null }> {
  // timeframe-roles.ts assigns the jobs: Normal is H4 context, H1
  // regime, M15 setup, M5 execution; Swing is D1, H4, H1, M15. Missing
  // context or execution only drops that line; swing needs H4.
  const higherTimeframe = (granularity: "M5" | "H1" | "H4" | "D", count = 250) => fetch(apiUrl(`/api/oanda/candles?instrument=${instrument}&granularity=${granularity}&count=${count}`), { credentials: "include", cache: "no-store", signal })
    .then(async (response) => response.ok ? (await response.json() as { data?: CandleSeries }).data : undefined)
    .then((series) => series?.source === "oanda" && series.granularity === granularity ? series.candles : undefined)
    .catch(() => undefined);
  // The calendar only adds the news warning; the plan is built without it.
  // Generated fallback events are ignored so they cannot raise a false alarm.
  const newsEvents = fetch(apiUrl("/api/oanda/calendar"), { credentials: "include", signal })
    .then(async (response) => response.ok ? (await response.json() as { data?: EconomicCalendarSnapshot }).data : undefined)
    .then((calendar) => calendar?.connected ? calendar.events : undefined)
    .catch(() => undefined);
  const [candlesResponse, pricingResponse, h1Candles, h4Candles, dailyCandles, m5Candles, calendarEvents] = await Promise.all([
    fetch(apiUrl(`/api/oanda/candles?instrument=${instrument}&granularity=M15&count=500`), { credentials: "include", cache: "no-store", signal }),
    fetch(apiUrl(`/api/oanda/pricing?instruments=${instrument}`), { credentials: "include", cache: "no-store", signal }).catch(() => null),
    higherTimeframe("H1", 500),
    higherTimeframe("H4", 500),
    higherTimeframe("D", 300),
    higherTimeframe("M5", 300),
    newsEvents,
  ]);
  if (!candlesResponse.ok) throw new Error("Completed M15 candles are unavailable.");
  const candlesPayload = await candlesResponse.json() as { data?: CandleSeries };
  const pricingPayload = pricingResponse?.ok ? await pricingResponse.json().catch(() => null) as { data?: PriceQuote[] } | null : null;
  if (!candlesPayload.data?.candles.length || candlesPayload.data.instrument !== instrument || candlesPayload.data.granularity !== "M15") {
    throw new Error("Completed M15 candles are unavailable.");
  }
  if (candlesPayload.data.source !== "oanda") throw new Error("Live OANDA M15 candles are unavailable; no trade plan was generated from demo data.");
  const quote = pricingPayload?.data?.find((item) => item.instrument === instrument);
  const quoteAgeMs = quote ? Date.now() - Date.parse(quote.time) : Number.POSITIVE_INFINITY;
  const currentPrice = quote?.source === "oanda" && Number.isFinite(quote.mid) && quote.mid > 0
    && Number.isFinite(quoteAgeMs) && quoteAgeMs >= -30_000 && quoteAgeMs <= 2 * 60_000 ? quote.mid : null;
  const spreadPips = currentPrice !== null && quote && quote.ask > quote.bid ? (quote.ask - quote.bid) / pipSizeFor(instrument) : null;
  const candles = { M5: m5Candles, M15: candlesPayload.data.candles, H1: h1Candles, H4: h4Candles, D1: dailyCandles };
  const normal = analyzeMarket({ instrument, mode: "NORMAL", candles, currentPrice, spreadPips, newsEvents: calendarEvents, exposure });
  const swing = h4Candles?.length
    ? analyzeMarket({ instrument, mode: "SWING", candles, currentPrice, spreadPips, newsEvents: calendarEvents, exposure })
    : null;
  return { normal, swing };
}

/**
 * Handoff from an accepted plan on another page to the chart's entry form.
 * The plan's frozen context is too large for a URL, so it rides in
 * sessionStorage and the chart is opened with `?plan=analyze`.
 */
export const ANALYZE_HANDOFF_KEY = "gx-analyze-handoff";

export type AnalyzeHandoff = {
  instrument: string;
  proposal: {
    direction: "long" | "short";
    entry: number;
    stop: number;
    target: number;
    confidence: null;
    rationale: string;
    preferredEntryTime: string;
    activateAt: string | null;
    analysisContext: Record<string, unknown>;
  };
};

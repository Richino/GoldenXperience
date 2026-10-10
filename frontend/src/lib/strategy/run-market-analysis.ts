import { apiUrl } from "@/lib/api/url";
import type { EconomicCalendarSnapshot } from "@/lib/oanda/calendar";
import { toMarketAnalysis } from "@/lib/strategy/analyze-v2/adapter";
import { analyzeV2 } from "@/lib/strategy/analyze-v2/decide";
import type { NewsItem } from "@/lib/strategy/analyze-v2/risk";
import type { MarketAnalysis } from "@/lib/strategy/market-analysis";
import type { CandleSeries, MajorInstrument, PriceQuote } from "@/types/forex";

/**
 * Fetches what Analyze reads and runs Analyze V2 (analyze-v2/) for both
 * modes: NORMAL on M15 with H1 context, SWING on H4 with D1. Read-only GETs;
 * it never places anything. Shared by the chart's Analyze and Markets.
 *
 * A calendar that cannot be read is passed on as null (news unknown), never
 * as "no news"; a missing or stale quote is passed on as is and V2 refuses
 * to price a trade from it.
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
  // With the live observer enabled, Analyze freezes a server-generated plan.
  // Older/disabled APIs retain the existing standalone read.
  const observerResponse = await fetch(apiUrl("/api/market-observer/analyze"), {
    method: "POST", credentials: "include", cache: "no-store", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instrument, mode: "NORMAL" }),
  });
  if (observerResponse.status !== 404) {
    const observer = await observerResponse.json() as { enabled?: boolean; error?: string; normal?: MarketAnalysis; swing?: MarketAnalysis };
    if (observerResponse.ok && observer.normal) return { normal: observer.normal, swing: observer.swing ?? null };
    if (observer.enabled !== false) throw new Error(observer.error || "The live analysis could not be saved.");
  }
  const candlesFor = (granularity: "M15" | "H1" | "H4" | "D", count: number) => fetch(apiUrl(`/api/oanda/candles?instrument=${instrument}&granularity=${granularity}&count=${count}`), { credentials: "include", cache: "no-store", signal })
    .then(async (response) => response.ok ? (await response.json() as { data?: CandleSeries }).data : undefined)
    // Demo/generated candles are never analyzed.
    .then((series) => series?.source === "oanda" && series.instrument === instrument && series.granularity === granularity ? series.candles : undefined)
    .catch(() => undefined);
  const newsEvents: Promise<NewsItem[] | null> = fetch(apiUrl("/api/oanda/calendar"), { credentials: "include", signal })
    .then(async (response) => response.ok ? (await response.json() as { data?: EconomicCalendarSnapshot }).data : undefined)
    .then((calendar) => calendar?.connected ? calendar.events : null)
    .catch(() => null);
  const [m15, h1, h4, daily, pricingResponse, news] = await Promise.all([
    candlesFor("M15", 300),
    candlesFor("H1", 300),
    candlesFor("H4", 300),
    candlesFor("D", 300),
    fetch(apiUrl(`/api/oanda/pricing?instruments=${instrument}`), { credentials: "include", cache: "no-store", signal }).catch(() => null),
    newsEvents,
  ]);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (!m15?.length) throw new Error("Live OANDA M15 candles are unavailable; no analysis was run.");
  const pricingPayload = pricingResponse?.ok ? await pricingResponse.json().catch(() => null) as { data?: PriceQuote[] } | null : null;
  const live = pricingPayload?.data?.find((item) => item.instrument === instrument && item.source === "oanda");
  const quote = live ? { bid: live.bid, ask: live.ask, time: live.time } : null;
  const now = Date.now();
  const candles = { M15: m15, H1: h1, H4: h4, D1: daily };
  const normal = toMarketAnalysis(analyzeV2({ instrument, mode: "NORMAL", candles, quote, now, news, exposure }));
  const swing = h4?.length ? toMarketAnalysis(analyzeV2({ instrument, mode: "SWING", candles, quote, now, news, exposure })) : null;
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

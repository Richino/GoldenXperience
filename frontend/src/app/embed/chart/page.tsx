import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignalWorkspace, type SignalPaperPlan } from "@/components/signals/signal-workspace";
import { getApiData } from "@/lib/api/server";
import {
  CHART_RANGES,
  CHART_TIMEFRAMES,
  CHART_VARIANTS,
  TIMEFRAME_TO_GRANULARITY,
  candleCountForRange,
  type ChartRange,
  type ChartTimeframe,
  type ChartVariant,
} from "@/lib/chart-utils";
import { isStrategyInstrument } from "@/lib/strategy/strategy-service";
import type { CandleSeries, ConnectionStatus, PaperChartTrade } from "@/types/forex";

export const metadata: Metadata = {
  title: "Chart",
};

function pick<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined;
}

/**
 * Native-only chart endpoint. It deliberately does not use the workspace
 * layout, so the WebView owns only the interactive chart canvas—not the GX
 * header, dock, search controls, or any other web page chrome.
 *
 * Built for first-paint speed: the native app passes its saved timeframe,
 * range and chart type so the server fetches the exact candles the chart will
 * show (no client refetch), the session check runs alongside the data reads,
 * and the multi-pair strategy evaluation is left to load after the chart is
 * on screen instead of blocking the HTML.
 */
export default async function EmbeddedChartPage({
  searchParams,
}: {
  searchParams: Promise<{ instrument?: string; tf?: string; range?: string; variant?: string }>;
}) {
  const params = await searchParams;
  const requested = params.instrument?.toUpperCase() ?? "EUR_USD";
  const instrument = isStrategyInstrument(requested) ? requested : "EUR_USD";
  const timeframe: ChartTimeframe = pick(params.tf?.toLowerCase(), CHART_TIMEFRAMES) ?? "15m";
  const range: ChartRange = pick(params.range, CHART_RANGES) ?? "1D";
  const variant: ChartVariant | undefined = pick(
    params.variant,
    CHART_VARIANTS.map((option) => option.value),
  );

  const [auth, candleResult, watchlist, paperTrades] = await Promise.allSettled([
    getApiData("/api/auth/me"),
    getApiData<{ data: CandleSeries; status: ConnectionStatus }>(
      `/api/oanda/candles?instrument=${instrument}&granularity=${TIMEFRAME_TO_GRANULARITY[timeframe]}&count=${candleCountForRange(timeframe, range)}`,
    ),
    getApiData<{ watchlist: SignalPaperPlan[] }>("/api/watchlist"),
    getApiData<{ trades: PaperChartTrade[] }>(`/api/paper-cycle/trades?instrument=${instrument}`),
  ]);

  if (auth.status === "rejected") {
    redirect("/login?next=/embed/chart");
  }
  if (candleResult.status === "rejected") throw candleResult.reason;

  return (
    <SignalWorkspace
      strategySetups={[]}
      initialInstrument={candleResult.value.data.instrument}
      primarySeries={candleResult.value.data}
      primarySeriesRange={range}
      initialTimeframe={timeframe}
      initialRange={range}
      initialVariant={variant}
      initialStatus={candleResult.value.status}
      paperPlans={watchlist.status === "fulfilled" ? watchlist.value.watchlist : []}
      initialPaperTrades={paperTrades.status === "fulfilled" ? paperTrades.value.trades : []}
      embeddedSurfaceOnly
    />
  );
}

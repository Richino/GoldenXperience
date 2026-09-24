import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignalWorkspace, type SignalPaperPlan } from "@/components/signals/signal-workspace";
import { getApiData } from "@/lib/api/server";
import type { StrategySnapshot } from "@/lib/strategy/strategy-service";
import { isStrategyInstrument } from "@/lib/strategy/strategy-service";
import type { CandleSeries, ConnectionStatus, PaperChartTrade } from "@/types/forex";

export const metadata: Metadata = {
  title: "Chart",
};

/**
 * Native-only chart endpoint. It deliberately does not use the workspace
 * layout, so the WebView owns only the interactive chart canvas—not the GX
 * header, dock, search controls, or any other web page chrome.
 */
export default async function EmbeddedChartPage({
  searchParams,
}: {
  searchParams: Promise<{ instrument?: string }>;
}) {
  try {
    await getApiData("/api/auth/me");
  } catch {
    redirect("/login?next=/embed/chart");
  }

  const params = await searchParams;
  const requested = params.instrument?.toUpperCase() ?? "EUR_USD";
  const instrument = isStrategyInstrument(requested) ? requested : "EUR_USD";
  const [snapshot, candleResult, watchlist, paperTrades] = await Promise.all([
    getApiData<StrategySnapshot>("/api/strategy"),
    getApiData<{ data: CandleSeries; status: ConnectionStatus }>(`/api/oanda/candles?instrument=${instrument}&granularity=M15&count=120`),
    getApiData<{ watchlist: SignalPaperPlan[] }>("/api/watchlist"),
    getApiData<{ trades: PaperChartTrade[] }>(`/api/paper-cycle/trades?instrument=${instrument}`),
  ]);

  return (
    <SignalWorkspace
      strategySetups={snapshot.strategy.setups}
      initialInstrument={candleResult.data.instrument}
      primarySeries={candleResult.data}
      initialStatus={candleResult.status}
      paperPlans={watchlist.watchlist}
      initialPaperTrades={paperTrades.trades}
      embeddedSurfaceOnly
    />
  );
}

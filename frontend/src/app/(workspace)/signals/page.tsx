import type { Metadata } from "next";
import { SignalWorkspace } from "@/components/signals/signal-workspace";
import { getApiData } from "@/lib/api/server";
import type { StrategySnapshot } from "@/lib/strategy/strategy-service";
import { isStrategyInstrument } from "@/lib/strategy/strategy-service";
import type { CandleSeries, ConnectionStatus, PaperChartTrade } from "@/types/forex";

export const metadata: Metadata = {
  title: "Signals",
};

export default async function SignalsPage({ searchParams }: { searchParams: Promise<{ instrument?: string; trade?: string }> }) {
  const params = await searchParams;
  const requested = params.instrument?.toUpperCase() ?? "EUR_USD";
  const instrument = isStrategyInstrument(requested) ? requested : "EUR_USD";
  const focusTradeId = params.trade && /^[0-9a-f-]{36}$/i.test(params.trade) ? params.trade : null;
  const [snapshot, candleResult, watchlist, paperTrades] = await Promise.all([
    getApiData<StrategySnapshot>("/api/strategy"),
    getApiData<{ data: CandleSeries; status: ConnectionStatus }>(`/api/oanda/candles?instrument=${instrument}&granularity=M15&count=120`),
    getApiData<{ watchlist: Array<{ instrument: string; openTradeId: string | null; direction: "long" | "short" | null; entry: number | null; stop: number | null; target: number | null; tradeSequence: string | null; batchNumber: number | null }> }>("/api/watchlist"),
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
      initialFocusTradeId={focusTradeId}
    />
  );
}

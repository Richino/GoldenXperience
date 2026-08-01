import type { Metadata } from "next";
import { SignalWorkspace } from "@/components/signals/signal-workspace";
import { getApiData } from "@/lib/api/server";
import type { StrategySnapshot } from "@/lib/strategy/strategy-service";
import { isStrategyInstrument } from "@/lib/strategy/strategy-service";
import type { CandleSeries, ConnectionStatus } from "@/types/forex";

export const metadata: Metadata = {
  title: "Signals",
};

export default async function SignalsPage({ searchParams }: { searchParams: Promise<{ instrument?: string }> }) {
  const requested = (await searchParams).instrument?.toUpperCase() ?? "EUR_USD";
  const instrument = isStrategyInstrument(requested) ? requested : "EUR_USD";
  const [snapshot, candleResult, watchlist] = await Promise.all([
    getApiData<StrategySnapshot>("/api/strategy"),
    getApiData<{ data: CandleSeries; status: ConnectionStatus }>(`/api/oanda/candles?instrument=${instrument}&granularity=M15&count=120`),
    getApiData<{ watchlist: Array<{ instrument: string; openTradeId: string | null; direction: "long" | "short" | null; entry: number | null; stop: number | null; target: number | null; tradeSequence: string | null; batchNumber: number | null }> }>("/api/watchlist"),
  ]);

  return (
    <SignalWorkspace
      strategySetups={snapshot.strategy.setups}
      initialInstrument={candleResult.data.instrument}
      primarySeries={candleResult.data}
      initialStatus={candleResult.status}
      paperPlans={watchlist.watchlist}
    />
  );
}

import type { Metadata } from "next";
import { SignalWorkspace } from "@/components/signals/signal-workspace";
import { getApiData } from "@/lib/api/server";
import type { StrategySnapshot } from "@/lib/strategy/strategy-service";
import type { CandleSeries, ConnectionStatus } from "@/types/forex";

export const metadata: Metadata = {
  title: "Signals",
};

export default async function SignalsPage() {
  const [snapshot, candleResult] = await Promise.all([
    getApiData<StrategySnapshot>("/api/strategy"),
    getApiData<{ data: CandleSeries; status: ConnectionStatus }>("/api/oanda/candles?instrument=EUR_USD&granularity=M15&count=120"),
  ]);

  return (
    <SignalWorkspace
      strategySetups={snapshot.strategy.setups}
      initialInstrument={candleResult.data.instrument}
      primarySeries={candleResult.data}
      initialStatus={candleResult.status}
    />
  );
}

import type { Metadata } from "next";
import { SignalWorkspace, type SignalPaperPlan } from "@/components/signals/signal-workspace";
import { getApiData } from "@/lib/api/server";
import type { StrategySnapshot } from "@/lib/strategy/strategy-service";
import { isStrategyInstrument } from "@/lib/strategy/strategy-service";
import type { CandleSeries, ConnectionStatus, PaperChartTrade } from "@/types/forex";
import type { BinaryPrediction } from "@/types/binary";

export const metadata: Metadata = {
  title: "Signals",
};

export default async function SignalsPage({ searchParams }: { searchParams: Promise<{ instrument?: string; trade?: string; prediction?: string }> }) {
  const params = await searchParams;
  const requested = params.instrument?.toUpperCase() ?? "EUR_USD";
  const instrument = isStrategyInstrument(requested) ? requested : "EUR_USD";
  const focusTradeId = params.trade && /^[0-9a-f-]{36}$/i.test(params.trade) ? params.trade : null;
  const focusPredictionId = params.prediction && /^[0-9a-f-]{36}$/i.test(params.prediction) ? params.prediction : null;
  const [snapshot, candleResult, watchlist, paperTrades] = await Promise.all([
    getApiData<StrategySnapshot>("/api/strategy"),
    getApiData<{ data: CandleSeries; status: ConnectionStatus }>(`/api/oanda/candles?instrument=${instrument}&granularity=M15&count=120`),
    getApiData<{ watchlist: SignalPaperPlan[] }>("/api/watchlist"),
    getApiData<{ trades: PaperChartTrade[] }>(`/api/paper-cycle/trades?instrument=${instrument}`),
  ]);
  const focusPrediction = focusPredictionId
    ? await getApiData<{ prediction?: BinaryPrediction }>(`/api/binary/prediction?id=${focusPredictionId}`).then(
        (payload) => payload.prediction ?? null,
      ).catch(() => null)
    : null;

  return (
    <SignalWorkspace
      strategySetups={snapshot.strategy.setups}
      initialInstrument={candleResult.data.instrument}
      primarySeries={candleResult.data}
      initialStatus={candleResult.status}
      paperPlans={watchlist.watchlist}
      initialPaperTrades={paperTrades.trades}
      initialFocusTradeId={focusTradeId}
      initialPredictionFocus={focusPrediction?.instrument === instrument ? focusPrediction : null}
    />
  );
}

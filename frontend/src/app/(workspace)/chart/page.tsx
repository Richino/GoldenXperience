import type { Metadata } from "next";
import { SignalWorkspace, type SignalPaperPlan } from "@/components/signals/signal-workspace";
import { getApiData } from "@/lib/api/server";
import type { StrategySnapshot } from "@/lib/strategy/strategy-service";
import { isStrategyInstrument } from "@/lib/strategy/strategy-service";
import type { CandleSeries, ConnectionStatus, PaperChartTrade } from "@/types/forex";
import type { BinaryPrediction } from "@/types/binary";

function finitePrice(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export const metadata: Metadata = {
  title: "Charts",
};

export default async function ChartPage({ searchParams }: { searchParams: Promise<{ instrument?: string; trade?: string; prediction?: string; entry?: string; stop?: string; target?: string }> }) {
  const params = await searchParams;
  // A plain chart launch should open an active paper trade first. Explicit
  // watchlist/chart links still win so a user can inspect another pair on
  // purpose.
  const activeTrade = params.instrument
    ? null
    : await getApiData<{ openTrades?: Array<{ id: string; instrument: string; status: string; closedAt: string | null }> }>("/api/paper-cycle")
      .then((payload) => payload.openTrades?.find((trade) => trade.status === "open" && trade.closedAt === null) ?? null)
      .catch(() => null);
  const requested = params.instrument?.toUpperCase() ?? activeTrade?.instrument ?? "EUR_USD";
  const instrument = isStrategyInstrument(requested) ? requested : "EUR_USD";
  const focusTradeId = params.trade && /^[0-9a-f-]{36}$/i.test(params.trade)
    ? params.trade
    : activeTrade?.id ?? null;
  const focusPredictionId = params.prediction && /^[0-9a-f-]{36}$/i.test(params.prediction) ? params.prediction : null;
  const entry = finitePrice(params.entry);
  const stop = finitePrice(params.stop);
  const target = finitePrice(params.target);
  const initialSetupFocus = entry !== null && stop !== null && target !== null && entry !== stop && entry !== target
    ? { entry, stop, target }
    : null;
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
      initialSetupFocus={initialSetupFocus}
    />
  );
}

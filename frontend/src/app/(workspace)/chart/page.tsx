import type { Metadata } from "next";
import { cookies } from "next/headers";
import { SignalWorkspace } from "@/components/signals/signal-workspace";
import { getApiData } from "@/lib/api/server";
import { isStrategyInstrument } from "@/lib/strategy/strategy-service";
import { TIMEFRAME_TO_GRANULARITY, candleCountForChartViewport, type ChartRange, type ChartTimeframe } from "@/lib/chart-utils";
import type { CandleSeries, ConnectionStatus, PaperChartTrade } from "@/types/forex";
import type { BinaryPrediction } from "@/types/binary";

function finitePrice(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export const metadata: Metadata = {
  title: "Charts",
};

export default async function ChartPage({ searchParams }: { searchParams: Promise<{ instrument?: string; trade?: string; prediction?: string; entry?: string; stop?: string; target?: string; direction?: string; confidence?: string; rationale?: string; preferredEntryTime?: string; proposal?: string; plan?: string }> }) {
  const params = await searchParams;
  const cookieStore = await cookies();
  const savedInstrument = cookieStore.get("gx-last-chart-instrument")?.value?.toUpperCase();
  const requestedInstrument = params.instrument?.toUpperCase();
  const savedInstrumentIsValid = savedInstrument !== undefined && isStrategyInstrument(savedInstrument);
  // Explicit links win, then the last chart the user chose. We only consult an
  // active paper trade when neither is available.
  const activeTrade = requestedInstrument || savedInstrumentIsValid
    ? null
    : await getApiData<{ openTrades?: Array<{ id: string; instrument: string; status: string; closedAt: string | null }> }>("/api/paper-cycle")
      .then((payload) => payload.openTrades?.find((trade) => trade.status === "open" && trade.closedAt === null) ?? null)
      .catch(() => null);
  const requested = requestedInstrument ?? (savedInstrumentIsValid ? savedInstrument : null) ?? activeTrade?.instrument ?? "EUR_USD";
  const instrument = isStrategyInstrument(requested) ? requested : "EUR_USD";
  // First paint is intentionally a compact, exact range. Strategy evaluation,
  // plans and trade markers are all hydrated client-side after the chart draws.
  const initialTimeframe: ChartTimeframe = "15m";
  const initialRange: ChartRange = "1D";
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
  const direction: "long" | "short" | null = params.direction === "long" || params.direction === "short" ? params.direction : null;
  const confidence = Number(params.confidence);
  const initialManualProposal = params.proposal === "manual-analysis" && initialSetupFocus && direction
    ? {
        ...initialSetupFocus,
        direction,
        confidence: Number.isFinite(confidence) && confidence >= 1 && confidence <= 100 ? Math.round(confidence) : null,
        rationale: params.rationale?.slice(0, 480) ?? "",
        preferredEntryTime: params.preferredEntryTime?.slice(0, 140) ?? "",
      }
    : null;
  // A focused trade must be present on the first render. Previously this page
  // always handed the workspace an empty trade list, so a direct journal/chart
  // link painted the default Trade action before client hydration replaced it
  // with Close Trade.
  const [candleResult, paperTrades] = await Promise.all([
    getApiData<{ data: CandleSeries; status: ConnectionStatus }>(
      `/api/oanda/candles?instrument=${instrument}&granularity=${TIMEFRAME_TO_GRANULARITY[initialTimeframe]}&count=${candleCountForChartViewport(initialTimeframe, initialRange)}`,
    ),
    getApiData<{ trades: PaperChartTrade[] }>(
      `/api/paper-cycle/trades?instrument=${instrument}${focusTradeId ? `&trade=${focusTradeId}` : ""}`,
    ).catch(() => ({ trades: [] })),
  ]);
  const focusPrediction = focusPredictionId
    ? await getApiData<{ prediction?: BinaryPrediction }>(`/api/binary/prediction?id=${focusPredictionId}`).then(
        (payload) => payload.prediction ?? null,
      ).catch(() => null)
    : null;

  return (
    <SignalWorkspace
      strategySetups={[]}
      initialInstrument={candleResult.data.instrument}
      primarySeries={candleResult.data}
      primarySeriesRange={initialRange}
      initialTimeframe={initialTimeframe}
      initialRange={initialRange}
      initialStatus={candleResult.status}
      paperPlans={[]}
      initialPaperTrades={paperTrades.trades}
      initialFocusTradeId={focusTradeId}
      initialPredictionFocus={focusPrediction?.instrument === instrument ? focusPrediction : null}
      initialSetupFocus={initialSetupFocus}
      initialManualProposal={initialManualProposal}
      initialPlanHandoff={params.plan === "analyze"}
    />
  );
}
